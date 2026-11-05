import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect as baseExpect, test, type Page } from "./engine-test";
import { asPerson, newSignIn, offer, PEOPLE, suffix, transition } from "./role-fixtures";
import { DEMO, signIn, sql } from "./support";

/**
 * R8 (RRR-188, owner decisions 6, 7 and 8; ADR 0100 roster-member): a vendor company asks for radios for its crew and
 * shares them out from Gateway, and a person on its roster sees only their own.
 *   - The vendor's Account Admin requests 6 radios for the pool through the Request an item form (six fields).
 *   - The producing org approves the pool (as Atlas does, through app.decide_allocation).
 *   - The Admin selects two people on the Crew tab and assigns 1 radio each from the bulk bar, after a preview; Cmd or
 *     Ctrl+Z gives the shares back and Shift+Cmd or Ctrl+Z assigns them again.
 *   - A rostered Account Member signs in and sees exactly the Roster Member tabs, an Up Next card with the pending
 *     radio and their parking pass, and no colleague's rows; once a radio is issued to them, it reads Issued under
 *     Assigned to you.
 * The run makes its own project, company, people and gear, and removes them afterwards.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 20_000 });

function projectKey(): string {
  const letters = Array.from({ length: 4 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join("");
  return `R${letters}`;
}

/** The rows of api_external.advance_allocations a person reads on a roster entry, signed in under RLS. */
async function externalRowsOn(person: string, entry: string | undefined): Promise<number> {
  const [row] = await asPerson<{ n: number }>(
    person,
    "select count(*)::int as n from api_external.advance_allocations where roster_entry_id = $1",
    [entry],
  );
  return row?.n ?? 0;
}

/** The approved shares a roster entry holds of the pool. */
async function shareOf(pool: string, entry: string): Promise<number> {
  const [row] = await sql<{ n: string }>(
    `select coalesce(sum(quantity), 0)::text as n from app.advance_allocations
      where parent_allocation_id = $1 and roster_entry_id = $2 and allocation_state = 'Approved' and deleted_at is null`,
    [pool, entry],
  );
  return Number(row?.n ?? 0);
}

/** A confirmed account member of the vendor company. */
async function member(owner: string, account: string, email: string, name: string, role: string) {
  const person = await newSignIn(email, name);
  const [membership] = await asPerson<{ id: string }>(
    owner,
    `select app.add_account_member($1, $2, $3::app.account_role) as id`,
    [account, person, role],
  );
  await asPerson(person, "select app.accept_account_membership($1)", [membership?.id]);
  return person;
}

/** Moves an asset unit through the lifecycle engine, as the demo Owner. */
async function moveUnit(id: string, from: string, to: string): Promise<void> {
  await sql(
    `select private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
       'asset_unit_id', $1::uuid, $2, $3, 'Moved by the journey fixture.')`,
    [id, from, to],
    PEOPLE.owner,
  );
}

async function tabNames(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Engagement sections" });
  return (await nav.getByRole("link").allInnerTexts()).map((t) => t.trim());
}

test("roster assignment: request for the pool, approve, assign in bulk with undo, and the roster member's view", async ({
  page,
  browser,
}) => {
  const tag = suffix();
  const key = projectKey();
  const [project] = await sql<{ id: string }>(
    `insert into app.projects (org_id, project_key, name, time_zone)
     values ($1, $2, $3, 'America/New_York') returning id`,
    [DEMO.org, key, `Roster Assignment Run ${key}`],
    PEOPLE.owner,
  );
  const projectId = project?.id as string;
  const accountName = `Demo Radio Crew ${tag}`;
  const ownerId = await newSignIn(
    `radio-owner-${tag.toLowerCase()}@example.com`,
    `Demo Radio Owner ${tag}`,
  );
  const [account] = await asPerson<{ id: string }>(
    ownerId,
    `select app.create_external_account($1, $2, 'For-Profit') as id`,
    [accountName, `demo-radio-${tag.toLowerCase()}`],
  );
  const accountId = account?.id as string;
  try {
    await offer("offerings.radios", projectId);
    await offer("offerings.parking", projectId);
    const adminEmail = `radio-admin-${tag.toLowerCase()}@example.com`;
    const kaiEmail = `radio-kai-${tag.toLowerCase()}@example.com`;
    const kaiName = `Demo Radio Kai ${tag}`;
    const moName = `Demo Radio Mo ${tag}`;
    const adminId = await member(
      ownerId,
      accountId,
      adminEmail,
      `Demo Radio Admin ${tag}`,
      "Account Admin",
    );
    const kaiId = await member(ownerId, accountId, kaiEmail, kaiName, "Account Member");
    const moId = await member(
      ownerId,
      accountId,
      `radio-mo-${tag.toLowerCase()}@example.com`,
      moName,
      "Account Member",
    );

    // The vendor engagement, with Kai and Mo on its roster, accepted by the org and by themselves.
    const [counterparty] = await sql<{ id: string }>(
      `insert into app.counterparties (org_id, organization_id) values ($1, $2) returning id`,
      [DEMO.org, accountId],
      PEOPLE.owner,
    );
    const [engagement] = await sql<{ id: string }>(
      `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
         pay_basis, arrangement, start_date, end_date)
       values ($1, $2, $3, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-04', '2027-06-06')
       returning id`,
      [projectId, ownerId, counterparty?.id],
      PEOPLE.owner,
    );
    const engagementId = engagement?.id as string;
    const entries: Record<string, string> = {};
    for (const person of [kaiId, moId]) {
      const [entry] = await asPerson<{ id: string }>(
        adminId,
        `select app.add_roster_entry($1, $2, '9000.50.02', '2027-06-04 12:00+00', '2027-06-04 14:00+00', 'America/New_York') as id`,
        [engagementId, person],
      );
      entries[person] = entry?.id as string;
    }
    await asPerson(adminId, "select app.submit_roster($1)", [engagementId]);
    for (const person of [kaiId, moId]) {
      await asPerson(PEOPLE.owner, "select app.review_roster_entry($1, 'Accepted')", [
        entries[person],
      ]);
      await asPerson(person, "select app.respond_roster_entry($1, 'Accepted')", [entries[person]]);
    }
    await transition("engagement", engagementId, "Onboarding", "Active");

    // The org's radios: six units ready to hold.
    const [radios] = await asPerson<{ id: string }>(
      PEOPLE.owner,
      `select app.ensure_offering_asset_class($1, 'Radios') as id`,
      [DEMO.org],
    );
    const tags = Array.from({ length: 6 }, (_, i) => `R8-${tag}-${i + 1}`);
    for (const assetTag of tags) {
      const [unit] = await sql<{ id: string }>(
        `insert into app.asset_units (asset_class_id, asset_tag) values ($1, $2) returning id`,
        [radios?.id, assetTag],
        PEOPLE.owner,
      );
      await moveUnit(unit?.id as string, "Proposed", "Received");
      await moveUnit(unit?.id as string, "Received", "Available");
    }
    const [radioClass] = await sql<{ name: string }>(
      "select name from app.asset_classes where id = $1",
      [radios?.id],
    );
    const radioName = radioClass?.name as string;

    // The Admin asks for six radios for the pool on the Crew tab.
    const engagementPath = `/work/engagements/${toDisplayKey("engagement", engagementId)}`;
    await signIn(page, adminEmail, "/home");
    await page.goto(`${engagementPath}/crew`);
    const request = page.getByRole("form", { name: "Request an item" });
    await expect(request.getByLabel("For", { exact: true })).toHaveValue("pool");
    await request.getByLabel("Item", { exact: true }).selectOption({ label: radioName });
    await request.getByLabel("Quantity", { exact: true }).fill("6");
    await request.getByLabel("Needed from", { exact: true }).fill("2027-06-04T08:00");
    await request.getByLabel("Needed until", { exact: true }).fill("2027-06-06T23:00");
    await request.getByLabel("Note", { exact: true }).fill("For the audio crew.");
    await request.getByRole("button", { name: "Send request" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Request sent. The organization reviews it." }),
    ).toBeVisible();
    const [pool] = await sql<{ id: string }>(
      `select id from app.advance_allocations
        where engagement_id = $1 and allocation_state = 'Requested' and deleted_at is null`,
      [engagementId],
    );
    const poolId = pool?.id as string;
    expect(poolId).toBeTruthy();

    // The producing org approves it.
    await asPerson(PEOPLE.owner, "select app.decide_allocation($1, 'Approved')", [poolId]);

    // Assign one radio each to Kai and Mo from the bulk bar; undo and redo.
    await page.reload();
    const people = page.getByRole("group", { name: "People to assign" });
    await people.getByLabel(`${kaiName}, holds 0`).check();
    await people.getByLabel(`${moName}, holds 0`).check();
    const bar = page.getByRole("toolbar", { name: "Bulk actions" });
    await bar.getByRole("button", { name: "Assign to 2 people" }).click();
    const assigning = page.getByRole("dialog", { name: "Assign to 2 people" });
    await expect(assigning.getByText("2 people's shares will change.")).toBeVisible();
    await assigning.getByRole("button", { name: "Assign to 2 people" }).click();
    await expect(page.getByText("Assigned to 2 people.")).toBeVisible();
    await expect.poll(() => shareOf(poolId, entries[kaiId] as string)).toBe(1);
    await expect.poll(() => shareOf(poolId, entries[moId] as string)).toBe(1);
    await page.locator("body").focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => shareOf(poolId, entries[kaiId] as string)).toBe(0);
    await expect(page.getByText("Undone: Assigned to 2 people.")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => shareOf(poolId, entries[kaiId] as string)).toBe(1);
    await expect.poll(() => shareOf(poolId, entries[moId] as string)).toBe(1);

    // Kai's parking pass, for his van.
    await asPerson(
      kaiId,
      "select app.save_roster_vehicle($1, 'Ford', 'Transit', 'White', 'ABC1234', 'US-FL')",
      [entries[kaiId]],
    );
    const [venue] = await sql<{ id: string }>(
      "select id from app.venues where org_id = $1 and deleted_at is null order by id limit 1",
      [DEMO.org],
    );
    const [zone] = await sql<{ id: string }>(
      `insert into app.zones (venue_id, code, name) values ($1, $2, $3) returning id`,
      [venue?.id, `LOT-${tag}`, `Lot ${tag}`],
      PEOPLE.owner,
    );
    const [category] = await sql<{ id: string }>(
      `insert into app.credential_categories (project_id, code, name, category_kind)
       values ($1, $2, 'Crew Parking', 'Parking') returning id`,
      [projectId, `PK${tag}`],
      PEOPLE.owner,
    );
    await sql(
      `insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
       values ($1, $2, 'ENM-036', '2027-06-04 00:00+00', '2027-06-07 00:00+00')`,
      [category?.id, zone?.id],
      PEOPLE.owner,
    );
    const [vehicle] = await sql<{ id: string }>(
      "select id from app.roster_vehicles where roster_entry_id = $1 and deleted_at is null",
      [entries[kaiId]],
    );
    const [pass] = await asPerson<{ id: string }>(
      PEOPLE.owner,
      `select app.assign_allocation($1, null, $2, $3, null, null, null, null, 1, '2027-06-04 00:00+00',
         '2027-06-07 00:00+00', 'America/New_York') as id`,
      [projectId, entries[kaiId], category?.id],
    );
    await asPerson(PEOPLE.owner, "select app.issue_allocation(gen_random_uuid(), $1, $2::jsonb)", [
      pass?.id,
      JSON.stringify([{ roster_vehicle_id: vehicle?.id }]),
    ]);

    // Kai, a plain Account Member on the roster, sees only the Roster Member tabs and his own rows.
    const kai = await browser.newContext({ reducedMotion: "reduce" });
    const kaiPage = await kai.newPage();
    await signIn(kaiPage, kaiEmail, "/home");
    await kaiPage.goto(`${engagementPath}/overview`);
    expect(await tabNames(kaiPage)).toEqual([
      "Overview",
      "Project Details",
      "Credentials",
      "Documents",
      "Messages",
    ]);
    const upNext = kaiPage.getByRole("region", { name: "Up next" });
    await expect(upNext).toContainText(radioName);
    await expect(upNext).toContainText(`Lot ${tag}`);
    await expect(upNext).toContainText("Ford Transit White");
    await expect(upNext).not.toContainText("ABC1234");
    const assigned = kaiPage.getByRole("list", { name: "Assigned to you" });
    await expect(assigned).toContainText(`${radioName} (1)`);
    await expect(assigned).toContainText("Reserved");
    await expect(kaiPage.getByText(moName)).toHaveCount(0);
    expect((await kaiPage.goto(`${engagementPath}/crew`))?.status()).toBe(404);

    // Once the desk issues his radio, it reads Issued.
    const [share] = await sql<{ id: string }>(
      `select id from app.advance_allocations where roster_entry_id = $1 and parent_allocation_id = $2
        and allocation_state = 'Approved' and deleted_at is null`,
      [entries[kaiId], poolId],
    );
    await asPerson(PEOPLE.owner, "select app.issue_allocation(gen_random_uuid(), $1, $2::jsonb)", [
      share?.id,
      JSON.stringify([{ asset_tag: tags[0] }]),
    ]);
    await kaiPage.goto(`${engagementPath}/overview`);
    await expect(kaiPage.getByRole("list", { name: "Assigned to you" })).toContainText("Issued");
    await kai.close();
    // Through the Gateway API's view, Kai reads his own share and none of Mo's.
    expect(await externalRowsOn(kaiId, entries[kaiId])).toBeGreaterThan(0);
    expect(await externalRowsOn(kaiId, entries[moId])).toBe(0);
  } finally {
    for (const statement of [
      `update app.asset_custody set deleted_at = now() where project_id = $1 and deleted_at is null`,
      `update app.credentials set deleted_at = now()
        where credential_category_id in (select id from app.credential_categories where project_id = $1) and deleted_at is null`,
      `update app.asset_reservations set deleted_at = now() where project_id = $1 and deleted_at is null`,
      `update app.advance_allocations set deleted_at = now() where project_id = $1 and deleted_at is null`,
      `update app.engagement_roster_entries set deleted_at = now()
        where engagement_id in (select id from app.engagements where project_id = $1) and deleted_at is null`,
      `update app.setting_values set deleted_at = now()
        where scope_kind = 'Project' and scope_id = $1 and deleted_at is null`,
      "update app.engagements set deleted_at = now() where project_id = $1 and deleted_at is null",
      "update app.projects set deleted_at = now() where id = $1 and deleted_at is null",
    ]) {
      await sql(statement, [projectId]).catch(() => undefined);
    }
    await sql(
      "update app.asset_units set deleted_at = now() where asset_tag like $1 and deleted_at is null",
      [`R8-${tag}-%`],
    ).catch(() => undefined);
  }
});
