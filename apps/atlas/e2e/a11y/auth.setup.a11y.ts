import { test } from "@playwright/test";
import { activeRoles, DEMO_ORG, DEMO_PASSWORD, storageStatePath } from "./roles";

/** Signs in once per role and saves the session for the sweep. */
for (const { role, email } of activeRoles()) {
  test(`sign in as ${role}`, async ({ page }) => {
    await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${DEMO_ORG}/home`)}`);
    await page.locator("#signin-email").fill(email);
    await page.locator("#signin-password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 30_000 });
    await page.context().storageState({ path: storageStatePath(role) });
  });
}
