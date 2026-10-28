import {
  PSEUDO_VIEWPORTS,
  navigationStatus,
  pseudoProblems,
  withText,
  type PseudoLocale,
} from "@xos/testing/pseudo";
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "./engine-test";
import { DEMO_PASSWORD, PEOPLE } from "./a11y/roles";
import { PUBLIC_PAGES, sweepRoutesFor, type Person } from "./a11y/routes";
import { issueAdvanceLink, issueSigningLink } from "./fixtures";
import { databaseText } from "./pseudo-checks";

/**
 * Gate 16 (Section 15) on every Gateway route the A23 sweep visits, for each external person it
 * signs in as (e2e/a11y/routes.ts), plus the public pages and both token flows, on next dev:
 *   en-XA  every string a person sees came from a catalog: nothing hard-coded, no raw key
 *   both   no text is cut off by its box without a title or tooltip carrying all of it, at 1280 px
 *          and 375 px (en-XA pads each message by 40 percent; ar-XB lays the page right to left)
 * The core-screen suite (pseudo-locales.spec.ts) stays as it is; this one shares its checks
 * (packages/testing/src/pseudo.ts). Pseudo-locales exist only in development builds, so a run
 * against a production build (E2E_PRODUCTION_BUILD=1) skips; CI runs this in the pseudo-locale job.
 */

test.use({ reducedMotion: "reduce" });
// Routes are independent, so `--workers` spreads them; next dev compiles each on its first visit.
test.describe.configure({ mode: "parallel" });
test.setTimeout(240_000);

const LOCALES: readonly PseudoLocale[] = ["en-XA", "ar-XB"];

test.beforeEach(({ browserName }) => {
  test.skip(
    process.env["E2E_PRODUCTION_BUILD"] === "1",
    "the pseudo-locales are offered only by development builds",
  );
  // Text layout is the same check in every engine; one engine keeps the job short.
  test.skip(browserName !== "chromium", "pseudo-locale checks run in Chromium");
});

type Session = Exclude<BrowserContextOptions["storageState"], string | undefined>;

/** One signed-in session per person and worker, made in a context of its own (en-US, no cookie). */
const sessions = new Map<string, Promise<Session>>();

function sessionFor(browser: Browser, baseURL: string, person: Person) {
  let session = sessions.get(person.person);
  if (!session) {
    session = (async () => {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      await page.goto(`/auth/sign-in?next=${encodeURIComponent("/home")}`);
      await page.locator("#signin-email").fill(person.email);
      // The password field appears on request: the sign-in link is the first choice (A59-025).
      await page.getByRole("button", { name: "Use a password" }).click();
      await page.locator("#signin-password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign in with password" }).click();
      await page.waitForURL((url) => url.pathname === "/home", { timeout: 60_000 });
      const state = await context.storageState();
      await context.close();
      return state;
    })();
    sessions.set(person.person, session);
  }
  return session;
}

/** Opens a page in each pseudo-locale and gathers its problems; a status other than 200 is one. */
async function check(
  page: Page,
  baseURL: string,
  path: string,
  written: readonly string[] = [],
): Promise<string[]> {
  const data = withText(await databaseText(), written);
  const problems: string[] = [];
  for (const locale of LOCALES) {
    await page.context().addCookies([
      { name: "xos-locale", value: locale, url: baseURL },
      // An explicit theme, so the System preference never follows the machine the run is on.
      { name: "xos-theme", value: "dark", url: baseURL },
    ]);
    await page.setViewportSize(PSEUDO_VIEWPORTS[0]);
    const response = await page.goto(path);
    const status = await navigationStatus(page, response);
    if (status !== 200) problems.push(`${locale} status: ${path} answered ${status}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    problems.push(...(await pseudoProblems(page, { locale, data })));
  }
  return problems;
}

for (const person of PEOPLE) {
  test.describe(person.person, () => {
    test.use({
      storageState: async ({ browser, baseURL }, provide) =>
        provide(await sessionFor(browser, baseURL ?? "", person)),
    });

    for (const route of sweepRoutesFor(person)) {
      test(`${route.id} ${route.path}`, async ({ page, baseURL }) => {
        const problems = await check(page, baseURL ?? "", route.path);
        expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
      });
    }
  });
}

test.describe("anonymous", () => {
  for (const path of PUBLIC_PAGES) {
    test(`public ${path}`, async ({ page, baseURL }) => {
      const problems = await check(page, baseURL ?? "", path);
      expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
    });
  }

  test("token /sign/{token}", async ({ page, baseURL }) => {
    const link = await issueSigningLink();
    const problems = await check(page, baseURL ?? "", `/sign/${link.token}`, [link.title]);
    expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
  });

  test("token /advance/{token}", async ({ page, baseURL }) => {
    const link = await issueAdvanceLink();
    const problems = await check(page, baseURL ?? "", `/advance/${link.token}`, [link.title]);
    expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
  });
});
