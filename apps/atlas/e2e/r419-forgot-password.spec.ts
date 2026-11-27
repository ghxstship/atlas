import { expect as baseExpect, test, type APIRequestContext, type Page } from "./engine-test";
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
 * Forgot password (release 4.19, owner decision of 2026-11-27; lib/auth/recovery.ts). The sign-in page links to the
 * request page, which answers an unknown address exactly as a known one; Supabase Auth's recovery email lands in the
 * local stack's Mailpit (E2E_INBUCKET_URL); its link opens Choose a new password, which applies the password rules and
 * signs out the account's other sessions. A person who holds a second factor passes it before the new password.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const NEW_PASSWORD = `Harbor-${"lantern"}-5170`;

function mailpit(): string {
  const inbox = process.env["E2E_INBUCKET_URL"];
  if (!inbox) throw new Error("Set E2E_INBUCKET_URL to the local stack's Mailpit.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(inbox)) throw new Error("Local stack only.");
  return inbox;
}

interface Mail {
  readonly id: string;
  readonly subject: string;
}

async function mailsTo(request: APIRequestContext, to: string): Promise<Mail[]> {
  const found = (await (
    await request.get(`${mailpit()}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
  ).json()) as { messages?: { ID: string; Subject: string }[] };
  return (found.messages ?? []).map((m) => ({ id: m.ID, subject: m.Subject }));
}

/** The reset link of the newest recovery email to an address, waiting for it to arrive. */
async function resetLink(request: APIRequestContext, to: string): Promise<string> {
  let mail: Mail | undefined;
  await expect(async () => {
    mail = (await mailsTo(request, to)).find((m) => m.subject === "Reset your XOS password");
    expect(mail).toBeDefined();
  }).toPass({ timeout: 30_000 });
  const message = (await (
    await request.get(`${mailpit()}/api/v1/message/${mail?.id ?? ""}`)
  ).json()) as { HTML: string };
  const href = /<a href="([^"]+\/auth\/v1\/verify[^"]+)"/.exec(message.HTML)?.[1];
  if (!href) throw new Error("The recovery email has no reset link.");
  return href.replace(/&amp;/g, "&");
}

async function askForReset(page: Page, email: string) {
  await page.goto("/auth/sign-in");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.waitForURL("**/auth/forgot-password");
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Email me a reset link" }).click();
  const sent = page.getByText(`If an account uses ${email}, a reset link is on its way.`, {
    exact: false,
  });
  await expect(sent).toBeVisible();
}

async function signInWithPassword(page: Page, email: string, password: string) {
  await page.goto("/auth/sign-in");
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

test("a forgotten password: the same answer for any address, the emailed link, the rules, other sessions end", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const slug = `reset-${id}`;
  const email = testEmail("reset", id);
  await signUp(page, { name: "Rae Reset", email });
  await createOrganization(page, { name: `Reset ${id}`, slug });

  // A second browser signed in with the old password.
  const other = await browser.newContext({ extraHTTPHeaders: { "Sec-GPC": "1" } });
  const otherPage = await other.newPage();
  await signInWithPassword(otherPage, email, PASSWORD);
  await otherPage.waitForURL(`**/${slug}/home`);

  await page.context().clearCookies();

  // The request page answers an address with no account in the same words, and sends nothing.
  const unknown = testEmail("nobody", id);
  await askForReset(page, unknown);
  await expectAccessible(page);
  await askForReset(page, email);

  // The reset link from the email opens the new-password page, past the callback.
  const link = await resetLink(page.request, email);
  expect(new URL(new URL(link).searchParams.get("redirect_to") ?? "").pathname).toBe(
    "/auth/callback",
  );
  expect(await mailsTo(page.request, unknown)).toEqual([]);
  await page.goto(link);
  await page.waitForURL("**/auth/reset-password");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expectAccessible(page);

  // The password rules apply, and the refused field takes focus with its message.
  await page.getByLabel("New password", { exact: true }).fill("short1");
  await page.getByLabel("Confirm new password").fill("short1");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByLabel("New password", { exact: true })).toBeFocused();
  await expect(
    page.getByText("Enter a password of at least 12 characters with letters and numbers."),
  ).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(`${NEW_PASSWORD}x`);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByText("Enter the same password in both fields.")).toBeVisible();
  await expect(page.getByLabel("Confirm new password")).toBeFocused();

  // Typed by keyboard alone.
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").press("Enter");
  await page.waitForURL("**/auth/reset-password?done=1");
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();
  await expectAccessible(page);

  // The other browser is signed out.
  await otherPage.goto(`/${slug}/home`);
  await otherPage.waitForURL("**/auth/sign-in**");
  await other.close();

  // The link works once.
  await page.context().clearCookies();
  await page.goto(link);
  await page.waitForURL("**/auth/sign-in?**");
  await expect(page.getByText("This link expired or was already used.")).toBeVisible();

  // The old password no longer signs in; the new one does.
  await signInWithPassword(page, email, PASSWORD);
  await expect(
    page.getByText("That email and password do not match.", { exact: false }),
  ).toBeVisible();
  await signInWithPassword(page, email, NEW_PASSWORD);
  await page.waitForURL(`**/${slug}/home`);

  // The new-password page refuses a session that did not come from a reset link.
  await page.goto("/auth/reset-password");
  await expect(
    page.getByRole("heading", { name: "This reset link no longer works" }),
  ).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
});

test("a reset of an account with a second factor asks for it before the new password", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `reset2fa-${id}`;
  const email = testEmail("reset2fa", id);
  await signUp(page, { name: "Tad Twofactor", email });
  await createOrganization(page, { name: `Reset Two ${id}`, slug });
  await page.goto(`/${slug}/me/security`);
  const factors = page.getByRole("region", { name: "Two-step verification" });
  await factors.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = await enrollAuthenticator(factors, "Work phone");
  await expect(factors.getByRole("list", { name: "Two-step verification" })).toContainText(
    "Work phone",
  );

  await page.context().clearCookies();
  await askForReset(page, email);
  await page.goto(await resetLink(page.request, email));

  // The reset link signs in at the first factor only: the second comes first, then the new password.
  await page.waitForURL("**/auth/mfa?**");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/auth/reset-password");
  await page.goto("/auth/reset-password");
  await page.waitForURL("**/auth/mfa?**");
  await page.getByLabel("Code", { exact: true }).fill(totp(secret, 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL("**/auth/reset-password");
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();

  // The new password still asks for the second factor at sign-in.
  await page.context().clearCookies();
  await signInWithPassword(page, email, NEW_PASSWORD);
  await page.waitForURL("**/auth/mfa?**");
});
