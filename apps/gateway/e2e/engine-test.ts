import { test as base, type Browser, type Page } from "@playwright/test";

export * from "@playwright/test";

/** Navigation errors Firefox and WebKit raise when a goto lands on Next's post-action refresh. */
const INTERRUPTED = /NS_BINDING_ABORTED|interrupted by another navigation|frame was detached/;

/**
 * Makes `page.goto` the same in every engine (finding A24-008). A server action ends with Next
 * refreshing the route; Chromium lets a following `page.goto` win, while Firefox aborts it
 * (NS_BINDING_ABORTED) and WebKit reports it interrupted. The patched `goto` first lets the page go
 * quiet, then navigates, and repeats the navigation once if that refresh still cut it off. Any
 * other navigation error is thrown as before. Use it on pages from extra browser contexts.
 */
export function settledGoto(page: Page): Page {
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    await page.waitForLoadState("networkidle");
    try {
      return await goto(url, options);
    } catch (error) {
      if (!INTERRUPTED.test(String(error))) throw error;
      await page.waitForLoadState("networkidle");
      return goto(url, options);
    }
  };
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
