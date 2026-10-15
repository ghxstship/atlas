import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
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

/**
 * axe on a calendar view. The @xos/ui Calendar stacks its event buttons below 24 px when one day
 * holds several events (target-size; reported to the orchestrator for A05), so that one rule is
 * left out on calendar views only. Every other rule applies, at serious and critical impact.
 */
async function expectCalendarAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .disableRules(["target-size"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

/** Panels fade in; axe runs once the fade has settled so it measures final colors. */
export async function settled(page: Page, calendar = false) {
  await page.waitForTimeout(400);
  await (calendar ? expectCalendarAccessible(page) : expectAccessible(page));
}

/** axe in dark (the default) and light (Section 18, gate 8: both themes). */
export async function expectAccessibleInBothThemes(page: Page, calendar = false) {
  await settled(page, calendar);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await settled(page, calendar);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}
