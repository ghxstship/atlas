import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  contentText,
  jsonStrings,
  pseudoProblems,
  PSEUDO_VIEWPORTS,
  type KnownText,
  type PseudoLocale,
} from "@xos/testing/pseudo";

/**
 * Gate 16 (Section 15) on every docs route, on next dev (E2E_NEXT_DEV=1):
 *   en-XA  every string outside the content came from the `docs`, `help` or `ui` catalogs: nothing
 *          hard-coded, no raw key
 *   both   no text is cut off by its box without a title or tooltip carrying all of it, at 1280 px
 *          and 375 px (en-XA pads each message by 40 percent; ar-XB lays the page right to left)
 * Each route template is visited with seeded instances that differ in shape (a table and a view, a
 * list and a create operation), and every developer guide in full. A pseudo-locale renders the en-US
 * Markdown and reference data: article bodies, the OpenAPI document and the data dictionary are
 * content, translated per locale as files, so their text is known content rather than a finding.
 * Production builds serve no pseudo-locale (lib/i18n.ts), so the suite skips against one.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

const LOCALES: readonly PseudoLocale[] = ["en-XA", "ar-XB"];

test.beforeEach(({ browserName }) => {
  test.skip(
    process.env["E2E_NEXT_DEV"] !== "1",
    "the pseudo-locales are served only by next dev (E2E_NEXT_DEV=1)",
  );
  test.skip(browserName !== "chromium", "pseudo-locale checks run in Chromium");
});

const APP = process.cwd().endsWith(join("apps", "docs"))
  ? process.cwd()
  : join(process.cwd(), "apps", "docs");

function files(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(extension))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

/** The en-US sources a pseudo-locale page renders: Markdown, the OpenAPI document, the dictionary. */
function content(): KnownText {
  const json = (file: string) => jsonStrings(JSON.parse(readFileSync(file, "utf8")));
  return contentText([
    ...files(join(APP, "content", "guides", "en-US"), ".md"),
    ...["atlas", "gateway", "compass"].flatMap((shell) =>
      files(join(APP, "..", shell, "help", "articles", "en-US"), ".md"),
    ),
    ...json(join(APP, "..", "..", "packages", "api", "openapi", "v1.json")),
    ...json(join(APP, "content", "data-dictionary.json")),
  ]);
}

const GUIDES = readdirSync(join(APP, "content", "guides", "en-US"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => `/guides/${f.slice(0, -3)}`);

/** Every route template, by path under the locale prefix. */
const PATHS = [
  "",
  ...GUIDES,
  "/reference",
  "/reference/projects",
  "/reference/purchase-orders",
  "/reference/projects/list",
  "/reference/purchase-orders/create",
  "/data-dictionary",
  "/data-dictionary/app.time_entries",
  "/data-dictionary/xpms.dim_department",
  "/help",
  "/help?q=gate",
  "/help?q=zzzz",
  "/help/gates",
  "/help/gateway/engagement-invoices",
  "/help/compass/today",
  "/does-not-exist",
];

const data = content();

for (const path of PATHS) {
  test(`${path || "/"}`, async ({ page }) => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      await page.setViewportSize(PSEUDO_VIEWPORTS[0]);
      const response = await page.goto(`/${locale}${path}`);
      const expected = path === "/does-not-exist" ? 404 : 200;
      const status = response?.status() ?? 0;
      if (status !== expected) problems.push(`${locale} status: ${path} answered ${status}`);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      problems.push(...(await pseudoProblems(page, { locale, data })));
    }
    expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
  });
}
