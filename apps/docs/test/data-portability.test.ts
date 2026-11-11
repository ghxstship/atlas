/**
 * The full export and switching guides (Section 14.8, S14.8-01): they exist in every locale, describe
 * the archive the code builds (packages/data/src/lifecycle.ts), say what the Terms of Service promise
 * (legal/terms-of-service.md Section 11.3), and link only to data dictionary pages that exist.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDES_DIR, guides, HELP_SHELLS, helpArticles } from "../lib/content.ts";
import { findTable } from "../lib/dictionary.ts";
import { LOCALES } from "../lib/i18n.ts";
import { resolveHref } from "../lib/links.ts";
import { linksIn, textOf } from "../lib/markdown.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(APP, "..", "..");
const LIFECYCLE = readFileSync(join(ROOT, "packages", "data", "src", "lifecycle.ts"), "utf8");
const TERMS = readFileSync(join(ROOT, "legal", "terms-of-service.md"), "utf8");
const SLUGS = ["full-export", "switching"] as const;

function guideText(locale: (typeof LOCALES)[number], slug: (typeof SLUGS)[number]): string {
  const guide = guides(locale).find((g) => g.slug === slug);
  expect(guide, `${locale}/${slug}`).toBeDefined();
  return textOf(guide?.body ?? []);
}

/** The field names of the ExportManifest interface, read from its source. */
function manifestFields(): string[] {
  const body = /export interface ExportManifest \{([\s\S]*?)\n\}/.exec(LIFECYCLE)?.[1] ?? "";
  return [...body.matchAll(/^ {2}readonly (\w+):/gm)].map((m) => m[1] as string);
}

function numberConstant(name: string): number {
  const expr = new RegExp(`export const ${name} = ([\\d_ *]+);`).exec(LIFECYCLE)?.[1];
  expect(expr, name).toBeDefined();
  return (expr ?? "0")
    .replace(/_/g, "")
    .split("*")
    .reduce((product, factor) => product * Number(factor.trim()), 1);
}

describe("full export and switching guides", () => {
  it("exist in every locale, in the Operate section", () => {
    for (const locale of LOCALES) {
      for (const slug of SLUGS) {
        expect(guides(locale).find((g) => g.slug === slug)?.section, `${locale}/${slug}`).toBe(
          "operate",
        );
      }
    }
  });

  it("describe every manifest field and the archive's paths and limits", () => {
    const fields = manifestFields();
    expect(fields).toEqual(expect.arrayContaining(["format", "tables", "files", "filesOmitted"]));
    const fileLimit = numberConstant("EXPORT_FILE_LIMIT");
    const megabytes = numberConstant("EXPORT_FILE_BYTES") / (1024 * 1024);
    expect(LIFECYCLE).toContain('format: "xos-org-export"');
    for (const locale of LOCALES) {
      const text = guideText(locale, "full-export");
      for (const field of fields) expect(text, `${locale}: ${field}`).toContain(field);
      for (const path of ["manifest.json", "records/", "files/attachments/", "xos-org-export"])
        expect(text, `${locale}: ${path}`).toContain(path);
      expect(text).toContain(`${fileLimit} `);
      expect(text).toContain(`${megabytes} MB`);
      expect(text).toContain("X-Export-Manifest-Sha256");
    }
    // The header the guide names is the one the export route sends.
    const route = readFileSync(
      join(ROOT, "apps", "atlas", "app", "[org]", "export", "route.ts"),
      "utf8",
    );
    expect(route).toContain('"X-Export-Manifest-Sha256"');
  });

  it("say what Section 11.3 of the Terms promises", () => {
    expect(TERMS).toMatch(/11\.3 \*\*Switching providers\.\*\*/);
    expect(TERMS).toContain("30 days of transition support");
    expect(TERMS).toContain("From 12 January 2027, GHXSTSHIP will not charge switching fees.");
    const promises: Record<string, readonly string[]> = {
      "en-US": ["11.3", "30 days of transition support", "12 January 2027"],
      "es-US": ["11.3", "30 días de soporte de transición", "12 de enero de 2027"],
    };
    for (const [locale, phrases] of Object.entries(promises)) {
      const text = guideText(locale as (typeof LOCALES)[number], "switching");
      for (const phrase of phrases) expect(text, `${locale}: ${phrase}`).toContain(phrase);
    }
    for (const locale of LOCALES) {
      const switching = guides(locale).find((g) => g.slug === "switching");
      expect(linksIn(switching?.body ?? [])).toContain("guide:full-export");
    }
  });

  it("link to data dictionary pages that exist", () => {
    expect(resolveHref("dictionary:", "es-US")).toEqual({
      href: "/es-US/data-dictionary",
      external: false,
    });
    expect(resolveHref("dictionary:app.org_exports", "en-US")).toEqual({
      href: "/en-US/data-dictionary/app.org_exports",
      external: false,
    });
    const pages = LOCALES.flatMap((locale) => [
      ...guides(locale).map((p) => ({ name: `${locale}/${p.slug}`, body: p.body })),
      ...HELP_SHELLS.flatMap((shell) =>
        helpArticles(locale, shell).map((p) => ({
          name: `${shell}/${locale}/${p.slug}`,
          body: p.body,
        })),
      ),
    ]);
    let checked = 0;
    for (const page of pages) {
      for (const href of linksIn(page.body)) {
        const slug = /^dictionary:(.*)$/.exec(href)?.[1];
        if (slug === undefined) continue;
        checked += 1;
        if (slug !== "") expect(findTable(slug), `${page.name} links to ${href}`).toBeDefined();
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

// After `next build`, both guides exist as prerendered HTML in every published locale.
const BUILT_APP = join(APP, ".next", "server", "app");
const FRESH_BUILD =
  existsSync(join(BUILT_APP, "en-US", "guides")) &&
  SLUGS.every(
    (slug) =>
      statSync(join(BUILT_APP, "en-US", "guides")).mtimeMs >=
      statSync(join(GUIDES_DIR, "en-US", `${slug}.md`)).mtimeMs,
  );

describe.runIf(FRESH_BUILD)("built guides", () => {
  it("prerender both guides in both locales", () => {
    for (const locale of ["en-US", "es-US"]) {
      for (const slug of SLUGS) {
        const file = join(BUILT_APP, locale, "guides", `${slug}.html`);
        expect(existsSync(file), file).toBe(true);
        const html = readFileSync(file, "utf8");
        const title = guides(locale as (typeof LOCALES)[number]).find(
          (g) => g.slug === slug,
        )?.title;
        expect(html).toContain(`>${title}</h1>`);
      }
    }
  });
});
