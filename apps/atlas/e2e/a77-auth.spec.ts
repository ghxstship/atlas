import { expect as baseExpect, test, type Page } from "@playwright/test";
import {
  createOrganization,
  expectAccessible,
  PASSWORD,
  signUp,
  testEmail,
  uniqueId,
} from "./support";
import { enrollAuthenticator, totp } from "./totp";

/**
 * A77 authentication journeys (RRR-122; A65-002, A59-019; Section 9): an authenticator app is enrolled and
 * challenged at sign-in; a second factor older than step-up allows is asked for again before a Restricted export
 * (the full org export) and before break-glass, in a dialog that resumes the action; and an org's MFA policy sends
 * a member without a factor to set one up. Each journey signs up a fresh Owner in a fresh org, so runs never collide
 * and the demo tenant keeps no second factor.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(150_000);
const expect = baseExpect.configure({ timeout: 20_000 });

async function newOwner(page: Page, label: string) {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  const email = testEmail(label, id);
  await signUp(page, { name: "Tess Twofactor", email });
  await createOrganization(page, { name: `Two Factor ${id}`, slug });
  return { slug, email };
}

test("TOTP enrollment, the challenge at sign-in, rename and removal with step-up", async ({
  page,
}) => {
  const { slug, email } = await newOwner(page, "totp");

  await page.goto(`/${slug}/me/security`);
  const factors = page.getByRole("region", { name: "Two-step verification" });
  await expect(factors.getByText("No second factor yet.")).toBeVisible();
  await expectAccessible(page);

  // Enroll: a wrong code is refused, the right one turns the factor on.
  await factors.getByRole("button", { name: "Set up authenticator app" }).click();
  await factors.getByLabel("Name", { exact: true }).fill("Work phone");
  await factors.getByRole("button", { name: "Set up authenticator app" }).click();
  await expect(factors.getByRole("img", { name: /QR code that sets up/ })).toBeVisible();
  await expectAccessible(page);
  await factors.getByRole("button", { name: "Can't scan? Show the setup key" }).click();
  const secret = (await factors.locator("code").first().textContent())?.trim() ?? "";
  await factors.getByLabel("Code", { exact: true }).fill("000000");
  await factors.getByRole("button", { name: "Verify and turn on" }).click();
  await expect(factors.getByText("That code didn't match.", { exact: false })).toBeVisible();
  await factors.getByLabel("Code", { exact: true }).fill(totp(secret));
  await factors.getByRole("button", { name: "Verify and turn on" }).click();
  await expect(factors.getByRole("list", { name: "Two-step verification" })).toContainText(
    "Work phone",
  );

  // Rename it.
  await factors.getByRole("button", { name: "New name for Work phone" }).click();
  await factors.getByLabel("New name for Work phone").fill("Pocket phone");
  await factors.getByRole("button", { name: "Save" }).click();
  await expect(factors.getByRole("list", { name: "Two-step verification" })).toContainText(
    "Pocket phone",
  );

  // Sign out and in: the password alone is not enough any more.
  await page.context().clearCookies();
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${slug}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL("**/auth/mfa?**");
  await expect(page.getByRole("heading", { name: "Verify it's you" })).toBeVisible();
  await expectAccessible(page);
  // Pages stay closed until the code passes.
  await page.goto(`/${slug}/home`);
  await page.waitForURL("**/auth/mfa?**");
  await page.getByLabel("Code", { exact: true }).fill(totp(secret, 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(`**/${slug}/home`);

  // Removing needs a second factor within 15 minutes, which the sign-in just passed.
  await page.goto(`/${slug}/me/security`);
  await page.getByRole("button", { name: "Remove Pocket phone" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove Pocket phone?" });
  await expectAccessible(page);
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(factors.getByText("No second factor yet.")).toBeVisible();
});

test("step-up on a Restricted export: the full org export asks for a second factor first", async ({
  page,
}) => {
  const { slug } = await newOwner(page, "export");
  await page.goto(`/${slug}/settings/danger-zone`);
  const panel = page.getByRole("region", { name: "Cancel the organization" });

  // Without step-up the export route returns to Danger zone rather than serving the archive.
  const direct = await page.request.get(`/${slug}/export`, { maxRedirects: 0 });
  expect(direct.status()).toBe(303);

  await panel.getByRole("link", { name: "Download the full export" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    enrollAuthenticator(dialog),
  ]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^${slug}-export-.*\\.zip$`));
  await expect(dialog).toBeHidden();
});

test("break-glass: the Owner verifies in place and takes emergency access (A59-019)", async ({
  page,
}) => {
  const { slug } = await newOwner(page, "glass");
  await page.goto(`/${slug}/settings/security`);
  const panel = page.getByRole("region", { name: "Emergency access" });
  await panel
    .getByLabel("Why do you need emergency access?")
    .fill("Payroll export failed during load-in and must run now.");
  await panel.getByRole("button", { name: "Take emergency access" }).click();

  // No second factor yet: the dialog sets one up, and verifying it resubmits the form.
  const dialog = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await enrollAuthenticator(dialog);
  await expect(dialog).toBeHidden();
  await expect(panel.getByText(/You hold emergency access until/)).toBeVisible();
  await panel.getByRole("button", { name: "End emergency access" }).click();
  await expect(panel.getByRole("button", { name: "Take emergency access" })).toBeVisible();
});

test("an org that requires a second factor sends a member without one to set it up", async ({
  page,
}) => {
  const { slug } = await newOwner(page, "policy");
  await page.goto(`/${slug}/settings/security`);
  // The idle timeout's record of the device's last request reaches the browser, httpOnly.
  const seen = (await page.context().cookies()).find((c) => c.name === "xos-last-seen");
  expect(seen?.httpOnly).toBe(true);
  const policy = page
    .locator("form")
    .filter({ has: page.getByLabel("Multi-factor authentication") });
  await policy.getByLabel("Multi-factor authentication").selectOption("everyone");
  await policy.getByRole("button", { name: "Save" }).click();

  // Saved, the page itself now asks the Owner for a factor; so does every other page of the org.
  await page.waitForURL("**/auth/mfa?**");
  await page.goto(`/${slug}/home`);
  await page.waitForURL("**/auth/mfa?**");
  await expect(page.getByRole("heading", { name: "Set up a second factor" })).toBeVisible();
  await expectAccessible(page);
  await enrollAuthenticator(page);
  await page.waitForURL(`**/${slug}/home`);
});
