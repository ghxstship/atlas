import { test } from "@playwright/test";
import { DEMO_PASSWORD } from "../support";
import { PERSON, STORAGE_STATE } from "./screens";

/** Signs in once as the seeded crew member and saves the session for the core screens. */
test(`sign in as ${PERSON.name}`, async ({ page }) => {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent("/home")}`);
  await page.locator("#signin-email").fill(PERSON.email);
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 60_000 });
  await page.context().storageState({ path: STORAGE_STATE });
});
