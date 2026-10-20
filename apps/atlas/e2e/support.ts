import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { settle } from "./engine-test";

/** Unique test identities so runs never collide on the shared local stack. */
export function uniqueId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function testEmail(label: string, id: string): string {
  return `${label}-${id}@atlas-e2e.test`;
}

export const PASSWORD = `E2e-${"passphrase"}-9431`;

/** axe-core on the current page: zero serious or critical findings (Section 18, gate 8). */
export async function expectAccessible(page: Page): Promise<void> {
  // axe measures the resting state; a pointer left on a button after a click would measure its hover
  // colors instead (hover contrast is tracked separately, finding A24-004).
  await page.mouse.move(0, 0);
  // Drawers and dialogs fade in; Firefox runs the fade even under reduced motion, and axe would
  // sample the half-faded colors (finding A24-008). The page goes quiet and paints twice, so a
  // drawer that just mounted has started its fade, and finite animations finish first.
  await settle(page);
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

/** Signs up through the UI with a password; lands wherever `next` sends the new account. */
export async function signUp(page: Page, input: { name: string; email: string; next?: string }) {
  await page.goto(
    input.next ? `/auth/sign-up?next=${encodeURIComponent(input.next)}` : "/auth/sign-up",
  );
  await expectAccessible(page);
  await page.getByLabel(/^Full name$/).fill(input.name);
  await page.locator("#signup-email").fill(input.email);
  await page.locator("#signup-password").fill(PASSWORD);
  await page.getByRole("checkbox", { name: /16 or older/ }).check();
  await page.getByRole("button", { name: "Create account" }).click();
}

/** Creates an org through the UI and waits for its Home. */
export async function createOrganization(page: Page, input: { name: string; slug: string }) {
  await page.waitForURL("**/auth/organization");
  await expectAccessible(page);
  await page.getByLabel("Organization name").fill(input.name);
  await page.getByLabel("Web address").fill(input.slug);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(`**/${input.slug}/home`);
}
