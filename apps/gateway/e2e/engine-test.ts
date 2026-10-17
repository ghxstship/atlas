import { test as base, type Browser, type Page } from "@playwright/test";

export * from "@playwright/test";

/** Navigation errors Firefox and WebKit raise when a goto lands on Next's post-action refresh. */
const INTERRUPTED = /NS_BINDING_ABORTED|interrupted by another navigation|frame was detached/;

/** At most this many tries of one navigation that Next's refresh keeps cutting off. */
const ATTEMPTS = 3;

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
      await page.waitForLoadState("networkidle");
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
 * The journeys' `test`: its `page`, and every page of a context a spec opens for another person
 * with `browser.newContext`, navigates with `settledGoto`.
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
  page: async ({ page }, provide) => {
    await provide(settledGoto(page));
  },
  browser: [
    async ({ browser }, provide) => {
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
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
