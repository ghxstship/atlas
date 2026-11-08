import { test } from "@playwright/test";
import { DEMO_PASSWORD, PEOPLE, storageStatePath } from "./roles";

/** Signs in once per external person and saves the session for the sweep. */
for (const entry of PEOPLE) {
  const { person, email } = entry;
  test(`sign in as ${person}`, async ({ page }) => {
    await page.goto(`/auth/sign-in?next=${encodeURIComponent("/home")}`);
    await page.locator("#signin-email").fill(email);
    // The password field appears on request: the sign-in link is the first choice (A59-025).
    await page.getByRole("button", { name: "Use a password" }).click();
    await page.locator("#signin-password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await page.waitForURL((url) => url.pathname === "/home", { timeout: 30_000 });
    // A person swept at an account standing acts for that account, as its own switcher would set.
    if ("account" in entry) {
      await page
        .context()
        .addCookies([
          { name: "xos-acting", value: entry.account, url: new URL(page.url()).origin },
        ]);
    }
    await page.context().storageState({ path: storageStatePath(person) });
  });
}
