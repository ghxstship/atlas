import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  acknowledgmentBudgetMs,
  describeTiming,
  latencyOf,
  probeHolds,
  type InteractionTiming,
  type VisibleProbe,
} from "./interaction.ts";
import { installWatch } from "./watch.ts";

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
export function countInteractions(page: Page): {
  readonly count: () => number;
  /** The pointer presses alone, so a keyboard-only journey can show it made none. */
  readonly pointers: () => number;
} {
  let total = 0;
  let pointers = 0;
  const bump = (kind: string) => {
    total += 1;
    if (kind === "pointerdown") pointers += 1;
  };
  void page.exposeFunction("__xosInteraction", bump);
  void page.addInitScript(() => {
    // Runs in the browser; typed loosely because this package compiles without the DOM library.
    const win = globalThis as unknown as {
      __xosInteraction?: (kind: string) => void;
      addEventListener: (
        type: string,
        listener: (e: { type: string }) => void,
        options: object,
      ) => void;
    };
    const report = (e: { type: string }) => win.__xosInteraction?.(e.type);
    win.addEventListener("pointerdown", report, { capture: true });
    win.addEventListener("keydown", report, { capture: true });
  });
  return { count: () => total, pointers: () => pointers };
}

/** Numbers each watch, so several on one page keep their own state. */
let watches = 0;

export interface WatchOptions {
  /** Count the state only after the next pointer or key press (the default), or from the moment the watch begins. */
  readonly afterInput?: boolean;
  /**
   * Count the state only once this other state has held, in place of `afterInput`: a watch for a state that holds
   * now, such as a label coming back, can then start before the action.
   */
  readonly after?: VisibleProbe;
  /** How long to wait for the state; ten seconds by default. */
  readonly timeout?: number;
}

/**
 * Starts watching `page` for `probe` and returns a function that waits for it and answers when it was seen (and,
 * after input or after the `after` state, when that came), in epoch milliseconds, comparable across pages and
 * browser contexts. The state the watch starts from (`after`, or else `probe`) must not hold yet: a watch that would
 * pass before anything happens fails at once. Several watches can run on one page at once.
 */
export async function watchFor(
  page: Page,
  probe: VisibleProbe,
  options: WatchOptions = {},
): Promise<() => Promise<InteractionTiming>> {
  const afterInput = options.afterInput ?? true;
  const after = options.after ?? null;
  watches += 1;
  const id = `w${watches}`;
  // The watcher and the probe go to the browser as source, the probe's function unchanged (it refers to nothing
  // outside itself), so the browser runs exactly what the unit tests check.
  const before = await page.evaluate<boolean>(
    `(${installWatch.toString()})(${JSON.stringify(id)}, ${JSON.stringify(probe)}, ${afterInput}, ${JSON.stringify(after)}, ${probeHolds.toString()})`,
  );
  expect(before, `${JSON.stringify(after ?? probe)} already holds before the action`).toBe(false);
  return async () => {
    type Watches = { __xosWatches?: Record<string, { inputAt: number | null; seenAt: number }> };
    await page.waitForFunction(
      (key) => {
        const state = (globalThis as unknown as Watches).__xosWatches?.[key];
        return state !== undefined && state.seenAt !== null;
      },
      id,
      { timeout: options.timeout ?? 10_000 },
    );
    return page.evaluate((key) => {
      const state = (globalThis as unknown as Watches).__xosWatches?.[key];
      return { inputAt: state?.inputAt ?? null, seenAt: state?.seenAt ?? 0 };
    }, id);
  };
}

/** Milliseconds from the pointer or key press `act` makes to the moment `probe` holds on screen. */
export async function measureAcknowledgment(
  page: Page,
  act: () => Promise<unknown>,
  probe: VisibleProbe,
  options: Omit<WatchOptions, "afterInput"> = {},
): Promise<number> {
  const seen = await watchFor(page, probe, options);
  await act();
  return latencyOf(await seen());
}

/**
 * Asserts that `act` shows `probe` within the budget, 100 ms by default (Section 11.10 rule 9: every action
 * acknowledges within 100 ms). The measure is kept on the test as a `latency` annotation. Returns it.
 */
export async function expectAcknowledged(
  page: Page,
  label: string,
  act: () => Promise<unknown>,
  probe: VisibleProbe,
  budgetMs: number = acknowledgmentBudgetMs,
): Promise<number> {
  const elapsed = await measureAcknowledgment(page, act, probe);
  const sentence = describeTiming(label, elapsed, budgetMs);
  test.info().annotations.push({ type: "latency", description: sentence });
  expect(elapsed, sentence).toBeLessThanOrEqual(budgetMs);
  return elapsed;
}

/** Asserts a measured span against its budget and keeps it on the test as a `latency` annotation. */
export function expectWithin(label: string, elapsedMs: number, budgetMs: number): void {
  const sentence = describeTiming(label, elapsedMs, budgetMs);
  test.info().annotations.push({ type: "latency", description: sentence });
  expect(elapsedMs, sentence).toBeLessThanOrEqual(budgetMs);
}
