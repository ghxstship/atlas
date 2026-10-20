import { expect, test, type Browser, type Page } from "./engine-test";
import {
  createOrganization,
  expectAccessible,
  PASSWORD,
  signUp,
  testEmail,
  uniqueId,
} from "./support";

/**
 * A13 People journeys (Section 20.2): 9 (size a staffing requisition from a canon staffing ratio and an
 * occupancy figure, then send an agreement for signature; the signer signs and the signed agreement can
 * no longer be revoked, only superseded) and the directory, roles and certifications pages, with the
 * rule that nobody records their own certificate. Each run uses a new org on the shared stack; every
 * page is checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
expect.configure({ timeout: 20_000 });

async function settled(page: Page) {
  await page.waitForTimeout(400);
  await expectAccessible(page);
}

async function bothThemes(page: Page) {
  await settled(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await settled(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}

async function newOrg(page: Page, browser: Browser) {
  const id = uniqueId();
  const slug = `ppl-${id}`;
  const fieldEmail = testEmail("field", id);
  const fieldName = `Fern Field ${id}`;
  await signUp(page, { name: "Olive Owner", email: testEmail("owner", id) });
  await createOrganization(page, { name: `People ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill("NWL");
  await dialog.getByLabel("Project name").fill("Northwind Summer Series");
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/NWL/overview`);
  await page.goto(`/${slug}/settings/members`);
  await page.getByLabel("Email", { exact: true }).fill(fieldEmail);
  await page.locator("#invite-role").selectOption({ label: "Field" });
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = page.locator("#invite-link");
  await expect(link).toHaveValue(/\/auth\/invite\/xinv_/, { timeout: 30_000 });
  const inviteUrl = new URL(await link.inputValue());
  const field = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await field.goto(inviteUrl.pathname);
  await field.getByLabel(/^Full name$/).fill(fieldName);
  await field.locator("#signup-email").fill(fieldEmail);
  await field.locator("#signup-password").fill(PASSWORD);
  await field.getByRole("checkbox", { name: /16 or older/ }).check();
  await field.getByRole("button", { name: "Create account" }).click();
  await field.getByRole("button", { name: "Accept invitation" }).click();
  await field.waitForURL(`**/${slug}/home`);
  return { slug, owner: page, field, fieldName };
}

test("journey 9: a requisition sized from a staffing ratio, and an agreement signed that cannot be revoked", async ({
  page,
  browser,
}) => {
  const { slug, owner, field, fieldName } = await newOrg(page, browser);

  // Roles: the staffing calculator sizes ratio roles from the occupancy, from canon.
  await owner.goto(`/${slug}/people/roles?occupancy=2500`);
  const bartending = owner.getByRole("row").filter({ hasText: "8000.50.01" });
  await expect(bartending).toContainText("1 per 65 guests");
  await expect(bartending).toContainText("39");
  await bothThemes(owner);
  await bartending.dblclick();
  await owner.getByRole("link", { name: "Request staff" }).click();

  // The requisition opens with the role and headcount filled in.
  const req = owner.getByRole("dialog", { name: "New requisition" });
  await expect(req.getByLabel("Headcount")).toHaveValue("39");
  await req.getByLabel("Justification").fill("Bars for the opening night at 2,500 guests.");
  await req.getByRole("button", { name: "New requisition" }).click();
  await expect(req).toBeHidden();
  const peek = owner.getByRole("dialog").first();
  await expect(peek).toContainText("39 × Head Beverage Director");
  await expect(peek).toContainText("Unpriced");
  // The requester never approves their own requisition.
  await expect(peek.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await bothThemes(owner);

  // Agreements: draft, send (the link and access code are shown once), and the signer signs.
  await owner.goto(`/${slug}/people/agreements?create=1`);
  const draft = owner.getByRole("dialog", { name: "New agreement" });
  await draft.getByLabel("Signer").selectOption({ label: fieldName });
  await draft.getByLabel("Title").fill("Crew Services Agreement");
  await draft
    .getByLabel("Agreement text")
    .fill("The crew member provides rigging services on the dates agreed.");
  await draft.getByRole("button", { name: "New agreement" }).click();
  await expect(draft).toBeHidden();
  await owner.getByRole("button", { name: "Send for signature" }).click();
  const send = owner.getByRole("dialog", { name: "Send this agreement for signature?" });
  await send.getByRole("button", { name: "Send for signature" }).click();
  await expect(owner.getByRole("textbox", { name: "Access code" })).toHaveValue(/^\d{8}$/);
  await expect(owner.getByRole("textbox", { name: "Signing link" })).toHaveValue(/\/sign\/xagr_/);
  await settled(owner);
  await owner.getByRole("button", { name: "Done" }).click();

  await field.goto(`/${slug}/people/agreements`);
  await field.getByRole("row").filter({ hasText: "Crew Services Agreement" }).dblclick();
  await field.getByLabel("Your full name").fill(fieldName);
  await field.getByRole("button", { name: "Sign agreement" }).click();
  await expect(field.getByText("This signature is permanent")).toBeVisible();
  await bothThemes(field);

  // A signed agreement offers no cancel or recall, only supersede.
  await owner.goto(`/${slug}/people/agreements`);
  await owner.getByRole("row").filter({ hasText: "Crew Services Agreement" }).dblclick();
  const signed = owner.getByRole("dialog").first();
  await expect(signed).toContainText("Moved from Sent for signature to Signed");
  await expect(signed.getByRole("button", { name: "Cancel agreement" })).toHaveCount(0);
  await expect(signed.getByRole("button", { name: "Recall" })).toHaveCount(0);
  await expect(signed.getByRole("button", { name: "Supersede" })).toBeVisible();
});

test("directory and certifications: seats and Field metering, nobody records their own certificate", async ({
  page,
  browser,
}) => {
  const { slug, owner, fieldName } = await newOrg(page, browser);
  await owner.goto(`/${slug}/people/directory`);
  await expect(owner.getByText("1 seat in use · 1 Field member")).toBeVisible();
  await bothThemes(owner);

  await owner.goto(`/${slug}/people/certifications`);
  await owner.getByRole("link", { name: "Add certification type" }).first().click();
  const type = owner.getByRole("dialog", { name: "Add a certification type" });
  await type.getByLabel("Certification name").fill("ETCP Arena Rigger");
  await type.getByLabel("Issuing body").fill("Entertainment Technician Certification Program");
  await type.getByRole("button", { name: "Add certification type" }).click();
  await expect(type).toBeHidden();
  await owner.getByRole("link", { name: "Record certificate" }).first().click();
  const record = owner.getByRole("dialog", { name: "Record a certificate" });
  await expect(
    record.getByLabel("Holder").locator("option", { hasText: "Olive Owner" }),
  ).toHaveCount(0);
  await record.getByLabel("Holder").selectOption({ label: fieldName });
  await record.getByRole("button", { name: "Record certificate" }).click();
  await expect(record).toBeHidden();
  await expect(owner.getByRole("row").filter({ hasText: fieldName })).toContainText("Current");
  await bothThemes(owner);
});
