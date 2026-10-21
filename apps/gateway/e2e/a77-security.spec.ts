import { expect as baseExpect, test } from "./engine-test";
import { expectAccessible, uniqueId } from "./support";
import { enrollAuthenticator, totp } from "./totp";

/**
 * A77 (RRR-122, Section 9): in Gateway, a person sets up an authenticator app on Settings, Security, and the next
 * sign-in asks for its code before any page. The account is the one Atlas and Compass use, so the same factor
 * guards all three. A fresh account each run; the secret exists only for the run.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(150_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("an authenticator app set up in Gateway is asked for at the next sign-in", async ({
  page,
}) => {
  const email = `a77-gw-${uniqueId()}@example.com`;
  const password = `Gw-${uniqueId()}-Ladder-48`;
  await page.goto("/auth/sign-up");
  await page.locator("#signup-name").fill("Gale Gateway");
  await page.locator("#signup-email").fill(email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signup-password").fill(password);
  await page.locator("#signup-terms").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname === "/home");

  await page.goto("/settings/security");
  const factors = page.getByRole("region", { name: "Two-step verification" });
  await expect(factors.getByText("No second factor yet.")).toBeVisible();
  await expectAccessible(page);
  await factors.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = await enrollAuthenticator(factors, "Gateway phone");
  await expect(factors.getByRole("list", { name: "Two-step verification" })).toContainText(
    "Gateway phone",
  );

  await page.context().clearCookies();
  await page.goto("/auth/sign-in?next=%2Fhome");
  await page.locator("#signin-email").fill(email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signin-password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL("**/auth/mfa?**");
  await expect(page.getByRole("heading", { name: "Verify it's you" })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Code", { exact: true }).fill(totp(secret, 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((url) => url.pathname === "/home");
});
