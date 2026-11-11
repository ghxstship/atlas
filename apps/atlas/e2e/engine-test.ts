import {
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";

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

/** The router's requests in flight on each page: RSC fetches and server actions. */
const routerRequests = new WeakMap<Page, Set<Request>>();

/** Whether a request is Next's router at work: an RSC fetch (a navigation, a refresh, a prefetch) or a server action. */
function isRouterRequest(request: Request): boolean {
  const headers = request.headers();
  return headers["rsc"] === "1" || headers["next-action"] !== undefined;
}

/** Starts counting a page's router requests, once per page. */
function trackRouter(page: Page): Set<Request> {
  const known = routerRequests.get(page);
  if (known) return known;
  const inFlight = new Set<Request>();
  routerRequests.set(page, inFlight);
  page.on("request", (request) => {
    if (isRouterRequest(request)) inFlight.add(request);
  });
  const done = (request: Request) => inFlight.delete(request);
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return inFlight;
}

/**
 * Waits, at most five seconds, until no RSC fetch or server action of Next's router is in flight.
 * When the browser cancels one of them, Next 16 falls back to a browser navigation to that fetch's
 * URL ("Failed to fetch RSC payload ... Falling back to browser navigation"): it only skips that
 * on `pagehide`. Chromium cancels the page's fetches when the old page unloads, so the fallback
 * goes nowhere; Firefox and WebKit cancel them as soon as a new navigation starts, while the old
 * page still runs, and its fallback then aborts the navigation (NS_BINDING_ABORTED) or interrupts
 * it, and a retried navigation aborts the next fallback in turn (nightly run 42927680948).
 */
export async function routerIdle(page: Page): Promise<void> {
  const inFlight = trackRouter(page);
  // A click resolves once it is dispatched; a frame later the server action or navigation it starts has sent its
  // request, and that request's event reaches this process before the evaluation's answer does.
  await page
    .evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0))))
    .catch(() => undefined);
  const until = Date.now() + QUIET_MS;
  while (inFlight.size > 0 && Date.now() < until && !page.isClosed()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The pages already patched, so a page reached twice (its context's `page` event and a spec) is patched once. */
const patched = new WeakSet<Page>();

/**
 * Makes `page.goto` and `page.reload` the same in every engine (finding A24-008). Firefox and
 * WebKit let a fallback navigation of Next's router cut a navigation off (see `routerIdle`); the
 * patched calls first let the page go quiet and the router finish, then navigate, and try again (up
 * to three times, once the page has loaded) while one still cuts them off. Any other navigation
 * error is thrown as before. In WebKit, `ControlOrMeta` is Meta (see `appleKeys`). Use it on pages
 * of extra contexts.
 */
export function settledGoto(page: Page): Page {
  if (patched.has(page)) return page;
  patched.add(page);
  trackRouter(page);
  appleKeys(page);
  const settled = async <T>(navigate: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      await settle(page);
      await routerIdle(page);
      try {
        return await navigate();
      } catch (error) {
        if (attempt >= ATTEMPTS || !INTERRUPTED.test(String(error))) throw error;
        await page.waitForLoadState("load").catch(() => undefined);
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
 * In WebKit, `ControlOrMeta` presses Meta. The WebKit projects stand for Safari on macOS, iOS and
 * iPadOS (their devices send an Apple user agent), so the app reads Command as the primary modifier
 * there and Control+K as a different chord (packages/schemas/src/shortcuts/keys.ts). Playwright
 * resolves `ControlOrMeta` by the host instead, Control on the Linux runners, and every WebKit
 * shortcut journey missed its shortcut in CI while passing on a Mac (nightly run 42927680948).
 * Playwright's WebKit applies the macOS editing commands to Meta chords on every host, so Meta+A
 * still selects all.
 */
function appleKeys(page: Page): void {
  if (page.context().browser()?.browserType().name() !== "webkit") return;
  const meta = (key: string) => key.replace(/\bControlOrMeta\b/g, "Meta");
  const keyboard = page.keyboard;
  const press = keyboard.press.bind(keyboard);
  keyboard.press = (key, options) => press(meta(key), options);
  const down = keyboard.down.bind(keyboard);
  keyboard.down = (key) => down(meta(key));
  const up = keyboard.up.bind(keyboard);
  keyboard.up = (key) => up(meta(key));
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
