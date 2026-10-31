import { toDisplayKey } from "@xos/data/gateway-keys";
import type { Browser, Page } from "@playwright/test";
import { expect as baseExpect, test } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import {
  asPerson,
  offerToApplication,
  PEOPLE,
  PROJECT,
  publishStaffOpportunity,
  requirements,
  ROLE_ACCOUNTS,
  ROLE_PEOPLE,
  suffix,
} from "./role-fixtures";
import { expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * Journey 42 (Section 20.2; R12, RRR-190), staffing agency, with no fixture for the staff engagement or its shifts.
 * The agency submits a slate of named staff in Gateway and wins the award; the production makes the one Staff
 * engagement from the application in Atlas's Pipeline, which seeds a Draft roster entry for each slate member who
 * confirmed their membership. Each staff member accepts their entry on Home, the agency submits the roster, the
 * production accepts the entries and activates the engagement in Atlas. A briefing is due before anyone's first shift:
 * the production allocates two agency slots in Atlas and publishes each from its peek, the agency's lead
 * is refused placing Staff One until they acknowledge it in Gateway and the production verifies it in Atlas, then
 * places Staff One and Two. Staff One accepts the shift, clocks in and out (the Compass punch's server half, as
 * Staff One), submits the timesheet in Gateway, and the production approves it. Step 8's variant: the lead clocks
 * Staff Two in and out from Compass (app.record_supervisor_punches, as the lead), and the production approves a
 * timesheet that shows who clocked it.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(420_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const ZONE = "America/New_York";
/** Inside the demo project's Pier Site geofence (seed 0109): the project requires it on phone punches. */
const PIER = [25.7752, -80.1855, 10] as const;

/** A datetime-local value in the project's zone, as Atlas's shift editor takes it. */
function local(at: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .replace(" ", "T");
}

/** The project's local date, which timesheets and pay count days in. */
function projectDay(): string {
  return local(new Date()).slice(0, 10);
}

async function value<T>(text: string, params: unknown[]): Promise<T | undefined> {
  const [row] = await sql<{ v: T }>(text, params);
  return row?.v;
}

/** A Gateway page signed in as `email`, in its own browser context. */
async function gatewayAs(browser: Browser, email: string, next: string): Promise<Page> {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await signIn(page, email, next);
  return page;
}

test("journey 42: slate, award, roster, training before positions, slots, placement, time and approval", async ({
  page,
  browser,
}) => {
  const briefing = `Gate safety briefing ${suffix()}`;
  let rules: { retire: () => Promise<void> } | null = null;
  let engagementId: string | null = null;
  try {
    const opportunity = await publishStaffOpportunity();
    const party = (await value<string>("select name as v from app.organizations where id = $1", [
      ROLE_ACCOUNTS.agency,
    ])) as string;
    const lead = (await value<string>("select full_name as v from app.people where id = $1", [
      ROLE_PEOPLE.agency,
    ])) as string;

    // 1. The agency, acting as its company, puts two named staff forward and accepts the award.
    await signIn(page, "agency@example.com", "/home");
    await page
      .context()
      .addCookies([{ name: "xos-acting", value: ROLE_ACCOUNTS.agency, url: page.url() }]);
    await page.goto(`/explore/${opportunity.key}`);
    const form = page.getByRole("form", { name: `Apply for ${opportunity.title}` });
    await expect(form.getByText("Your slate")).toBeVisible();
    await expectAccessible(page);
    await form.getByLabel("I am available for these dates").check();
    await form.getByRole("button", { name: "Send application" }).click();
    await expect(form.getByText("Pick at least one team member for the slate.")).toBeVisible();
    await form.getByLabel("Demo Staff One").check();
    await form.getByLabel("Demo Staff Two").check();
    await form.getByRole("button", { name: "Send application" }).click();
    await expect(page.getByText(/You applied on|Application sent/).first()).toBeVisible();
    const { applicationId } = await offerToApplication(opportunity.id);
    await page.goto("/work/applications?view=list");
    const card = page.getByRole("listitem").filter({ hasText: opportunity.title });
    await page.waitForLoadState("networkidle");
    await card.getByRole("button", { name: "Accept offer" }).click();
    await expect
      .poll(() =>
        value<string>("select application_state::text as v from app.applications where id = $1", [
          applicationId,
        ]),
      )
      .toBe("Accepted");

    // The production makes the one Staff engagement from the application in Atlas's Pipeline; it seeds a Draft entry
    // for each slate member.
    const atlas = await atlasAs(browser, "owner@example.com");
    await atlas.page.goto(`/${ORG}/opportunities/pipeline?id=${applicationId}`);
    await atlas.page.waitForLoadState("networkidle");
    await atlas.page.getByLabel("Worker classification").selectOption("INDEPENDENT_CONTRACTOR");
    await atlas.page.getByRole("button", { name: "Create engagement", exact: true }).click();
    await expect(
      atlas.page.getByText("Engagement created. Its onboarding packet is ready."),
    ).toBeVisible();
    await expect
      .poll(async () => {
        engagementId =
          (await value<string>(
            "select id as v from app.engagements where application_id = $1 and deleted_at is null",
            [applicationId],
          )) ?? null;
        return engagementId;
      })
      .not.toBeNull();
    if (!engagementId) throw new Error("The Pipeline made no engagement from the application.");
    const key = toDisplayKey("engagement", engagementId);
    const entries = await sql<{ id: string; person_id: string; entry_state: string }>(
      `select id, person_id, entry_state::text as entry_state from app.engagement_roster_entries
        where engagement_id = $1 and deleted_at is null and not is_self order by person_id`,
      [engagementId],
    );
    expect(entries.map((e) => [e.person_id, e.entry_state])).toEqual([
      [ROLE_PEOPLE.staffOne, "Draft"],
      [ROLE_PEOPLE.staffTwo, "Draft"],
    ]);
    const entryOne = entries[0]?.id as string;
    const entryTwo = entries[1]?.id as string;

    // 2. Each staff member accepts their entry on Home, and the agency submits the roster.
    const one = await gatewayAs(browser, "staff.one@example.com", "/home");
    const two = await gatewayAs(browser, "staff.two@example.com", "/home");
    for (const staff of [one, two]) {
      const rostered = staff
        .getByRole("listitem")
        .filter({ hasText: `${party} put you on their crew` });
      await staff.waitForLoadState("networkidle");
      await rostered.getByRole("button", { name: "Accept" }).click();
    }
    await expect
      .poll(() =>
        value<number>(
          `select count(*)::int as v from app.engagement_roster_entries
            where engagement_id = $1 and person_response = 'Accepted' and not is_self and deleted_at is null`,
          [engagementId],
        ),
      )
      .toBe(2);
    await page.goto(`/work/engagements/${key}/crew`);
    await page.getByRole("button", { name: "Submit roster (2 entries)" }).click();
    await expect
      .poll(() =>
        value<number>(
          `select count(*)::int as v from app.engagement_roster_entries
            where engagement_id = $1 and entry_state = 'Submitted' and deleted_at is null`,
          [engagementId],
        ),
      )
      .toBe(2);

    // 3. The production accepts both entries in Atlas. The Owner made the engagement, so the seeded entries name
    // them as creator and the Admin reviews them (sod_roster_reviewer).
    const admin = await atlasAs(browser, "admin@example.com");
    await admin.page.goto(`/${ORG}/p/NWS/advancing?section=crew`);
    for (const name of ["Demo Staff One", "Demo Staff Two"]) {
      const entry = admin.page
        .getByRole("region", { name: party })
        .getByRole("listitem")
        .filter({ hasText: name });
      await entry.getByRole("button", { name: "Accept" }).click();
      await expect(entry).toContainText("Accepted");
    }
    await admin.context.close();

    // The production activates the engagement from its record in Atlas.
    await atlas.page.goto(`/${ORG}/opportunities/engagements?id=${engagementId}`);
    const moveTo = atlas.page.getByRole("form", { name: "Move to" });
    await moveTo.getByLabel("Next state").selectOption("Active");
    await moveTo.getByLabel("Reason").fill("Roster accepted.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect
      .poll(() =>
        value<string>("select engagement_state::text as v from app.engagements where id = $1", [
          engagementId,
        ]),
      )
      .toBe("Active");

    // A briefing is now due on every Staff roster entry before its first shift.
    rules = await requirements("Staff", [{ name: briefing, kind: "Acknowledgment" }]);

    // 6. The production allocates two agency slots in Atlas Crew, covering the next hours, and publishes each from its
    // peek.
    const startsAt = local(new Date(Date.now() - 60 * 60_000));
    const endsAt = local(new Date(Date.now() + 6 * 60 * 60_000));
    for (let i = 0; i < 2; i += 1) {
      await atlas.page.goto(`/${ORG}/p/NWS/crew?create=1`);
      const drawer = atlas.page.getByRole("dialog", { name: "New shift" });
      await expect(drawer).toBeVisible();
      await drawer.getByLabel("Person").selectOption(`agency:${engagementId}`);
      await drawer.getByLabel(/^Starts/).fill(startsAt);
      await drawer.getByLabel(/^Ends/).fill(endsAt);
      await drawer.getByRole("button", { name: "New shift" }).click();
      await expect(drawer).toBeHidden();
    }
    await expectAccessible(atlas.page);
    const slots = await sql<{ id: string }>(
      `select id from app.shifts where engagement_id = $1 and deleted_at is null order by created_at`,
      [engagementId],
    );
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      await atlas.page.goto(`/${ORG}/p/NWS/crew?peek=${slot.id}`);
      await atlas.page.waitForLoadState("networkidle");
      await atlas.page
        .getByRole("dialog")
        .first()
        .getByRole("button", { name: "Publish", exact: true })
        .click();
      const confirmPublish = atlas.page
        .getByRole("dialog")
        .filter({ has: atlas.page.getByRole("button", { name: "Cancel", exact: true }) });
      await confirmPublish.getByRole("button", { name: "Publish", exact: true }).click();
      await expect
        .poll(() =>
          value<string>("select shift_state::text as v from app.shifts where id = $1", [slot.id]),
        )
        .toBe("Published");
    }

    // 4. Staff One holds no shift yet, and the lead is refused placing them while the briefing is due.
    await one.goto(`/work/engagements/${key}/shifts`);
    await expect(
      one.getByText("No shifts yet. Published shifts appear here for you to accept."),
    ).toBeVisible();
    await page.goto(`/work/engagements/${key}/positions`);
    const assignForms = page.getByRole("form", { name: "Assign someone from your roster" });
    await expect(assignForms).toHaveCount(2);
    await expectAccessibleInBothThemes(page);
    await assignForms.first().getByLabel("Person").selectOption(entryOne);
    await assignForms.first().getByRole("button", { name: "Assign" }).click();
    await expect(
      page.getByText(
        "This person has training to acknowledge, or the production still has to verify it.",
      ),
    ).toBeVisible();

    // 5. Each acknowledges the briefing in Gateway; the production verifies it in Atlas.
    for (const staff of [one, two]) {
      await staff.goto(`/work/engagements/${key}/training`);
      const item = staff.getByRole("listitem").filter({ hasText: briefing });
      await expect(item).toContainText("To do");
      await staff.waitForLoadState("networkidle");
      await item.getByRole("button", { name: "I have read and acknowledge this" }).click();
      await expect(item).toContainText("Waiting for verification");
    }
    await expectAccessibleInBothThemes(one);
    for (const entry of [entryOne, entryTwo]) {
      await atlas.page.goto(`/${ORG}/p/NWS/advancing?section=crew&peek=${entry}`);
      const training = atlas.page.getByRole("region", { name: "Training" });
      await expect(training).toContainText(briefing);
      await training.getByRole("button", { name: "Record verification" }).click();
      const confirmDialog = atlas.page
        .getByRole("dialog")
        .filter({ has: atlas.page.getByRole("button", { name: "Cancel", exact: true }) });
      await confirmDialog.getByRole("button", { name: "Passed", exact: true }).click();
      await expect(training).toContainText("Passed");
    }

    // 7. The lead places Staff One and Staff Two, one on each slot.
    await page.goto(`/work/engagements/${key}/positions`);
    for (const entry of [entryOne, entryTwo]) {
      const free = page.getByRole("form", { name: "Assign someone from your roster" }).first();
      await free.getByLabel("Person").selectOption(entry);
      await free.getByRole("button", { name: "Assign" }).click();
      await expect
        .poll(() =>
          value<number>(
            "select count(*)::int as v from app.shifts where roster_entry_id = $1 and deleted_at is null",
            [entry],
          ),
        )
        .toBe(1);
      await page.reload();
    }
    await expect(page.getByText("Demo Staff One").first()).toBeVisible();
    await expect(page.getByText("Demo Staff Two").first()).toBeVisible();
    const shiftOf = async (entry: string) =>
      (await value<string>(
        "select id as v from app.shifts where roster_entry_id = $1 and deleted_at is null",
        [entry],
      )) as string;
    const shiftOne = await shiftOf(entryOne);
    const shiftTwo = await shiftOf(entryTwo);

    // 8. Staff One accepts the shift, clocks in and out, and submits the timesheet; the production approves it.
    await one.goto(`/work/engagements/${key}/shifts`);
    await one.waitForLoadState("networkidle");
    await one.getByRole("button", { name: "Accept shift" }).first().click();
    await expect
      .poll(() =>
        value<string>("select shift_state::text as v from app.shifts where id = $1", [shiftOne]),
      )
      .toBe("Accepted");
    for (const kind of ["In", "Out"] as const) {
      await asPerson(
        ROLE_PEOPLE.staffOne,
        `select app.record_punch(gen_random_uuid(), $1, $2::app.punch_kind, now(), 0, $3, $4, $5, $6, null,
           'Mobile', null, null, null, null)`,
        [PROJECT, kind, shiftOne, ...PIER],
      );
    }
    const sheetFor = async (entry: string) => {
      const [row] = await sql<{ id: string }>(
        `insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
         values ($1, $2, $3::date, $3::date) returning id`,
        [PROJECT, entry, projectDay()],
        PEOPLE.owner,
      );
      return row?.id as string;
    };
    const sheetOne = await sheetFor(entryOne);
    await one.goto(`/work/engagements/${key}/timesheets`);
    await one.waitForLoadState("networkidle");
    await one.getByRole("button", { name: "Submit", exact: true }).first().click();
    await expect
      .poll(() =>
        value<string>("select timesheet_state::text as v from app.timesheets where id = $1", [
          sheetOne,
        ]),
      )
      .toBe("Submitted");
    await expectAccessible(one);

    /** Approves a timesheet from its Atlas peek, after checking it shows `clockedBy` when given. */
    const approve = async (sheet: string, clockedBy: string | null) => {
      await atlas.page.goto(`/${ORG}/crew/timesheets?peek=${sheet}`);
      const detail = atlas.page.getByRole("dialog").first();
      if (clockedBy) await expect(detail).toContainText(clockedBy);
      await detail.getByRole("button", { name: "Approve", exact: true }).click();
      const confirmDialog = atlas.page
        .getByRole("dialog")
        .filter({ has: atlas.page.getByRole("button", { name: "Cancel", exact: true }) });
      await confirmDialog.getByRole("button", { name: "Approve", exact: true }).click();
      await expect
        .poll(() =>
          value<string>("select timesheet_state::text as v from app.timesheets where id = $1", [
            sheet,
          ]),
        )
        .toBe("Approved");
    };
    await approve(sheetOne, null);

    // Step 8's variant: the lead clocks Staff Two in and out from Compass as their supervisor, and the production
    // approves the timesheet, which shows who clocked it.
    for (const [kind, ago] of [
      ["In", "20 minutes"],
      ["Out", "0 minutes"],
    ] as const) {
      const [answer] = await asPerson<{ outcome: string }>(
        ROLE_PEOPLE.agency,
        `select app.record_supervisor_punches(gen_random_uuid(), $1, $2::app.punch_kind, now() - $3::interval,
           jsonb_build_array(jsonb_build_object('punch_id', gen_random_uuid(), 'shift_id', $4::uuid)),
           null, $5, $6, $7, null) -> 'results' -> 0 ->> 'outcome' as outcome`,
        [PROJECT, kind, ago, shiftTwo, ...PIER],
      );
      expect(answer?.outcome).toBe("applied");
    }
    const sheetTwo = await sheetFor(entryTwo);
    await asPerson(ROLE_PEOPLE.staffTwo, "select app.submit_timesheet($1)", [sheetTwo]);
    await approve(sheetTwo, `Clocked by ${lead}`);
    await expectAccessible(atlas.page);
    await atlas.context.close();
    await one.context().close();
    await two.context().close();
  } finally {
    await rules?.retire();
    if (engagementId) {
      // The demo project's crew stays as the seed left it for later journeys.
      for (const statement of [
        `update app.shifts set deleted_at = now() where deleted_at is null and (engagement_id = $1
           or roster_entry_id in (select id from app.engagement_roster_entries where engagement_id = $1))`,
        "update app.engagement_roster_entries set deleted_at = now() where engagement_id = $1 and deleted_at is null",
        "update app.engagements set deleted_at = now() where id = $1",
      ]) {
        await sql(statement, [engagementId]).catch(() => undefined);
      }
    }
  }
});
