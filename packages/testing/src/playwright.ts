import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/** Unique test identities so runs never collide on a shared local stack. */
export function uniqueId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** axe-core on the current page: zero serious or critical findings (Section 18, gate 8). */
export async function expectAccessible(page: Page): Promise<void> {
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

export interface RefusalCase {
  /** The fields to fill, keyed by the locator that finds each one. */
  readonly fields: ReadonlyArray<readonly [Locator, string]>;
  /** The control that submits the form. */
  readonly submit: Locator;
  /** The refusal or error the server answers with. */
  readonly refusal: Locator;
}

/**
 * React 19 resets an uncontrolled form after its action finishes. A refused save must keep what
 * the person typed (collection-kit/keep-input.ts): fill, submit, see the refusal, and find every
 * value still in place.
 */
export async function expectInputKeptAfterRefusal(input: RefusalCase): Promise<void> {
  for (const [field, value] of input.fields) await field.fill(value);
  await input.submit.click();
  await expect(input.refusal).toBeVisible();
  for (const [field, value] of input.fields) await expect(field).toHaveValue(value);
}

/**
 * Counts the clicks, taps and key presses a journey makes, for the interaction budgets of
 * Sections 11.11 to 11.13 (Section 18, gate 26). Wrap the page once and read `count` at the end.
 */
export function countInteractions(page: Page): { readonly count: () => number } {
  let total = 0;
  const bump = () => {
    total += 1;
  };
  void page.exposeFunction("__xosInteraction", bump);
  void page.addInitScript(() => {
    // Runs in the browser; typed loosely because this package compiles without the DOM library.
    const win = globalThis as unknown as {
      __xosInteraction?: () => void;
      addEventListener: (type: string, listener: () => void, options: object) => void;
    };
    const report = () => win.__xosInteraction?.();
    win.addEventListener("pointerdown", report, { capture: true });
    win.addEventListener("keydown", report, { capture: true });
  });
  return { count: () => total };
}
