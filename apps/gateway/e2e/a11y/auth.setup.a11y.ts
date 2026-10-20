import { test } from "@playwright/test";
import { DEMO_PASSWORD, PEOPLE, storageStatePath } from "./roles";

/** Signs in once per external person and saves the session for the sweep. */
for (const { person, email } of PEOPLE) {
  test(`sign in as ${person}`, async ({ page }) => {
    await page.goto(`/auth/sign-in?next=${encodeURIComponent("/home")}`);
    await page.locator("#signin-email").fill(email);
    // The password field appears on request: the sign-in link is the first choice (A59-025).
    await page.getByRole("button", { name: "Use a password" }).click();
    await page.locator("#signin-password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await page.waitForURL((url) => url.pathname === "/home", { timeout: 30_000 });
    await page.context().storageState({ path: storageStatePath(person) });
  });
}
