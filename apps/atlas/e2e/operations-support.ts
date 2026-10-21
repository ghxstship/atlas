import type { Page } from "@playwright/test";
import { settle } from "./engine-test";
import { expectAccessible } from "./support";

/** Shared helpers for A11's Logistics and Hospitality journeys on the demo tenant seed. */

export const ORG = "demo-productions";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

export async function signIn(page: Page, email: string) {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

/** Panels fade in; axe runs once the fade has settled so it measures final colors. */
export async function settled(page: Page) {
  await page.waitForTimeout(400);
  await expectAccessible(page);
}

/** axe in dark (the default) and light (Section 18, gate 8: both themes). */
export async function expectAccessibleInBothThemes(page: Page) {
  await settled(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await settled(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
  // Leave the page hydrated: callers act next, and a click before hydration is lost (A71, A77).
  await settle(page);
}
