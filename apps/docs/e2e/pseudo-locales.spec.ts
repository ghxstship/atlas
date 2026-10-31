import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  contentText,
  navigationStatus,
  pseudoProblems,
  PSEUDO_VIEWPORTS,
  type KnownText,
  type PseudoLocale,
} from "@xos/testing/pseudo";
import { HELP_SHELLS, guides, helpArticles, type Page } from "../lib/content.ts";
import { firstSentence, loadDictionary, tableSlug } from "../lib/dictionary.ts";
import { loadReference } from "../lib/openapi.ts";

/**
 * Gate 16 (Section 15) on every docs route, on next dev (E2E_NEXT_DEV=1):
 *   en-XA  every string outside the content came from the `docs`, `help` or `ui` catalogs: nothing
 *          hard-coded, no raw key
 *   both   no text is cut off by its box without a title or tooltip carrying all of it, at 1280 px
 *          and 375 px (en-XA pads each message by 40 percent; ar-XB lays the page right to left)
 * Each route template is visited with seeded instances that differ in shape (a table and a view, a
 * list and a create operation), and every developer guide in full. A pseudo-locale renders the en-US
 * Markdown and reference data, which are content, translated per locale as files. Inside a rendered
 * article body (marked data-pseudo-content) any run of the Markdown is known text; everywhere else
 * (the shell, headings, the reference and dictionary tables) a text counts as content only when it
 * is a whole value of the models the pages render, so a short hard-coded label cannot pass as part
 * of some article. Production builds serve no pseudo-locale (lib/i18n.ts), so the suite skips
 * against one.
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

/** Every string value inside a model (its keys are code, never shown). */
function values(value: unknown): string[] {
  if (typeof value === "string") return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(values);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(values);
  return [];
}

/** A guide's or help article's strings outside its body, and the h2 headings its outline lists. */
function page(p: Page): string[] {
  return [
    ...values({ ...p, body: [] }),
    ...p.body.flatMap((block) => (block.t === "h2" ? [block.v] : [])),
  ];
}

/**
 * What the pages show as content, in en-US as every pseudo-locale renders it. Whole values: each
 * string of the reference and dictionary models, the names pages derive from them, a guide's or help
 * article's title, summary and outline, and the sample languages a code block is labelled with. Any
 * run: the Markdown of the guides and help articles, for text inside an article body. Both name
 * tables, columns and operations, so their identifiers are content too.
 */
function content(): KnownText {
  const dictionary = loadDictionary();
  const whole = new Set([
    ...values(loadReference()),
    ...values(dictionary),
    ...dictionary.tables.flatMap((table) => [tableSlug(table), firstSentence(table.comment)]),
    ...guides("en-US").flatMap(page),
    ...HELP_SHELLS.flatMap((shell) => helpArticles("en-US", shell).flatMap(page)),
    // components/operation.tsx labels each code sample with its language or tool.
    "curl",
    "TypeScript",
    "Python",
    "xos",
  ]);
  return {
    has: (text) => whole.has(text.trim()),
    identifiers: true,
    content: contentText(
      [
        ...files(join(APP, "content", "guides", "en-US"), ".md"),
        ...HELP_SHELLS.flatMap((shell) =>
          files(join(APP, "..", shell, "help", "articles", "en-US"), ".md"),
        ),
      ],
      { identifiers: true },
    ),
  };
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
      const status = await navigationStatus(page, response);
      if (status !== expected) problems.push(`${locale} status: ${path} answered ${status}`);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      problems.push(...(await pseudoProblems(page, { locale, data })));
    }
    expect(problems, "hard-coded or clipped text under the pseudo-locales").toEqual([]);
  });
}
