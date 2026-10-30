import { UPL_FIELDS } from "@xos/data/finance";
import {
  PSEUDO_VIEWPORTS,
  navigationStatus,
  pseudoProblems,
  withText,
  type PseudoLocale,
} from "@xos/testing/pseudo";
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "./engine-test";
import { activeRoles, DEMO_ORG, DEMO_PASSWORD, type SweepRole } from "./a11y/roles";
import {
  NETWORK_RESTRICTED,
  PUBLIC_PAGES,
  noAccess,
  sweepRoutesFor,
  visibleOnPhone,
} from "./a11y/routes";
import { LEGAL_DOCUMENTS } from "../lib/legal.generated";
import { databaseText } from "./pseudo-checks";

/**
 * Gate 16 (Section 15) on every Atlas route the A23 sweep visits, for each demo role it signs in as
 * (e2e/a11y/routes.ts), plus the public pages and the network-restricted page, on next dev:
 *   en-XA  every string a person sees came from a catalog: nothing hard-coded, no raw key
 *   both   no text is cut off by its box without a title or tooltip carrying all of it, at 1280 px
 *          and, for pages a phone gets, 375 px (en-XA pads each message by 40 percent; ar-XB lays
 *          the page right to left)
 * The core-screen suite (pseudo-locales.spec.ts) stays as it is; this one shares its checks
 * (packages/testing/src/pseudo.ts). Pseudo-locales exist only in development builds, so a run
 * against a production build (E2E_PRODUCTION_BUILD=1) skips; CI runs this in the pseudo-locale job.
 * A11Y_ROLES limits the roles, as for the sweep.
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

/** One signed-in session per role and worker, made in a context of its own (en-US, no cookie). */
const sessions = new Map<SweepRole, Promise<Session>>();

function sessionFor(browser: Browser, baseURL: string, role: SweepRole, email: string) {
  let session = sessions.get(role);
  if (!session) {
    session = (async () => {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${DEMO_ORG}/home`)}`, {
        timeout: 120_000,
      });
      await page.locator("#signin-email").fill(email);
      await page.locator("#signin-password").fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign in with password" }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), {
        timeout: 60_000,
      });
      const state = await context.storageState();
      await context.close();
      return state;
    })();
    sessions.set(role, session);
    // A failed sign-in (a slow first compile) is tried again by the next test, not cached.
    session.catch(() => sessions.delete(role));
  }
  return session;
}

/**
 * Opens a page in each pseudo-locale and gathers its problems. A route whose seeded row the role
 * cannot see answers 404 (routes.ts) and is skipped; any other status but 200 is a problem.
 */
async function check(
  page: Page,
  baseURL: string,
  path: string,
  options: { readonly phone: boolean; readonly noAccess?: (status: number) => boolean },
): Promise<string[]> {
  const data = withText(
    await databaseText(),
    // Legal documents are published in English only (legal/index.yaml); their titles are content.
    LEGAL_DOCUMENTS.map((d) => d.title),
    // The Universal Posting Line preview heads its columns with the file's own column names.
    { asWritten: UPL_FIELDS },
  );
  const problems: string[] = [];
  for (const locale of LOCALES) {
    await page.context().addCookies([{ name: "xos-locale", value: locale, url: baseURL }]);
    await page.setViewportSize(PSEUDO_VIEWPORTS[0]);
    const response = await page.goto(path);
    const status = await navigationStatus(page, response);
    if (options.noAccess?.(status)) {
      test.info().annotations.push({ type: "no-access", description: `${path} answered 404` });
      test.skip();
    }
    if (status !== 200) problems.push(`${locale} status: ${path} answered ${status}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const viewports = options.phone ? PSEUDO_VIEWPORTS : PSEUDO_VIEWPORTS.slice(0, 1);
    problems.push(...(await pseudoProblems(page, { locale, data, viewports })));
  }
  return problems;
}

for (const { role, email } of activeRoles()) {
  test.describe(role, () => {
    test.use({
      storageState: async ({ browser, baseURL }, provide) =>
        provide(await sessionFor(browser, baseURL ?? "", role, email)),
    });

    for (const { route, path } of sweepRoutesFor(role)) {
      test(`${route.id} ${path}`, async ({ page, baseURL }) => {
        const problems = await check(page, baseURL ?? "", path, {
          phone: visibleOnPhone(route, role),
          noAccess: (status) => noAccess(route, status),
        });
        expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
      });
    }

    if (NETWORK_RESTRICTED.roles.includes(role)) {
      test(`network-restricted ${NETWORK_RESTRICTED.path}`, async ({ page, baseURL }) => {
        const problems = await check(page, baseURL ?? "", NETWORK_RESTRICTED.path, {
          phone: true,
        });
        expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
      });
    }
  });
}

test.describe("anonymous", () => {
  for (const path of PUBLIC_PAGES) {
    test(`public ${path}`, async ({ page, baseURL }) => {
      const problems = await check(page, baseURL ?? "", path, { phone: true });
      expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
    });
  }
});
