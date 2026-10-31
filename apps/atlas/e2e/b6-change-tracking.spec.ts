import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "@xos/data";
import { isActionableApproval, listInbox } from "@xos/data/inbox";
import { expect as baseExpect, test, type Page } from "./engine-test";
import { ORG, signIn } from "./a16-support";
import { expectAccessible, todayIn, uniqueId } from "./support";

/**
 * B6 (RRR-230, ADR 0145) on the demo tenant, what changed since a person last looked or was last told:
 *   - Needs review (G-120): the Owner publishes a shift for the Demo Field Lead and changes its role in the peek;
 *     Crew > Shifts with Review set to Needs review shows it with "1 change since told", the peek says the lead was
 *     told by notification and the history shows the role before and after, and Mark as communicated takes it off
 *     the filter;
 *   - Home > Today (G-249): the lead marks all as seen, the Owner renames a record assigned to them, and on reload
 *     Since your last visit names the change and who made it; the doors tile counts down to an Event record's
 *     doors, the approvals tile counts what the Inbox can decide, and a resized tile keeps its span;
 *   - Show > Show day (G-179): the fixture project's day shows its sets, run of show, arrivals and hotels, and a cue
 *     renamed in another session shows without a reload.
 * Fixtures are written as the signed-in people who would write them (Supabase Auth on the local stack), never as
 * raw SQL, and taken away afterwards.
 */

const expect = baseExpect.configure({ timeout: 30_000 });
test.use({ reducedMotion: "reduce" });

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_PROJECT = "01920000-0000-7000-8000-000000001001";
const FIELD_LEAD = "01920000-0000-7000-8000-000000000104";
const DEMO_CREW = "01920000-0000-7000-8000-000000000201";
const DEMO_ARTIST = "01920000-0000-7000-8000-000010800105";
const PROJECT_ZONE = "America/New_York";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

function stack(): { url: string; anon: string } {
  const url = process.env["E2E_SUPABASE_URL"];
  const anon = process.env["E2E_SUPABASE_ANON_KEY"];
  if (!url || !anon || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY to the local stack.");
  }
  return { url, anon };
}

/** A demo person's own session, writing as Atlas would on their behalf. */
async function as(email: string): Promise<SupabaseClient> {
  const { url, anon } = stack();
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
  expect(error).toBeNull();
  return client;
}

const app = (client: SupabaseClient) => client.schema("app");

async function one<T>(
  promise: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await promise;
  expect(error).toBeNull();
  return data as T;
}

const cleanup: (() => PromiseLike<unknown>)[] = [];
test.afterEach(async () => {
  for (const step of cleanup.splice(0).reverse())
    await Promise.resolve(step()).catch(() => undefined);
});

async function fieldLeadMembership(owner: SupabaseClient): Promise<string> {
  const row = await one<{ id: string }>(
    app(owner)
      .from("memberships")
      .select("id")
      .eq("org_id", DEMO_ORG_ID)
      .eq("person_id", FIELD_LEAD)
      .is("deleted_at", null)
      .limit(1)
      .single(),
  );
  return row.id;
}

/** The Monday-based week a shift falls in, as the Crew pages' week navigation names it. */
function weekParam(iso: string): string {
  return todayIn(PROJECT_ZONE, new Date(iso));
}

test("a role change after the notification needs review until it is marked as communicated", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await as("owner@example.com");
  const membership = await fieldLeadMembership(owner);
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  startsAt.setUTCHours(13, 0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + 8 * 3_600_000);
  const shift = await one<{ id: string }>(
    app(owner)
      .from("shifts")
      .insert({
        project_id: DEMO_PROJECT,
        membership_id: membership,
        role_code: "0000.50.01",
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        time_zone: PROJECT_ZONE,
      })
      .select("id")
      .single(),
  );
  cleanup.push(() =>
    app(owner).from("shifts").update({ deleted_at: new Date().toISOString() }).eq("id", shift.id),
  );
  await one(
    app(owner).rpc("publish_shifts", { p_shift_ids: [shift.id], p_reason: "Published for B6." }),
  );

  await signIn(page, "owner@example.com");
  const base = `/${ORG}/crew/shifts?view=table&week=${weekParam(startsAt.toISOString())}`;
  // Change the role in the peek's edit drawer.
  await page.goto(`${base}&edit=${shift.id}`);
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("Role", { exact: true }).selectOption({ index: 2 });
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer).toBeHidden();

  await page.goto(`${base}&review=needs`);
  const row = page.getByRole("row").filter({ hasText: "1 change since told" });
  await expect(row).toHaveCount(1);
  await page.goto(`${base}&review=needs&peek=${shift.id}`);
  const peek = page.getByRole("dialog");
  await expect(peek.getByTestId("shift-told-line")).toHaveText(/^Told by notification on /);
  await expect(peek.getByText("Changed since then: Role")).toBeVisible();
  // The record's history shows the role before and after.
  await expect(peek.getByText("0000.50.01").first()).toBeVisible();
  await expectAccessible(page);

  await peek.getByRole("button", { name: "Mark as communicated" }).click();
  const confirm = page.getByRole("dialog", { name: "Mark as communicated" });
  await confirm.getByRole("button", { name: "Mark as communicated" }).click();
  await expect(peek.getByTestId("shift-told-line")).toHaveText(
    /^Marked as communicated by Demo Owner on /,
  );
  await page.goto(`${base}&review=needs`);
  await expect(page.getByRole("row").filter({ hasText: "1 change since told" })).toHaveCount(0);
});

const span = (page: Page, tile: string) =>
  page.locator(`[data-template='dashboard'] [data-tile='${tile}']`).getAttribute("data-span");

test("Today counts down to doors, counts approvals and names what changed since the last visit", async ({
  page,
}, info) => {
  test.skip(info.project.name.startsWith("phone"), "below md the grid is one column");
  test.setTimeout(240_000);
  const id = uniqueId();
  const owner = await as("owner@example.com");
  const membership = await fieldLeadMembership(owner);
  const task = await one<{ id: string }>(
    app(owner)
      .from("records")
      .insert({
        project_id: DEMO_PROJECT,
        record_kind: "Task",
        title: `Hang the banners ${id}`,
        xyz: "Y",
        xyz_basis: "Declared",
      })
      .select("id")
      .single(),
  );
  await one(
    app(owner)
      .from("record_assignments")
      .insert({ record_id: task.id, membership_id: membership })
      .select("id"),
  );
  // An Event whose doors open in 90 minutes, sooner than any seeded event.
  const event = await one<{ id: string }>(
    app(owner)
      .from("records")
      .insert({
        project_id: DEMO_PROJECT,
        record_kind: "Event",
        title: `Doors Test Night ${id}`,
        xyz: "Y",
        xyz_basis: "Declared",
      })
      .select("id")
      .single(),
  );
  await one(
    app(owner)
      .from("record_event")
      .insert({ record_id: event.id, doors_at: new Date(Date.now() + 90 * 60_000).toISOString() })
      .select("record_id"),
  );
  cleanup.push(() =>
    app(owner)
      .from("records")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", [task.id, event.id]),
  );

  await signIn(page, "field@example.com");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/${ORG}/home/today`);
  await expect(page.locator("main [data-template]")).toHaveCount(1);
  await expect(page.locator("main [data-template='dashboard']")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Since your last visit" })).toBeVisible();
  await page.getByRole("button", { name: "Mark all as seen" }).click();
  await expect(page.getByText(/^Since your last visit on /)).toBeVisible();

  // The Owner renames the lead's record after that.
  const renamed = `Hang the side banners ${id}`;
  await one(app(owner).from("records").update({ title: renamed }).eq("id", task.id).select("id"));
  await page.reload();
  const changes = page.getByRole("region", { name: "Since your last visit" });
  await expect(changes.getByRole("link", { name: new RegExp(renamed) })).toBeVisible();
  await expect(changes.getByText(/Demo Owner changed Title/)).toBeVisible();

  // Doors in 1 h 29 min (or 30, by the time the page renders).
  const doors = page.getByRole("region", { name: "Doors" });
  await expect(doors.getByText(/^Doors in 1 h (29|30) min$/)).toBeVisible();
  await expect(doors.getByText(`Doors Test Night ${id}`)).toBeVisible();

  // The approvals tile counts what the lead's Inbox can decide.
  const lead = await as("field@example.com");
  const inbox = await listInbox(lead as unknown as XosClient, DEMO_ORG_ID);
  expect(inbox.ok).toBe(true);
  const actionable = inbox.ok ? inbox.data.filter(isActionableApproval).length : -1;
  const approvals = page.getByRole("region", { name: "Waiting for your approval" });
  if (actionable === 0) {
    await expect(approvals.getByText("Nothing is waiting for your approval.")).toBeVisible();
  } else {
    await expect(approvals.getByTestId("today-approvals-count")).toHaveText(
      `${actionable} ${actionable === 1 ? "approval" : "approvals"} waiting`,
    );
  }
  await expectAccessible(page);

  // A resized tile keeps its span.
  expect(await span(page, "doors")).toBe("4");
  const handle = page.getByRole("separator", { name: "Resize Doors" });
  await handle.focus();
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && (r.request().postData() ?? "").includes('"doors":5'),
  );
  await page.keyboard.press("ArrowRight");
  await saved;
  await page.reload();
  expect(await span(page, "doors")).toBe("5");
  const reset = page.getByRole("button", { name: "Reset layout" });
  await reset.click();
  await expect(reset).toBeHidden();
});

test("Show day shows the day's sets, running orders, arrivals and hotels, live", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const id = uniqueId();
  const owner = await as("owner@example.com");
  const day = todayIn(PROJECT_ZONE);
  const run = await one<{ id: string }>(
    app(owner)
      .from("run_of_show")
      .insert({ project_id: DEMO_PROJECT, name: `Main Stage ${id}`, show_date: day })
      .select("id")
      .single(),
  );
  cleanup.push(() =>
    app(owner)
      .from("run_of_show")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", run.id),
  );
  const evening = (hours: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + hours * 3_600_000).toISOString();
  const cues = await one<{ id: string; label: string }[]>(
    app(owner)
      .from("cues")
      .insert([
        { run_of_show_id: run.id, position: 1, label: `Doors ${id}`, planned_at: evening(23) },
        {
          run_of_show_id: run.id,
          position: 2,
          label: `Headline Set ${id}`,
          planned_at: evening(25),
          duration: "01:15:00",
        },
      ])
      .select("id, label"),
  );
  const set = cues.find((c) => c.label.startsWith("Headline")) as { id: string };
  const artist = await one<{ id: string }>(
    app(owner)
      .from("engagements")
      .insert({
        project_id: DEMO_PROJECT,
        person_id: DEMO_ARTIST,
        role_type: "Artist",
        role_code: "2000.50.02",
        worker_classification: "INDEPENDENT_CONTRACTOR",
        pay_basis: "Day Rate",
        arrangement: "Per Engagement",
        currency_code: "USD",
        start_date: day,
        end_date: day,
      })
      .select("id")
      .single(),
  );
  await one(
    app(owner)
      .from("engagement_cues")
      .insert({ engagement_id: artist.id, cue_id: set.id })
      .select("id"),
  );
  const trip = await one<{ id: string }>(
    app(owner)
      .from("travel_segments")
      .insert({
        project_id: DEMO_PROJECT,
        person_id: DEMO_CREW,
        travel_mode: "Flight",
        operator_name: "Coastal Air",
        service_identifier: `CA ${id.slice(-3)}`,
        confirmation_identifier: "QX7PLM",
        departs_from: "LAX",
        departs_at: evening(14),
        departs_time_zone: "America/Los_Angeles",
        arrives_at_place: "MIA",
        arrives_at: evening(20),
        arrives_time_zone: PROJECT_ZONE,
        price_minor: 45000,
        currency_code: "USD",
      })
      .select("id")
      .single(),
  );
  cleanup.push(() =>
    app(owner)
      .from("travel_segments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", trip.id),
  );
  const plus = (days: number) =>
    new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const block = await one<{ id: string }>(
    app(owner)
      .from("accommodation_blocks")
      .insert({
        project_id: DEMO_PROJECT,
        title: `Show Day Block ${id}`,
        check_in_on: plus(-1),
        check_out_on: plus(3),
        rooms_held: 4,
      })
      .select("id")
      .single(),
  );
  cleanup.push(() =>
    app(owner)
      .from("accommodation_blocks")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", block.id),
  );
  await one(
    app(owner)
      .from("accommodation_assignments")
      .insert({
        accommodation_block_id: block.id,
        person_id: DEMO_CREW,
        check_in_on: day,
        check_out_on: plus(2),
      })
      .select("id"),
  );

  await signIn(page, "owner@example.com");
  await page.goto(`/${ORG}/show/show-day?project=NWS&day=${day}`);
  await expect(page.locator("main [data-template]")).toHaveCount(1);
  const sets = page.getByRole("region", { name: "Sets by stage" });
  await expect(sets.getByText(`Headline Set ${id}`)).toBeVisible();
  await expect(sets.getByText("Up next")).toBeVisible();
  const runs = page.getByRole("region", { name: "Run of show" });
  await expect(runs.getByText(`Main Stage ${id}`)).toBeVisible();
  await expect(runs.getByText(/0 of 2 cues called/)).toBeVisible();
  const arrivals = page.getByRole("region", { name: "Arrivals" });
  await expect(arrivals.getByText("Demo Crew Member").first()).toBeVisible();
  await expect(arrivals.getByText("QX7PLM")).toHaveCount(0);
  const hotels = page.getByRole("region", { name: "Hotels" });
  await expect(hotels.getByText(new RegExp(`Show Day Block ${id}`))).toBeVisible();
  await expect(hotels.getByText(/Checking in: .*Demo Crew Member/)).toBeVisible();
  await expectAccessible(page);

  // A cue renamed in another session shows without a reload.
  await page.evaluate(() => {
    (window as unknown as { b6Loaded?: boolean }).b6Loaded = true;
  });
  const other = await (await browser.newContext()).newPage();
  await signIn(other, "admin@example.com");
  const admin = await as("admin@example.com");
  await one(
    app(admin)
      .from("cues")
      .update({ label: `Headliner Set ${id}` })
      .eq("id", set.id)
      .select("id"),
  );
  await expect(sets.getByText(`Headliner Set ${id}`)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { b6Loaded?: boolean }).b6Loaded)).toBe(
    true,
  );
  await other.context().close();
});
