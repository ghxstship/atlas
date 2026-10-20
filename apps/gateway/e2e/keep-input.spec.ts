import { expect, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * Input kept after refusal on Gateway. React 19 resets a form after its action finishes; every
 * Gateway form submits through keepInputOnSubmit (packages/testing form audit), so a refused save
 * leaves what the person typed in place.
 */
test.use({ reducedMotion: "reduce" });

test("input kept after refusal: sign in with a wrong password keeps the email", async ({
  page,
}) => {
  await page.goto("/auth/sign-in?next=%2Fhome");
  const email = page.locator("#signin-email");
  await email.fill("crew@example.com");
  // The password field appears on request: the sign-in link is the first choice (A59-025).
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signin-password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ }).first()).toBeVisible();
  await expect(email).toHaveValue("crew@example.com");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expectAccessible(page);
});
