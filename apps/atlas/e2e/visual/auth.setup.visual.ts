import { test } from "@playwright/test";
import { DEMO_ORG, DEMO_PASSWORD } from "../a11y/roles";
import { PEOPLE, storageStatePath } from "./screens";

/** Signs in once per demo person the core screens use and saves the session. */
for (const [person, email] of Object.entries(PEOPLE)) {
  test(`sign in as ${person}`, async ({ page }) => {
    await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${DEMO_ORG}/home`)}`);
    await page.locator("#signin-email").fill(email);
    await page.locator("#signin-password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 60_000 });
    await page.context().storageState({ path: storageStatePath(person) });
  });
}
