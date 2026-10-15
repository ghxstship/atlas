import { getTranslations } from "next-intl/server";

/**
 * A translator for keys computed at runtime: sitemap labels (`nav.gateway.primary.home`) and enum
 * display labels keyed by stored value. The sitemap validator and the catalog tests guarantee each
 * such key exists, so the typed key union is widened here, in one place.
 */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export async function getTranslate(): Promise<Translate> {
  const t = await getTranslations();
  return (key, values) => (t as unknown as Translate)(key, values);
}

/**
 * The catalog key segment for a stored enum value (Section 3.15: display labels come from the
 * catalogs keyed by the stored value): `Account Owner` becomes `accountOwner`, `W-8BEN-E`
 * becomes `w8benE`, `Shared on Application` becomes `sharedOnApplication`.
 */
export function enumKey(value: string): string {
  const words = value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

/** The catalog key of an enum display label: `gateway.enums.<enum>.<value>`. */
export function enumLabelKey(enumName: string, value: string): string {
  return `gateway.enums.${enumName}.${enumKey(value)}`;
}
