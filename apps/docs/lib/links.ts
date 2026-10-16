import type { Locale } from "./i18n.ts";

/** Resolves `help:`, `guide:` and `reference:` links to site paths. */
export function resolveHref(href: string, locale: Locale): { href: string; external: boolean } {
  const m = /^(help|guide|reference):(.+)$/.exec(href);
  if (m) {
    const section = m[1] === "guide" ? "guides" : m[1];
    return { href: `/${locale}/${section}/${m[2]}`, external: false };
  }
  return { href, external: /^https?:\/\//.test(href) };
}
