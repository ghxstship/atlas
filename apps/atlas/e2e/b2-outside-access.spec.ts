import { DEMO_ORG, signInAs } from "./a36-support";
import { cognitiveLoadProblems } from "./a11y/checks";
import { displayLink, personOf, sql, storedFile } from "./b2-support";
import { expect, test, type Locator } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * B2 Outside access (RRR-226, ADR 0141; gap G-81): the section on Project Settings lists every source that reaches a
 * project from outside the org, its first click on a just-loaded page opens the dialog, a new code stays through a refresh
 * until dismissed, Regenerate and Revoke change the row, and the Engagements toolbar keeps its code in its dialog.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

/** The demo tenant's project (seed 0107) and the engagements and vendor contact on it (seed 0228). */
const PROJECT = "01920000-0000-7000-8000-000000001001";
const CREW = "01920000-0000-7000-8000-000000000201";
const VENDOR_CONTACT = "01920000-0000-7000-8000-000000000302";
const VENDOR_ENGAGEMENT = "01920000-0000-7000-8000-000000228402";
const CREW_ENGAGEMENT = "01920000-0000-7000-8000-000000228401";

async function everySource(owner: string, id: string): Promise<void> {
  // The live links: a display screen and a saved view.
  await displayLink(owner, PROJECT, `Order ${id}`);
  const [saved] = await sql<{ id: string }>(
    `insert into app.saved_views (membership_id, collection_key, name, view_type, shared)
     select m.id, 'project/schedule', $2::text, 'List', true from app.memberships m
      where m.person_id = $1::uuid and m.org_id = (select org_id from app.projects where id = $3::uuid)
     returning id`,
    [owner, `Venue schedule ${id}`, PROJECT],
    owner,
  );
  await sql(
    `select * from app.create_view_link($1::uuid, $2::uuid, now() + interval '30 days')`,
    [saved?.id, PROJECT],
    owner,
  );
  // A file link.
  const file = await storedFile({
    person: owner,
    subjectTable: "app.projects",
    subjectId: PROJECT,
    name: `plan-${id}.pdf`,
    classification: "Public",
  });
  await sql(
    `select * from app.create_share_link($1::uuid, now() + interval '30 days')`,
    [file],
    owner,
  );
  // An advance link and a signing link.
  const [packet] = await sql<{ id: string }>(
    `insert into app.advance_packets (project_id, title) values ($1::uuid, $2) returning id`,
    [PROJECT, `Advance ${id}`],
    owner,
  );
  await sql(
    `insert into app.advance_sections (advance_packet_id, position, title) values ($1::uuid, 1, 'Power')`,
    [packet?.id],
    owner,
  );
  const [recipient] = await sql<{ id: string }>(
    `insert into app.advance_recipients (advance_packet_id, person_id) values ($1::uuid, $2::uuid) returning id`,
    [packet?.id, CREW],
    owner,
  );
  await sql(`select app.send_advance_packet($1::uuid)`, [packet?.id], owner);
  await sql(
    `select * from app.issue_advance_token($1::uuid, $2)`,
    [recipient?.id, `advance-${id}@example.com`],
    owner,
  );
  const [document] = await sql<{ id: string }>(
    `insert into app.engagement_documents (engagement_id, document_kind, title) values ($1::uuid, 'Agreement', $2) returning id`,
    [CREW_ENGAGEMENT, `Crew agreement ${id}`],
    owner,
  );
  await sql(
    `select app.transition_engagement_document($1::uuid, 'Proposed', 'Sent', 'Sent.')`,
    [document?.id],
    owner,
  );
  await sql(
    `select * from app.issue_engagement_document_token($1::uuid, $2)`,
    [document?.id, `signing-${id}@example.com`],
    owner,
  );
  // A roster invitation, from the vendor's own contact, on an open engagement of the demo vendor (its seeded one is complete).
  const [vendor] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, start_date, end_date)
     select $1::uuid, $2::uuid, e.counterparty_id, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
       '2027-06-04', '2027-06-06'
     from app.engagements e where e.id = $3::uuid
     returning id`,
    [PROJECT, VENDOR_CONTACT, VENDOR_ENGAGEMENT],
    owner,
  );
  await sql(
    `select app.invite_to_roster($1::uuid, $2, '9000.50.02')`,
    [vendor?.id, `roster-${id}@example.com`],
    VENDOR_CONTACT,
  );
  // A pack recipient, an intake link and a form link.
  const [pack] = await sql<{ id: string }>(
    `select app.create_stakeholder_pack($1::uuid, $2, now() + interval '30 days') as id`,
    [PROJECT, `Sources pack ${id}`],
    owner,
  );
  await sql(
    `select * from app.add_stakeholder_pack_recipient($1::uuid, 'Cleo Client', $2)`,
    [pack?.id, `cleo-${id}@client.test`],
    owner,
  );
  await sql(
    `select * from app.create_vendor_intake_link($1::uuid, $2, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate',
       'Per Engagement', '2027-06-01', now() + interval '30 days', null, 'AV Integrator')`,
    [PROJECT, `Audio vendors ${id}`],
    owner,
  );
  const [template] = await sql<{ id: string }>(
    `insert into app.form_templates (org_id, name, record_kind, fields)
     select org_id, $2::text, 'Document', '[{"key": "a", "label": "A", "kind": "text"}]'::jsonb from app.projects where id = $1::uuid
     returning id`,
    [PROJECT, `Supplier check ${id}`],
    owner,
  );
  await sql(`select app.publish_form_template($1::uuid)`, [template?.id], owner);
  await sql(
    `select * from app.create_form_link($1::uuid, now() + interval '30 days', $2::uuid)`,
    [template?.id, PROJECT],
    owner,
  );
}

test("every source of outside access is listed, and a holder revokes from its row", async ({
  page,
}) => {
  const id = uniqueId();
  const owner = await personOf("owner@example.com");
  await everySource(owner, id);

  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/p/NWS/settings#outside-access`);
  const section = page.locator("#outside-access");
  const row = (source: string): Locator => section.locator(`[data-outside-row="${source}"]`);
  for (const source of [
    "Live view link",
    "Display link",
    "File link",
    "Advance link",
    "Signing link",
    "Roster invitation",
    "Pack recipient",
    "Intake link",
    "Form link",
    "Engagement",
  ]) {
    await expect(row(source).first()).toBeVisible();
  }
  expect(await cognitiveLoadProblems(page)).toEqual([]);

  // A source with no words of its own is named by the screen; nothing here is a token or a code.
  await expect(row("Roster invitation").first()).toContainText("Roster invitation");
  await expect(row("Display link").first()).toContainText("Display link");
  await expect(section).not.toContainText(/xvin_|xfrm_|xpkl_/);

  // The people the section names, resolved through the view's owner.
  await expect(
    row("Engagement").first().getByRole("link", { name: "Open engagement" }),
  ).toBeVisible();

  // The owner holds data.export.confidential, so a file link's Revoke shows and works.
  const file = row("File link").filter({ hasText: `plan-${id}.pdf` });
  await file.getByRole("button", { name: "Revoke", exact: true }).click();
  await file.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(file).toContainText("Revoked");
  await expect(file.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);

  const advance = row("Advance link").filter({ hasText: `Advance ${id}` });
  await advance.getByRole("button", { name: "Revoke", exact: true }).click();
  await advance.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(advance).toContainText("Revoked");
});

test("Outside access lists a link, regenerates with the code still showing, and revokes", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `b2a-${id}`;
  await signUp(page, { name: "Ana Access", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Access ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const create = page.getByRole("dialog", { name: "New project" });
  await create.getByLabel("Project key").fill("SHW");
  await create.getByLabel("Project name").fill("Summer Headline Weekend");
  await create.getByRole("button", { name: "More fields" }).click();
  await create.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await create.getByLabel("Tier of experience").selectOption({ index: 5 });
  await create.getByLabel("First production day").fill("2027-03-12");
  await create.getByLabel("Last production day").fill("2027-03-15");
  await create.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/SHW/overview`);

  await page.goto(`/${slug}/p/SHW/settings#outside-access`);
  const section = page.locator("#outside-access");
  await expect(section.getByText("Nothing reaches this project from outside yet.")).toBeVisible();

  await expect(async () => {
    await section.getByRole("button", { name: "New intake link", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill(`Audio vendors ${id}`);
  await dialog.getByLabel("Who engages").selectOption("Contractor");
  await dialog.getByLabel("Start date").fill("2027-03-12");
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByLabel("Role", { exact: true }).selectOption({ index: 1 });
  await dialog.getByLabel("Classification").selectOption({ index: 1 });
  await dialog.getByLabel("Pay basis").selectOption({ index: 1 });
  await dialog.getByLabel("Arrangement").selectOption({ index: 1 });
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  const expires = await dialog.getByLabel("Available until").getAttribute("max");
  await dialog.getByLabel("Available until").fill(expires as string);
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Create link" }).click();

  const panel = page.locator("[data-outside-reveal]");
  await expect(panel).toBeVisible();
  const first = await panel.getByRole("textbox", { name: "Access code" }).inputValue();
  expect(first).toMatch(/^[0-9]{6}$/);
  expect(await panel.getByRole("textbox", { name: "Link" }).inputValue()).toMatch(
    /\/onboard\/xvin_[0-9a-f]{64}$/,
  );

  const row = section.locator('[data-outside-row="Intake link"]');
  await expect(row).toContainText(`Audio vendors ${id}`);
  await row.getByRole("button", { name: "Regenerate", exact: true }).click();
  await row.getByRole("button", { name: "Confirm", exact: true }).click();
  // The new code joins the first; neither is lost, and both stay through the router's refresh.
  await expect(panel).toHaveCount(2);
  await expect(panel.last().getByRole("textbox", { name: "Access code" })).toHaveValue(first);
  await expect(panel.first().getByRole("textbox", { name: "Access code" })).not.toHaveValue(first);

  await panel.last().getByRole("button", { name: "Dismiss", exact: true }).click();
  await panel.first().getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(panel).toHaveCount(0);

  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await row.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);

  // The Engagements toolbar: a new link's code stays in its dialog, not in the toolbar row.
  await page.goto(`/${slug}/p/SHW/engagements`);
  await expect(async () => {
    // Intake requests sits in the header's More menu with Generate agreements.
    await page.getByRole("main").getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Intake requests", exact: true }).click();
    await page
      .getByRole("button", { name: "New intake link", exact: true })
      .click({ timeout: 2_000 });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const toolbar = page.getByRole("dialog");
  await toolbar.getByLabel("Title", { exact: true }).fill(`Riggers ${id}`);
  await toolbar.getByLabel("Who engages").selectOption("Contractor");
  await toolbar.getByLabel("Start date").fill("2027-03-12");
  await toolbar.getByRole("button", { name: "Next", exact: true }).click();
  await toolbar.getByLabel("Role", { exact: true }).selectOption({ index: 1 });
  await toolbar.getByLabel("Classification").selectOption({ index: 1 });
  await toolbar.getByLabel("Pay basis").selectOption({ index: 1 });
  await toolbar.getByLabel("Arrangement").selectOption({ index: 1 });
  await toolbar.getByRole("button", { name: "Next", exact: true }).click();
  const until = await toolbar.getByLabel("Available until").getAttribute("max");
  await toolbar.getByLabel("Available until").fill(until as string);
  await toolbar.getByRole("button", { name: "Create link" }).click();
  await expect(toolbar.locator("[data-outside-reveal]")).toBeVisible();
  expect(await cognitiveLoadProblems(page)).toEqual([]);
  await toolbar.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await cognitiveLoadProblems(page)).toEqual([]);
});
