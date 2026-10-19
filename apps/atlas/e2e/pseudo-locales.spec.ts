import { expect, test, type Page } from "./engine-test";
import { signIn } from "./operations-support";
import { describe, hardCodedText, truncatedText } from "./pseudo-checks";
import { PEOPLE, SCREENS, type Person } from "./visual/screens";
import { untilDrawn } from "./visual/stable";

/**
 * Gate 16 (Section 15): the Atlas core screens rendered in the pseudo-locales on next dev.
 *   en-XA  every string a person sees came from a catalog: nothing hard-coded, no raw key
 *   both   no text is cut off by its box without a title or tooltip carrying all of it, at 1280 px
 *          and 375 px (en-XA pads each message by 40 percent; ar-XB lays the page right to left)
 * Pseudo-locales exist only in development builds (i18n/negotiate.ts), so a run against a
 * production build (E2E_PRODUCTION_BUILD=1) skips; CI runs this in the pseudo-locale job.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 375, height: 812 },
] as const;

test.beforeEach(({ browserName }) => {
  test.skip(
    process.env["E2E_PRODUCTION_BUILD"] === "1",
    "the pseudo-locales are offered only by development builds",
  );
  // Text layout is the same check in every engine; one engine keeps the job short.
  test.skip(browserName !== "chromium", "pseudo-locale checks run in Chromium");
});

async function visitAll(
  page: Page,
  locale: "en-XA" | "ar-XB",
  check: (screen: string) => Promise<void>,
) {
  let signedInAs: Person | null = null;
  for (const screen of SCREENS) {
    if (signedInAs !== screen.person) {
      await page.context().clearCookies();
      await signIn(page, PEOPLE[screen.person]);
      signedInAs = screen.person;
    }
    await page.context().addCookies([{ name: "xos-locale", value: locale, url: page.url() }]);
    await page.goto(screen.path);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await untilDrawn(page);
    await check(screen.name);
  }
}

test("en-XA: the core screens show no hard-coded or untranslated string", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const problems: string[] = [];
  await visitAll(page, "en-XA", async (screen) => {
    for (const line of describe(await hardCodedText(page))) problems.push(`${screen}: ${line}`);
  });
  expect(problems, "text outside every en-XA wrap that is not data").toEqual([]);
});

for (const locale of ["en-XA", "ar-XB"] as const) {
  for (const viewport of VIEWPORTS) {
    test(`${locale} at ${viewport.width} px: no core screen cuts text off without a tooltip`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const problems: string[] = [];
      await visitAll(page, locale, async (screen) => {
        for (const line of describe(await truncatedText(page))) {
          problems.push(`${screen}: ${line}`);
        }
      });
      expect(problems, "text clipped by its box with no title or tooltip").toEqual([]);
    });
  }
}
