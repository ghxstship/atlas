import {
  expect as baseExpect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import pg from "pg";
import { pdfText } from "../test/fixtures/pdf";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * R7 (RRR-187, ADR 0103 and 0104, parity G-91, G-93 and G-174): allocations in Atlas, on staffing engagements of the
 * agency of seed 1080 (Account Owner agency@example.com, accepted member Demo Staff One):
 *   - Radios for a party pool: the Producer requests 6 for the pool and cannot approve the request; the Owner sees
 *     what is available for the dates in Review and approves it with 4 from class stock and 2 from a rental order
 *     line; splits 2 to Demo Staff One on channels 1 and 3; issues both radios in the check-out dialog against the
 *     share's hold (Partly issued, then Issued); prints the radio hand-out, which lists the person, the tags and the
 *     channels; and checks both in (Returned).
 *   - A parking pass issued with the person's vehicle, revoked when the engagement completes.
 *   - The BEO's roster counts: the headcount, and a dietary need shared by fewer than 5 people suppressed.
 *   - With allowance overflow at review, a request beyond the radio cap is approved with a reason, and Remaining
 *     allowance reads 0.
 *   - One radio assigned straight to the person and issued by tag, withdrawn when the engagement is canceled.
 * Each test makes a project of its own (so its offerings, caps, channels and settings stay its own), its own
 * engagement and its own units, through SQL as postgres on the local stack only, under a person's claims where an
 * RPC needs one, and removes them afterwards. The org's Radios class is shared, so availability is checked against
 * app.asset_class_availability for the same window rather than against fixed numbers.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(420_000);
const expect = baseExpect.configure({ timeout: 30_000 });

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const OWNER = "01920000-0000-7000-8000-000000000101";
const AGENCY = {
  owner: "01920000-0000-7000-8000-000010800101",
  staffOne: "01920000-0000-7000-8000-000010800102",
  account: "01920000-0000-7000-8000-000010800301",
} as const;

/** One statement as postgres against the local stack only, under `person`'s claims when given. */
async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
  person?: string,
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("The allocations journey changes data only on a local Supabase stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    if (person) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: person, role: "authenticated" }),
      ]);
    }
    const result = await client.query(text, args);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

interface Project {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}

/** A project of this run: R and four random capitals (projects_key_format), in New York time. */
async function newProject(name: string): Promise<Project> {
  const key = `R${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
  const [row] = await localSql<{ id: string; name: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone)
     values ($1, $2, $3, 'America/New_York') returning id, name`,
    [DEMO_ORG_ID, key, `${name} ${key}`],
    OWNER,
  );
  return { id: row?.id as string, key, label: `${key} · ${row?.name ?? ""}` };
}

/** Sets an offering or another setting on the project, as the Owner. */
async function setOnProject(project: Project, key: string, value: string): Promise<void> {
  await localSql(
    "select app.set_setting($1, $2, 'Project', $3, $4)",
    [DEMO_ORG_ID, key, project.id, value],
    OWNER,
  );
}

/** The org's Radios class (one per org), its name and canon element. */
async function radioClass(): Promise<{ id: string; name: string; element: string }> {
  // Two statements: a class the call creates is not in the snapshot of the statement that makes it.
  const [ensured] = await localSql<{ id: string }>(
    "select app.ensure_offering_asset_class($1, 'Radios') as id",
    [DEMO_ORG_ID],
    OWNER,
  );
  const [row] = await localSql<{ id: string; name: string; element: string }>(
    "select c.id, c.name, c.element_id as element from app.asset_classes c where c.id = $1",
    [ensured?.id],
  );
  if (!row) throw new Error("The demo org has no Radios class.");
  return row;
}

/** One Available radio with a fresh tag at the org's first venue. */
async function availableRadio(classId: string, tag: string): Promise<void> {
  await localSql(
    `with u as (
       insert into app.asset_units (asset_class_id, asset_tag, home_venue_id)
       values ($1, $2, (select v.id from app.venues v where v.org_id = $3 and v.deleted_at is null order by v.created_at limit 1))
       returning id)
     select private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
              'asset_unit_id', u.id, 'Proposed', 'Received', 'R7 journey.'),
            private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
              'asset_unit_id', u.id, 'Received', 'Available', 'R7 journey.')
       from u`,
    [classId, tag, DEMO_ORG_ID],
  );
}

/** An Active staffing engagement of the agency on the project, with Demo Staff One accepted on its roster. */
async function crewedEngagement(project: Project): Promise<{ engagement: string; entry: string }> {
  const [row] = await localSql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date)
     values ($1, $2,
       (select c.id from app.counterparties c where c.org_id = $3 and c.organization_id = $4 and c.deleted_at is null limit 1),
       'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 30000, 'USD', '2027-08-03', '2027-08-08')
     returning id`,
    [project.id, AGENCY.owner, DEMO_ORG_ID, AGENCY.account],
    OWNER,
  );
  const engagement = row?.id as string;
  const [entry] = await localSql<{ id: string }>(
    "select app.add_roster_entry($1, $2) as id",
    [engagement, AGENCY.staffOne],
    AGENCY.owner,
  );
  await localSql("select app.submit_roster($1)", [engagement], AGENCY.owner);
  await localSql("select app.review_roster_entry($1, 'Accepted')", [entry?.id], OWNER);
  await localSql("select app.respond_roster_entry($1, 'Accepted')", [entry?.id], AGENCY.staffOne);
  await localSql(
    "select app.transition_engagement($1, 'Onboarding', 'Active', 'R7 journey.')",
    [engagement],
    OWNER,
  );
  return { engagement, entry: entry?.id as string };
}

/** Demo Staff One's name and the agency's name, as the dialogs and rows show them. */
async function names(): Promise<{ one: string; party: string }> {
  const [row] = await localSql<{ one: string; party: string }>(
    `select (select full_name from app.people where id = $1) as one,
            (select name from app.organizations where id = $2) as party`,
    [AGENCY.staffOne, AGENCY.account],
  );
  return { one: row?.one ?? "", party: row?.party ?? "" };
}

/**
 * Removes what a test made: its engagements are canceled first, so the cascades withdraw the allocations and release
 * their holds; then its units, order, settings, rules, engagements and the project are soft-deleted. Best effort, so
 * one refusal never hides the test's own failure.
 */
async function removeProject(project: Project, tags: readonly string[] = []): Promise<void> {
  const statements: [string, unknown[], string?][] = [
    [
      `select app.transition_engagement(e.id, e.engagement_state, 'Canceled', 'R7 journey cleanup.')
         from app.engagements e
        where e.project_id = $1 and e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active')`,
      [project.id],
      OWNER,
    ],
    [
      "update app.asset_units set deleted_at = now() where asset_tag = any ($1) and deleted_at is null",
      [[...tags]],
    ],
    [
      `update app.po_lines set deleted_at = now()
        where purchase_order_id in (select id from app.purchase_orders where project_id = $1) and deleted_at is null`,
      [project.id],
    ],
    [
      "update app.purchase_orders set deleted_at = now() where project_id = $1 and deleted_at is null",
      [project.id],
    ],
    [
      "update app.offering_rules set deleted_at = now() where project_id = $1 and deleted_at is null",
      [project.id],
    ],
    [
      "update app.setting_values set deleted_at = now() where scope_kind = 'Project' and scope_id = $1 and deleted_at is null",
      [project.id],
    ],
    [
      `update app.engagement_roster_entries set deleted_at = now()
        where engagement_id in (select id from app.engagements where project_id = $1) and deleted_at is null`,
      [project.id],
    ],
    [
      "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
      [project.id],
    ],
    [
      "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
      [project.id],
    ],
  ];
  for (const [text, args, person] of statements) {
    try {
      await localSql(text, args, person);
    } catch (error) {
      console.warn(`R7 journey cleanup: ${String(error)}`);
    }
  }
}

/** A signed-in page in a context of its own. */
async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signInAs(page, email, DEMO_ORG);
  return page;
}

/** The allocations page of a project. */
function allocationsPath(project: Project, extra = ""): string {
  return `/${DEMO_ORG}/advancing/allocations?project=${project.key}${extra}`;
}

/** The list row of an allocation by its holder text and item. */
function allocationRow(page: Page, holder: string, item: string): Locator {
  return page.getByRole("listitem").filter({ hasText: holder }).filter({ hasText: item });
}

/** Fills the Assign dialog's holder, kind, item, quantity and window. */
async function fillAssign(
  dialog: Locator,
  input: { holder: string; kind: string; item: string; quantity: number; from: string; to: string },
): Promise<void> {
  await dialog.getByLabel("Held by").selectOption({ value: input.holder });
  await dialog.getByLabel("Kind").selectOption({ value: input.kind });
  await dialog.getByLabel("Item").selectOption({ value: input.item });
  await dialog.getByLabel("Quantity").fill(String(input.quantity));
  await dialog.getByLabel("Needed from").fill(input.from);
  await dialog.getByLabel("Needed until").fill(input.to);
}

/** Looks a code up on the custody desk. The field is controlled, so it waits for hydration first. */
async function lookUp(page: Page, code: string): Promise<void> {
  await page.goto(`/${DEMO_ORG}/assets/custody-ledger`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Asset tag, serial or lot label").fill(code);
  await page.getByRole("button", { name: "Look up" }).click();
}

const FROM = "2027-08-04T08:00";
const TO = "2027-08-06T20:00";
const FROM_UTC = "2027-08-04T12:00:00Z";
const TO_UTC = "2027-08-07T00:00:00Z";

test("radios for a party pool: request, review from stock and an order line, split with channels, issue at check-out, hand-out and return", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  // Four radios of this run in stock; two of them go out to the person.
  const tags = [1, 2, 3, 4].map((n) => `R7${id.slice(-6)}${n}`.toUpperCase());
  const issued = tags.slice(0, 2);
  const { one, party } = await names();
  const radios = await radioClass();
  const project = await newProject("R7 Radios");
  try {
    await setOnProject(project, "offerings.radios", "provided");
    for (const tag of tags) await availableRadio(radios.id, tag);
    await localSql(
      `insert into app.radio_channels (project_id, channel_number, name)
       select $1, n, name from (values (1, 'Production'), (2, 'Audio'), (3, 'Stage')) c (n, name)`,
      [project.id],
      OWNER,
    );
    // A rental order for two radios over August, still Proposed: its line holds what it will supply.
    const [line] = await localSql<{ id: string }>(
      `with po as (
         insert into app.purchase_orders (project_id, vendor_id, currency_code)
         values ($1, (select v.id from app.vendors v where v.org_id = $2 and v.deleted_at is null
                       and v.vendor_state = 'Active' order by v.created_at limit 1), 'USD')
         returning id)
       insert into app.po_lines (purchase_order_id, line_number, description, element_id, quantity, unit_price_minor,
         acquisition_kind, hire_period)
       select po.id, 1, 'Two-way radios on hire.', $3, 2, 5000, 'Rental', '[2027-08-01 00:00+00,2027-09-01 00:00+00)'
         from po
       returning id`,
      [project.id, DEMO_ORG_ID, radios.element],
      OWNER,
    );
    const { engagement, entry } = await crewedEngagement(project);

    // The Producer requests 6 radios for the agency's pool, and cannot approve the request.
    const producer = await asPerson(browser, "producer@example.com");
    await producer.goto(allocationsPath(project));
    await expect(producer.getByRole("heading", { level: 1, name: "Allocations" })).toBeVisible();
    await producer.getByRole("button", { name: "Assign", exact: true }).click();
    const request = producer.getByRole("dialog", { name: "Assign an allocation" });
    await fillAssign(request, {
      holder: `pool:${engagement}`,
      kind: "asset",
      item: `asset:${radios.id}`,
      quantity: 6,
      from: FROM,
      to: TO,
    });
    await request.getByRole("button", { name: "Request instead" }).click();
    await expect(request).toBeHidden();
    const pool = allocationRow(producer, `${party} pool`, radios.name);
    await expect(pool).toContainText("Requested");
    await pool.getByRole("button", { name: "Review" }).click();
    const own = producer.getByRole("dialog", { name: `Review ${radios.name}` });
    await own.getByRole("button", { name: "Approve" }).click();
    await expect(own).toContainText(
      "You requested or assigned this allocation, so someone else must approve or decline it.",
    );
    await own.getByRole("button", { name: "Cancel" }).click();
    await producer.context().close();

    // The Owner reviews it: Review shows what is free for the dates, and the hold takes 4 from class stock and 2
    // from the order line.
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(allocationsPath(project));
    const [before] = await localSql<{ available: string; total: string }>(
      "select available::text, total::text from app.asset_class_availability($1, $2, $3)",
      [radios.id, FROM_UTC, TO_UTC],
      OWNER,
    );
    const review = allocationRow(page, `${party} pool`, radios.name);
    await review.getByRole("button", { name: "Review" }).click();
    const decide = page.getByRole("dialog", { name: `Review ${radios.name}` });
    await expect(decide).toContainText(
      `Available ${Number(before?.available).toLocaleString("en-US")} of ${Number(before?.total).toLocaleString("en-US")}`,
    );
    await decide.getByLabel("Quantity", { exact: true }).first().fill("4");
    await decide.getByRole("button", { name: "Add a source" }).click();
    await decide.getByLabel("Source", { exact: true }).nth(1).selectOption({ value: "Order Line" });
    await decide.getByLabel("Unit, lot or order line").fill(line?.id as string);
    await decide.getByLabel("Quantity", { exact: true }).nth(1).fill("2");
    await expect(decide).toContainText("Sources hold 6 of 6.");
    await expectAccessible(page);
    await decide.getByRole("button", { name: "Approve" }).click();
    await expect(decide).toBeHidden();
    // The order behind two of the radios is still Proposed.
    await expect(allocationRow(page, `${party} pool`, radios.name)).toContainText("Awaiting order");
    const holds = await localSql<{ source: string; quantity: string }>(
      `select case when r.po_line_id is not null then 'line' else 'stock' end as source, sum(r.quantity)::text as quantity
         from app.asset_reservations r join app.advance_allocations a on a.id = r.advance_allocation_id
        where a.engagement_id = $1 and r.released_at is null and r.deleted_at is null
        group by 1 order by 1`,
      [engagement],
    );
    expect(holds).toEqual([
      { source: "line", quantity: "2" },
      { source: "stock", quantity: "4" },
    ]);
    const [after] = await localSql<{ available: string }>(
      "select available::text from app.asset_class_availability($1, $2, $3)",
      [radios.id, FROM_UTC, TO_UTC],
      OWNER,
    );
    expect(Number(after?.available)).toBe(Math.max(Number(before?.available) - 6, 0));

    // Split 2 to Demo Staff One, programmed on channels 1 and 3.
    await allocationRow(page, `${party} pool`, radios.name)
      .getByRole("button", { name: "Split" })
      .click();
    const split = page.getByRole("dialog", { name: `Split ${radios.name}` });
    await split.getByLabel("Person").selectOption({ value: entry });
    await split.getByLabel("Quantity").fill("2");
    await split.getByLabel("1 · Production").check();
    await split.getByLabel("3 · Stage").check();
    await split.getByRole("button", { name: "Split", exact: true }).click();
    await expect(split).toBeHidden();
    const share = allocationRow(page, one, radios.name);
    await expect(share).toContainText("Reserved");
    await expect(share).toContainText("Ch 1, 3");

    // Issue both radios in the check-out dialog against the share's hold: Partly issued, then Issued.
    for (const [i, tag] of issued.entries()) {
      await lookUp(page, tag);
      await expect(page.getByText("It is Available now.")).toBeVisible();
      await page.getByRole("button", { name: "Check out" }).click();
      const out = page.getByRole("dialog", { name: `Check out ${tag}` });
      await out.getByLabel("Project").selectOption({ value: project.id });
      await out.getByLabel("Held by").selectOption({ value: `e:${engagement}` });
      await out
        .getByLabel("Allocation")
        .selectOption({ label: `${one} · ${radios.name} (${i}/2)` });
      await out.getByRole("button", { name: "Check out" }).click();
      await expect(out).toBeHidden();
      await page.goto(allocationsPath(project));
      await expect(allocationRow(page, one, radios.name)).toContainText(
        i === 0 ? "Partly issued" : "Issued",
      );
    }
    const custody = await localSql<{ entry: string | null; reservation: string | null }>(
      `select distinct on (u.id) c.roster_entry_id as entry, c.reservation_id::text as reservation
         from app.asset_custody c join app.asset_units u on u.id = c.asset_unit_id
        where u.asset_tag = any ($1) and c.deleted_at is null
        order by u.id, c.created_at desc`,
      [issued],
    );
    expect(custody).toHaveLength(2);
    for (const c of custody) {
      expect(c.entry).toBe(entry);
      expect(c.reservation).not.toBeNull();
    }

    // The radio hand-out lists the person, the tags issued and the channels.
    const link = page.getByRole("link", { name: "Print radio hand-out" });
    await expect(link).toHaveAttribute(
      "href",
      `/${DEMO_ORG}/documents/radio-handout/${project.id}`,
    );
    const handout = await page.request.get(`/${DEMO_ORG}/documents/radio-handout/${project.id}`);
    expect(handout.status()).toBe(200);
    expect(handout.headers()["content-type"]).toBe("application/pdf");
    expect(handout.headers()["content-disposition"]).toContain(
      `radio-handout-${project.key}-RADIOS`,
    );
    const text = pdfText(new Uint8Array(await handout.body()));
    expect(text).toContain(one);
    for (const tag of issued) expect(text).toContain(tag);
    expect(text).toContain("1 Production");
    expect(text).toContain("3 Stage");

    // Both come back to their home venue: Returned.
    for (const tag of issued) {
      await lookUp(page, tag);
      await expect(page.getByText("It is Deployed now.")).toBeVisible();
      await page.getByRole("button", { name: "Check in" }).click();
      const back = page.getByRole("dialog", { name: `Check in ${tag}` });
      await back.getByRole("button", { name: "Check in" }).click();
      await expect(back).toBeHidden();
    }
    await page.goto(allocationsPath(project));
    await expect(allocationRow(page, one, radios.name)).toContainText("Returned");
    await expectAccessible(page);
  } finally {
    await removeProject(project, tags);
  }
});

test("a parking pass issued with the person's vehicle is revoked when the engagement completes", async ({
  page,
}) => {
  const id = uniqueId();
  const { one } = await names();
  const project = await newProject("R7 Parking");
  try {
    await setOnProject(project, "offerings.parking", "provided");
    const code = `P${id}`
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12);
    const [category] = await localSql<{ id: string; name: string }>(
      `insert into app.credential_categories (project_id, code, name, category_kind)
       values ($1, $2, 'Crew Parking', 'Parking') returning id, name`,
      [project.id, code],
      OWNER,
    );
    const { engagement, entry } = await crewedEngagement(project);
    const plate = `R7${id}`
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 10);
    const [vehicle] = await localSql<{ id: string }>(
      "select app.save_roster_vehicle($1, 'Ford', 'Transit', 'White', $2, 'US-FL') as id",
      [entry, plate],
      AGENCY.staffOne,
    );

    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(allocationsPath(project));
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "Assign an allocation" });
    await fillAssign(assign, {
      holder: `entry:${entry}`,
      kind: "parking_pass",
      item: `credential:${category?.id}`,
      quantity: 1,
      from: FROM,
      to: TO,
    });
    await assign.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(assign).toBeHidden();
    const row = allocationRow(page, one, category?.name ?? "");
    await expect(row).toContainText("Approved");

    // Issue it: the dialog offers the vehicle on the person's roster entry (R5's logged read).
    await row.getByRole("button", { name: "Issue" }).click();
    const issue = page.getByRole("dialog", { name: `Issue ${category?.name}` });
    const label = `Ford Transit · ${plate} (US-FL)`;
    await expect(issue.locator("option", { hasText: label })).toBeAttached();
    await issue.getByLabel("Vehicle").selectOption({ value: vehicle?.id as string });
    await expectAccessible(page);
    await issue.getByRole("button", { name: "Issue", exact: true }).click();
    await expect(issue).toBeHidden();
    await expect(allocationRow(page, one, category?.name ?? "")).toContainText("Issued");
    const [pass] = await localSql<{ credential: string; vehicle: string | null }>(
      `select c.id as credential, v.roster_vehicle_id as vehicle
         from app.credentials c
         join app.advance_allocations a on a.id = c.allocation_id
         left join app.credential_vehicles v on v.credential_id = c.id and v.deleted_at is null
        where a.roster_entry_id = $1 and c.deleted_at is null`,
      [entry],
    );
    expect(pass?.vehicle).toBe(vehicle?.id);

    // Completing the engagement revokes the pass and withdraws the allocation.
    await localSql(
      "select app.transition_engagement($1, 'Active', 'Closing', 'Show over.')",
      [engagement],
      OWNER,
    );
    await localSql(
      "select app.transition_engagement($1, 'Closing', 'Complete', 'Show over.')",
      [engagement],
      OWNER,
    );
    const [revoked] = await localSql<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from app.credentials where id = $1",
      [pass?.credential],
    );
    expect(revoked?.revoked).toBe(true);
    await page.goto(allocationsPath(project, "&filter=Withdrawn"));
    await expect(allocationRow(page, one, category?.name ?? "")).toContainText("Withdrawn");
  } finally {
    await removeProject(project);
  }
});

test("the BEO shows roster counts, with a need shared by fewer than 5 suppressed", async ({
  page,
}) => {
  const id = uniqueId();
  const { one } = await names();
  const project = await newProject("R7 Catering");
  // Demo Staff One's dietary needs, put back afterwards.
  await localSql("select app.ensure_my_work_details()", [], AGENCY.staffOne);
  const [saved] = await localSql<{ needs: string[] }>(
    "select dietary_needs::text[] as needs from app.person_work_details where person_id = $1 and deleted_at is null",
    [AGENCY.staffOne],
  );
  try {
    await setOnProject(project, "offerings.catering", "provided");
    const title = `Crew Lunch ${id}`;
    const [fulfillment] = await localSql<{ id: string }>(
      "insert into app.fulfillments (project_id, fulfillment_kind, title) values ($1, 'Catering', $2) returning id",
      [project.id, title],
      OWNER,
    );
    const [inserted] = await localSql<{ id: string }>(
      `insert into app.beos (project_id, fulfillment_id, event_at, guest_count)
       values ($1, $2, '2027-08-05 16:00+00', 40) returning id`,
      [project.id, fulfillment?.id],
      OWNER,
    );
    const [beo] = await localSql<{ key: string }>(
      "select app.beo_display_key(b) as key from app.beos b where b.id = $1",
      [inserted?.id],
    );
    const { engagement, entry } = await crewedEngagement(project);
    await localSql(
      "update app.person_work_details set dietary_needs = '{Vegetarian}' where person_id = $1 and deleted_at is null",
      [AGENCY.staffOne],
    );
    await localSql(
      "select app.share_work_details($1, '{Dietary Needs}')",
      [engagement],
      AGENCY.staffOne,
    );

    // Allocate the catering to Demo Staff One and issue it: one line for the person.
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(allocationsPath(project));
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "Assign an allocation" });
    await fillAssign(assign, {
      holder: `entry:${entry}`,
      kind: "catering",
      item: `catering:${fulfillment?.id}`,
      quantity: 1,
      from: FROM,
      to: TO,
    });
    await assign.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(assign).toBeHidden();
    await allocationRow(page, one, title).getByRole("button", { name: "Issue" }).click();
    const issue = page.getByRole("dialog", { name: `Issue ${title}` });
    await issue.getByLabel("Description").fill("Crew lunch, day one.");
    await issue.getByRole("button", { name: "Issue", exact: true }).click();
    await expect(issue).toBeHidden();
    await expect(allocationRow(page, one, title)).toContainText("Issued");

    // The BEO reads the counts on request: a headcount of 1, and Vegetarian, shared by one person, suppressed.
    // Each read is logged in the person's access log.
    const counted = async () =>
      (
        await localSql<{ n: number }>(
          `select count(*)::int as n from app.work_detail_events
            where person_id = $1 and action = 'dietary_needs.counted' and roster_entry_id = $2`,
          [AGENCY.staffOne, entry],
        )
      )[0]?.n ?? 0;
    expect(await counted()).toBe(0);
    await page.goto(`/${DEMO_ORG}/hospitality/beos?peek=${beo?.key}`);
    const record = page.getByRole("dialog", { name: `BEO for ${title}` });
    await record.getByRole("button", { name: "Show roster counts" }).click();
    await expect(record.getByText("Headcount", { exact: true })).toBeVisible();
    // The counts are their own list inside the record's properties.
    const counts = record.locator("dl", { hasText: "Headcount" }).last();
    await expect(counts).toContainText("Headcount1");
    await expect(counts).toContainText("VegetarianFewer than 5");
    await expect(record).toContainText("The guest count above stays your own figure.");
    await expect.poll(counted).toBe(1);
    await expectAccessible(page);
  } finally {
    await localSql(
      "update app.person_work_details set dietary_needs = $2::app.dietary_need[] where person_id = $1 and deleted_at is null",
      [AGENCY.staffOne, saved?.needs ?? []],
    );
    await removeProject(project);
  }
});

test("with allowance overflow at review, a request beyond the radio cap is approved with a reason", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const tags = [1, 2].map((n) => `R7W${id.slice(-6)}${n}`.toUpperCase());
  const { one } = await names();
  const radios = await radioClass();
  const project = await newProject("R7 Allowance");
  try {
    await setOnProject(project, "offerings.radios", "provided");
    for (const tag of tags) await availableRadio(radios.id, tag);
    await setOnProject(project, "advancing.allowance_overflow", "review");
    // One radio per person on this project.
    await localSql(
      `insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_person)
       values ($1, $2, 'Radios', 'Provided', 1)`,
      [DEMO_ORG_ID, project.id],
      OWNER,
    );
    const { entry } = await crewedEngagement(project);

    // The Producer asks for 2: the dialog says what is left and by how much the request goes beyond it.
    const producer = await asPerson(browser, "producer@example.com");
    await producer.goto(allocationsPath(project));
    await producer.getByRole("button", { name: "Assign", exact: true }).click();
    const request = producer.getByRole("dialog", { name: "Assign an allocation" });
    await fillAssign(request, {
      holder: `entry:${entry}`,
      kind: "asset",
      item: `asset:${radios.id}`,
      quantity: 2,
      from: FROM,
      to: TO,
    });
    await expect(request).toContainText("Remaining allowance 1 of 1");
    await expect(request).toContainText("Beyond allowance by 1");
    await request.getByRole("button", { name: "Request instead" }).click();
    await expect(request).toBeHidden();
    await expect(allocationRow(producer, one, radios.name)).toContainText("Requested");
    await producer.context().close();

    // The Owner approves it beyond the cap, which needs a reason; nothing of the allowance is left.
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(allocationsPath(project));
    await allocationRow(page, one, radios.name).getByRole("button", { name: "Review" }).click();
    const decide = page.getByRole("dialog", { name: `Review ${radios.name}` });
    await expect(decide).toContainText("Remaining allowance 0 of 1");
    await expect(decide).toContainText("Beyond allowance by 1");
    await decide
      .getByLabel("Reason")
      .fill("Two radios for the stage manager's back-to-back shifts.");
    await decide.getByRole("button", { name: "Approve" }).click();
    await expect(decide).toBeHidden();
    await expect(allocationRow(page, one, radios.name)).toContainText("Reserved");
    const [ledger] = await localSql<{ reason: string }>(
      `select t.reason from app.advance_allocation_state_transitions t
         join app.advance_allocations a on a.id = t.advance_allocation_id
        where a.roster_entry_id = $1 and t.to_state = 'Approved'`,
      [entry],
    );
    expect(ledger?.reason).toBe("Two radios for the stage manager's back-to-back shifts.");

    // The table's Allowance column reads the same.
    await page.goto(allocationsPath(project, "&view=table"));
    await expect(page.getByRole("row").filter({ hasText: one })).toContainText("0 of 1 left");
  } finally {
    await removeProject(project, tags);
  }
});

test("a radio assigned to a person, issued by tag, is withdrawn when the engagement is canceled", async ({
  page,
}) => {
  const id = uniqueId();
  const tag = `R7A${id.slice(-6)}`.toUpperCase();
  const { one } = await names();
  const radios = await radioClass();
  const project = await newProject("R7 Assign");
  try {
    await setOnProject(project, "offerings.radios", "provided");
    await availableRadio(radios.id, tag);
    const { engagement, entry } = await crewedEngagement(project);
    await signInAs(page, "owner@example.com", DEMO_ORG);
    await page.goto(allocationsPath(project));
    await expect(page.getByRole("heading", { level: 1, name: "Allocations" })).toBeVisible();
    await expectAccessible(page);

    // The Owner may assign, so it is Approved and held at once.
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "Assign an allocation" });
    await fillAssign(assign, {
      holder: `entry:${entry}`,
      kind: "asset",
      item: `asset:${radios.id}`,
      quantity: 1,
      from: FROM,
      to: TO,
    });
    await expectAccessible(page);
    await assign.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(assign).toBeHidden();
    const row = allocationRow(page, one, radios.name);
    await expect(row).toContainText("Reserved");

    // Issue by tag from the row: the custody row names the entry and the hold.
    await row.getByRole("button", { name: "Issue" }).click();
    const issue = page.getByRole("dialog", { name: `Issue ${radios.name}` });
    await issue.getByLabel("Asset tags").fill(tag);
    await issue.getByRole("button", { name: "Issue", exact: true }).click();
    await expect(issue).toBeHidden();
    await expect(row).toContainText("Issued");
    const [custody] = await localSql<{ entry: string | null; reservation: string | null }>(
      `select c.roster_entry_id as entry, c.reservation_id::text as reservation
         from app.asset_custody c join app.asset_units u on u.id = c.asset_unit_id
        where u.asset_tag = $1 and c.deleted_at is null
        order by c.created_at desc limit 1`,
      [tag],
    );
    expect(custody?.entry).toBe(entry);
    expect(custody?.reservation).not.toBeNull();

    // Canceling the engagement withdraws it; the default list hides it, the Withdrawn filter shows it.
    await localSql(
      "select app.transition_engagement($1, 'Active', 'Canceled', 'R7 journey cancel.')",
      [engagement],
      OWNER,
    );
    await page.goto(allocationsPath(project));
    await expect(allocationRow(page, one, radios.name)).toHaveCount(0);
    await page.goto(allocationsPath(project, "&filter=Withdrawn"));
    await expect(allocationRow(page, one, radios.name)).toContainText("Withdrawn");
  } finally {
    await removeProject(project, [tag]);
  }
});
