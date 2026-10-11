import { getTranslations } from "next-intl/server";

/**
 * A translator for keys computed at runtime: sitemap labels (`nav.atlas.items.home`) and page copy
 * keys derived from node ids. The sitemap validator and tests guarantee every such key exists in
 * the catalogs, so the typed key union is widened here, in one place.
 */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export async function getTranslate(): Promise<Translate> {
  const t = await getTranslations();
  return (key, values) => (t as unknown as Translate)(key, values);
}
