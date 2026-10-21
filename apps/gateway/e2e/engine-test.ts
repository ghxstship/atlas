import { test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";

export * from "@playwright/test";

/** Navigation errors Firefox and WebKit raise when a goto lands on Next's post-action refresh. */
const INTERRUPTED = /NS_BINDING_ABORTED|interrupted by another navigation|frame was detached/;

/** At most this many tries of one navigation that Next's refresh keeps cutting off. */
const ATTEMPTS = 3;

/** How long a page may take to go quiet before a step goes ahead anyway. */
const QUIET_MS = 5_000;

/**
 * Waits for the page to go quiet, but no longer than five seconds: a live page (a show run, a
 * realtime list) keeps a request open and never reaches networkidle, and the step goes ahead.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: QUIET_MS }).catch(() => undefined);
}

/**
 * Makes `page.goto` and `page.reload` the same in every engine (finding A24-008). A server action
 * ends with Next refreshing the route; Chromium lets a following navigation win, while Firefox
 * aborts it (NS_BINDING_ABORTED) and WebKit reports it interrupted. The patched calls first let the
 * page go quiet, then navigate, and try again (up to three times) while that refresh still cuts
 * them off. Any other navigation error is thrown as before. Use it on pages of extra contexts.
 */
export function settledGoto(page: Page): Page {
  const settled = async <T>(navigate: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      await settle(page);
      try {
        return await navigate();
      } catch (error) {
        if (attempt >= ATTEMPTS || !INTERRUPTED.test(String(error))) throw error;
        await page.waitForTimeout(250 * attempt);
      }
    }
  };
  const goto = page.goto.bind(page);
  page.goto = (url, options) => settled(() => goto(url, options));
  const reload = page.reload.bind(page);
  page.reload = (options) => settled(() => reload(options));
  return page;
}

/**
 * The test clock (A71, RRR-116; packages/testing/clock). E2E_CLOCK_OFFSET_MS shifts every browser
 * context's wall clock by the same amount as the database (pg-clock.sh) and the Node processes
 * (node-clock.cjs), so a journey can run at 23:30 in New York or across a month boundary. Time keeps
 * flowing and timers stay real. Unset, the clock is real.
 */
const CLOCK_OFFSET_MS = Number(process.env["E2E_CLOCK_OFFSET_MS"] ?? 0);

/** E2E_TIMEZONE puts every browser context in that zone (playwright.config.ts sets the default one). */
const TIME_ZONE = process.env["E2E_TIMEZONE"];

/** Moves a new context's clock by the test clock offset, measured from the real clock. */
export async function shiftClock(context: BrowserContext): Promise<void> {
  if (!Number.isFinite(CLOCK_OFFSET_MS) || CLOCK_OFFSET_MS === 0) return;
  await context.clock.setSystemTime(performance.timeOrigin + performance.now() + CLOCK_OFFSET_MS);
}

/**
 * The journeys' `test`: its `page`, and every page of a context a spec opens for another person
 * with `browser.newContext`, navigates with `settledGoto`. Both follow the test clock.
 */
export const test = base.extend<{ engineTimeout: undefined }, { browser: Browser }>({
  // WebKit runs the same steps markedly slower (axe on a long page most of all), so its tests get
  // three times the timeout the spec sets.
  engineTimeout: [
    async ({ browserName }, provide, testInfo) => {
      if (browserName === "webkit") testInfo.setTimeout(testInfo.timeout * 3);
      await provide(undefined);
    },
    { auto: true },
  ],
  context: async ({ context }, provide) => {
    await shiftClock(context);
    await provide(context);
  },
  page: async ({ page }, provide) => {
    await provide(settledGoto(page));
  },
  browser: [
    async ({ browser }, provide) => {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(
          TIME_ZONE ? { timezoneId: TIME_ZONE, ...options } : options,
        );
        await shiftClock(context);
        context.on("page", (page) => {
          settledGoto(page);
        });
        return context;
      };
      await provide(browser);
    },
    { scope: "worker" },
  ],
});
