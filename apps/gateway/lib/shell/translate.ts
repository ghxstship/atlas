import { getTranslations } from "next-intl/server";

export { enumKey, enumLabelKey } from "@/lib/enum-key";

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
