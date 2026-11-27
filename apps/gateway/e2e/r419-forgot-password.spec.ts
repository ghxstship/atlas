import { expect as baseExpect, test, type APIRequestContext } from "./engine-test";
import { expectAccessible, uniqueId } from "./support";
import { enrollAuthenticator, totp } from "./totp";

/**
 * Forgot password in Gateway (release 4.19, owner decision of 2026-11-27; lib/auth/recovery.ts). Gateway has its own
 * password sign-in, so it has its own reset path: Forgot password? sits under the password field, the request answers
 * the same for any address, and the recovery email (read from the local stack's Mailpit, E2E_INBUCKET_URL) opens
 * Choose a new password. Gateway's proxy guards only sitemap routes, so the reset page itself sends a person who
 * holds a second factor to verify it first.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

function mailpit(): string {
  const inbox = process.env["E2E_INBUCKET_URL"];
  if (!inbox) throw new Error("Set E2E_INBUCKET_URL to the local stack's Mailpit.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(inbox)) throw new Error("Local stack only.");
  return inbox;
}

async function resetLink(request: APIRequestContext, to: string): Promise<string> {
  let id = "";
  await expect(async () => {
    const found = (await (
      await request.get(`${mailpit()}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
    ).json()) as { messages?: { ID: string; Subject: string }[] };
    id = found.messages?.find((m) => m.Subject === "Reset your XOS password")?.ID ?? "";
    expect(id).not.toBe("");
  }).toPass({ timeout: 30_000 });
  const message = (await (await request.get(`${mailpit()}/api/v1/message/${id}`)).json()) as {
    HTML: string;
  };
  const href = /<a href="([^"]+\/auth\/v1\/verify[^"]+)"/.exec(message.HTML)?.[1];
  if (!href) throw new Error("The recovery email has no reset link.");
  return href.replace(/&amp;/g, "&");
}

test("a forgotten Gateway password, on an account with an authenticator app", async ({ page }) => {
  const id = uniqueId();
  const email = `r419-gw-reset-${id}@example.com`;
  const password = `Gw-${uniqueId()}-Ladder-48`;
  const replacement = `Gw-${uniqueId()}-Harbor-71`;
  await page.goto("/auth/sign-up");
  await page.locator("#signup-name").fill("Reese Reset");
  await page.locator("#signup-email").fill(email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signup-password").fill(password);
  await page.locator("#signup-terms").check();
  await page.locator("#signup-age").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname === "/home");
  await page.goto("/settings/security");
  const factors = page.getByRole("region", { name: "Two-step verification" });
  await factors.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = await enrollAuthenticator(factors, "Gateway phone");
  await expect(factors.getByRole("list", { name: "Two-step verification" })).toContainText(
    "Gateway phone",
  );

  // Forgot password? sits under the password field.
  await page.context().clearCookies();
  await page.goto("/auth/sign-in");
  await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveCount(0);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.waitForURL("**/auth/forgot-password");
  await expectAccessible(page);

  // An unknown address reads the same sentence as a known one.
  const unknown = `r419-gw-nobody-${id}@example.com`;
  for (const address of [unknown, email]) {
    await page.getByLabel("Email", { exact: true }).fill(address);
    await page.getByRole("button", { name: "Email me a reset link" }).click();
    await expect(
      page.getByText(`If an account uses ${address}, a reset link is on its way.`, {
        exact: false,
      }),
    ).toBeVisible();
  }
  await expectAccessible(page);

  // The link signs in at the first factor only: the page sends the person to verify the second before the form.
  await page.goto(await resetLink(page.request, email));
  await page.waitForURL("**/auth/mfa?**");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/auth/reset-password");
  await page.getByLabel("Code", { exact: true }).fill(totp(secret, 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL("**/auth/reset-password");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("New password", { exact: true }).fill(replacement);
  await page.getByLabel("Confirm new password").fill(replacement);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();

  // The new password signs in, and the second factor is still asked for.
  await page.context().clearCookies();
  await page.goto("/auth/sign-in?next=%2Fhome");
  await page.locator("#signin-email").fill(email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signin-password").fill(replacement);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL("**/auth/mfa?**");
});
