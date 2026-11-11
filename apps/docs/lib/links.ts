import type { Locale } from "./i18n.ts";

/**
 * Resolves `help:`, `guide:`, `reference:` and `dictionary:` links to site paths. `help:` links resolve
 * within the help of the shell the page comes from, under `helpBase` (Atlas's articles live at
 * /<locale>/help). `dictionary:<schema>.<table>` is a table's data dictionary page, and a bare
 * `dictionary:` the dictionary's index.
 */
export function resolveHref(
  href: string,
  locale: Locale,
  helpBase = `/${locale}/help`,
): { href: string; external: boolean } {
  const table = /^dictionary:(.*)$/.exec(href);
  if (table) {
    const slug = table[1] as string;
    return { href: `/${locale}/data-dictionary${slug === "" ? "" : `/${slug}`}`, external: false };
  }
  const m = /^(help|guide|reference):(.+)$/.exec(href);
  if (m) {
    if (m[1] === "help") return { href: `${helpBase}/${m[2]}`, external: false };
    const section = m[1] === "guide" ? "guides" : m[1];
    return { href: `/${locale}/${section}/${m[2]}`, external: false };
  }
  return { href, external: /^https?:\/\//.test(href) };
}

/**
 * Whether a link is a path inside the app an article was written for, such as Gateway's
 * /settings/account: it means nothing on the docs site, so the help center shows its text only.
 */
export function isAppPath(href: string, locale: Locale): boolean {
  return href.startsWith("/") && !href.startsWith(`/${locale}/`);
}
