import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

test("invite a member, accept as them, and hide what their role may not see", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const slug = `crew-${id}`;
  const inviteeEmail = testEmail("viewer", id);

  // Owner: create the org and invite a Viewer.
  await signUp(page, { name: "Olive Owner", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Crew ${id}`, slug });
  await page.goto(`/${slug}/settings/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Email", { exact: true }).fill(inviteeEmail);
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = page.getByRole("textbox", { name: "Invitation link", exact: true });
  await expect(link).toHaveValue(/\/auth\/invite\/xinv_/);
  const inviteUrl = new URL(await link.inputValue());
  await expect(page.getByText(inviteeEmail, { exact: true })).toBeVisible();
  await expectAccessible(page);

  // Invitee: open the link signed out, sign up with the invited email, accept.
  const invitee = await (await browser.newContext()).newPage();
  await invitee.goto(inviteUrl.pathname);
  await expect(invitee).toHaveURL(/\/auth\/sign-up\?next=/);
  await invitee.getByLabel(/^Full name$/).fill("Vic Viewer");
  await invitee.locator("#signup-email").fill(inviteeEmail);
  await invitee.locator("#signup-password").fill(`E2e-${"passphrase"}-9431`);
  await invitee.getByRole("button", { name: "Create account" }).click();
  await expect(invitee.getByRole("heading", { name: `Join Crew ${id}` })).toBeVisible();
  await expect(invitee.getByText("as Viewer")).toBeVisible();
  await expectAccessible(invitee);
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await invitee.waitForURL(`**/${slug}/home`);
  await expectAccessible(invitee);

  // Viewer: Commercial is hidden in the sidebar, and its routes and settings answer 404.
  await expect(invitee.getByRole("button", { name: "Commercial" })).toHaveCount(0);
  for (const hidden of [`/${slug}/finance/budgets`, `/${slug}/settings/members`]) {
    const response = await invitee.goto(hidden);
    expect(response?.status(), hidden).toBe(404);
    await expect(invitee.getByRole("heading", { name: "Page not found" })).toBeVisible();
  }
  await expectAccessible(invitee);
  const visible = await invitee.goto(`/${slug}/knowledge/sops`);
  expect(visible?.status()).toBe(200);

  // Owner: the Viewer is now a member and the invitation is no longer pending.
  await page.reload();
  await expect(page.getByText("Vic Viewer", { exact: true })).toBeVisible();
  await expect(page.getByText("No pending invitations. Invite someone above.")).toBeVisible();
});

test("white label blocks an accent that fails contrast", async ({ page }) => {
  const id = uniqueId();
  const slug = `brand-${id}`;
  await signUp(page, { name: "Bea Brand", email: testEmail("brand", id) });
  await createOrganization(page, { name: `Brand ${id}`, slug });
  await page.goto(`/${slug}/settings/white-label`);
  await expect(page.getByText("Passes WCAG 2.2 AA in every theme.")).toBeVisible();
  await page.getByLabel("Brand accent", { exact: true }).first().fill("#FFE680");
  await expect(page.getByText(/Fails WCAG 2.2 AA/)).toBeVisible();
  await expectAccessible(page);
});
