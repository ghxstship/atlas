import { test as base } from "@playwright/test";

export * from "@playwright/test";

/** Navigation errors Firefox and WebKit raise when a goto lands on Next's post-action refresh. */
const INTERRUPTED = /NS_BINDING_ABORTED|interrupted by another navigation|frame was detached/;

/**
 * The journeys' `test`, the same in every engine (finding A24-008). A server action ends with Next
 * refreshing the route; Chromium lets a following `page.goto` win, while Firefox aborts it
 * (NS_BINDING_ABORTED) and WebKit reports it interrupted. `page.goto` here first lets the page go
 * quiet, then navigates, and repeats the navigation once if that refresh still cut it off. Any
 * other navigation error is thrown as before.
 */
export const test = base.extend({
  page: async ({ page }, provide) => {
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
    await provide(page);
  },
});
