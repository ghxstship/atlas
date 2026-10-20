/** Locales the docs site serves; other Compass languages open its English pages. */
const DOCS_LOCALES = ["en-US", "es-US"] as const;

/**
 * The docs site's help center (RRR-119) for a language, from EXPO_PUBLIC_DOCS_URL (production:
 * https://docs.ghxstship.tech), or null when the build has no docs site.
 */
export function helpCenterUrl(docsUrl: string | null, language: string): string | null {
  if (!docsUrl) return null;
  const locale = (DOCS_LOCALES as readonly string[]).includes(language) ? language : "en-US";
  return `${docsUrl.replace(/\/+$/, "")}/${locale}/help`;
}
