import type { SitemapNode } from "@xos/ia";

/**
 * A territory's name in the console's language (ADR 0160): private.territories keeps an English and a Spanish name,
 * and a Spanish console reads the Spanish one (crawl 4.9). Every other locale reads English.
 */
export function territoryName(
  territory: { readonly nameEn: string; readonly nameEs: string },
  locale: string,
): string {
  return locale.startsWith("es") && territory.nameEs.trim() !== ""
    ? territory.nameEs
    : territory.nameEn;
}

/**
 * The language of text the platform team writes only in English, such as a feature flag's description: undefined on an
 * English console, "en" otherwise, so the page marks it (lang) and says so rather than passing it off as translated.
 */
export function englishOnly(locale: string): "en" | undefined {
  return locale.startsWith("en") ? undefined : "en";
}

/**
 * The paths a top-bar item stands for: its own route and the static start of every route below it in the sitemap, so a
 * record (a rating dispute under Moderation, at /rating-disputes/{disputeId}) marks its section as current.
 */
export function sectionPaths(node: SitemapNode): string[] {
  const paths = new Set<string>();
  const visit = (n: SitemapNode) => {
    if (n.route) {
      const start = n.route.split("{")[0]?.replace(/\/+$/, "") ?? "";
      if (start !== "") paths.add(start);
    }
    for (const child of n.children ?? []) visit(child);
  };
  visit(node);
  return [...paths];
}

/** Whether `path` is one of a section's paths or below one. */
export function inSection(path: string, paths: readonly string[]): boolean {
  return paths.some((p) => path === p || path.startsWith(`${p}/`));
}
