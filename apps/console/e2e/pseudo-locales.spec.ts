import { SUPPORT_AREAS } from "@xos/data/console";
import { fillRoute, flattenRoutes } from "@xos/ia";
import {
  databaseText,
  PSEUDO_VIEWPORTS,
  pseudoProblems,
  withText,
  type KnownText,
  type PseudoLocale,
} from "@xos/testing/pseudo";
import { expect, test, type Page } from "@playwright/test";
import { sitemap } from "../ia/sitemap.generated";
import { DEMO, newOperator, passwordSignIn, reportedListing, sql, totp } from "./support";

/**
 * Gate 16 (Section 15) on every operator console route, on next dev:
 *   en-XA  every string a person sees came from a catalog: nothing hard-coded, no raw key
 *   both   no text is cut off by its box without a title or tooltip carrying all of it, at 1280 px
 *          and 375 px (en-XA pads each message by 40 percent; ar-XB lays the page right to left)
 * An Administrator sees every sitemap node, so one fresh Administrator visits them all, with the
 * demo org, an open support session (each of its areas) and a reported listing filling the params;
 * the sign-in and second factor pages are checked on the way in. The checks are shared with the
 * other shells (packages/testing/src/pseudo.ts). Pseudo-locales exist only in development builds, so
 * a run against a production build (E2E_PRODUCTION_BUILD=1) skips; CI runs this in the pseudo-locale
 * job.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(600_000);

const LOCALES: readonly PseudoLocale[] = ["en-XA", "ar-XB"];

const DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";

test.beforeEach(({ browserName }) => {
  test.skip(
    process.env["E2E_PRODUCTION_BUILD"] === "1",
    "the pseudo-locales are offered only by development builds",
  );
  test.skip(browserName !== "chromium", "pseudo-locale checks run in Chromium");
});

/** The problems of the page at `path` (the current page when null) in each pseudo-locale. */
async function check(
  page: Page,
  baseURL: string,
  path: string | null,
  data: KnownText,
): Promise<string[]> {
  const problems: string[] = [];
  for (const locale of LOCALES) {
    await page.context().addCookies([{ name: "xos-locale", value: locale, url: baseURL }]);
    await page.setViewportSize(PSEUDO_VIEWPORTS[0]);
    const response = path === null ? await page.reload() : await page.goto(path);
    const status = response?.status() ?? 0;
    if (status !== 200) problems.push(`${locale} status: ${page.url()} answered ${status}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const at = new URL(page.url()).pathname;
    for (const line of await pseudoProblems(page, { locale, data })) {
      problems.push(`${at}: ${line}`);
    }
  }
  await page.context().clearCookies({ name: "xos-locale" });
  return problems;
}

test("every console route shows no hard-coded or clipped string", async ({ page, baseURL }) => {
  const base = baseURL ?? "";
  const problems: string[] = [];

  // Rows the routes need, written before the data is read so their text counts as data.
  await sql(
    `update app.support_sessions set ended_at = now(), ended_by = $2
      where org_id = $1 and grantee = 'Platform' and ended_at is null and ends_at > now()`,
    [DEMO.org, DEMO.owner],
  );
  const [session] = await sql<{ id: string }>(
    `select app.grant_platform_support_session($1, 2, 'Imports of the crew list fail; please check our settings.') as id`,
    [DEMO.org],
    DEMO.owner,
  );
  const listing = await reportedListing();
  const email = await newOperator("Administrator", "Ada Administrator");
  const data = withText(await databaseText(DATABASE_URL), [listing.title, email]);

  problems.push(...(await check(page, base, "/auth/sign-in", data)));

  // Sign in in en-US, check the second factor page as it first appears, then set up the
  // authenticator app (as signInOperator does) to reach the console.
  await passwordSignIn(page, email);
  await page.waitForURL("**/auth/second-factor**");
  problems.push(...(await check(page, base, null, data)));
  await page.reload();
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = ((await page.getByTestId("setup-key").textContent()) ?? "").trim();
  await page.getByLabel("Code", { exact: true }).fill(totp(secret));
  await page.getByRole("button", { name: "Verify and turn on" }).click();
  await page.waitForURL((url) => url.pathname === "/tenants");

  const params: Readonly<Record<string, string>> = {
    orgId: DEMO.org,
    sessionId: session?.id as string,
    opportunityId: listing.id,
  };
  const paths = flattenRoutes(sitemap).flatMap((r) => {
    const path = fillRoute(r.route, params);
    return r.id === "support.session" ? SUPPORT_AREAS.map((a) => `${path}?area=${a}`) : [path];
  });
  for (const path of [...paths, "/tenants?q=owner%40example.com"]) {
    problems.push(...(await check(page, base, path, data)));
  }
  expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
});
