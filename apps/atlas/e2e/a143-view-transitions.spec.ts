import type { Page } from "@playwright/test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expect, settle, test } from "./engine-test";

/**
 * A143 route view transitions (Section 11.7, ADR 0118, RRR-206): a client navigation inside the shell
 * fades the page that leaves and the page that arrives through the View Transitions API, and under
 * reduced motion no transition runs. The page records each view transition React starts and the
 * animations running on its pseudo-elements once it is ready, so the journey reads what the browser
 * animated rather than what the CSS says.
 */
test.describe.configure({ timeout: 120_000 });

interface Recorded {
  /** Durations in ms of the animations on ::view-transition-* pseudo-elements. */
  animations: number[];
}

async function recordViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Recorded[] = [];
    Object.assign(window, { __xosViewTransitions: log });
    const start = Document.prototype.startViewTransition as
      ((this: Document, ...args: unknown[]) => ViewTransition) | undefined;
    if (typeof start !== "function") return;
    Document.prototype.startViewTransition = function (this: Document, ...args: unknown[]) {
      const transition = start.apply(this, args);
      const entry: Recorded = { animations: [] };
      log.push(entry);
      transition.ready.then(
        () => {
          entry.animations = document
            .getAnimations()
            .filter((a) =>
              ((a.effect as KeyframeEffect | null)?.pseudoElement ?? "").startsWith(
                "::view-transition",
              ),
            )
            .map((a) => Number(a.effect?.getComputedTiming().duration ?? 0));
        },
        () => undefined,
      );
      return transition;
    } as typeof Document.prototype.startViewTransition;
  });
}

const recorded = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __xosViewTransitions: Recorded[] }).__xosViewTransitions,
  );

/** Home, then Projects from the sidebar: a client navigation to another section of the shell. */
async function homeToProjects(page: Page): Promise<void> {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await settle(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  await page.waitForURL(`**/${DEMO_ORG}/projects**`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test("a navigation inside the shell fades between the pages", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await recordViewTransitions(page);
  await page.goto("/auth/sign-in");
  const supported = await page.evaluate(() => typeof document.startViewTransition === "function");
  test.skip(!supported, "This engine has no View Transitions API; the page swaps as before.");
  await homeToProjects(page);
  await expect
    .poll(async () => (await recorded(page)).some((t) => t.animations.some((ms) => ms > 0)))
    .toBe(true);
});

test("under reduced motion no transition runs and the page swaps at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await recordViewTransitions(page);
  await homeToProjects(page);
  // Let any transition the navigation started reach ready before reading the record.
  await page.waitForTimeout(500);
  const transitions = await recorded(page);
  if (await page.evaluate(() => typeof document.startViewTransition === "function")) {
    // The navigation did go through a view transition, so the check below reads a real one.
    expect(transitions.length).toBeGreaterThan(0);
  }
  // React still starts a view transition and pins the root's size with a zero-length animation of
  // its own; nothing on screen moves or fades, so no animation may take any time.
  expect(transitions.flatMap((t) => t.animations).filter((ms) => ms > 0)).toEqual([]);
});
