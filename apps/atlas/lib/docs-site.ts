import type { Env } from "@/lib/env";

/**
 * Links to the docs site (apps/docs) from Atlas: the help center, which renders the same articles
 * as the help panel, and the API reference. The origin comes from DOCS_SITE_URL (production:
 * https://docs.ghxstship.tech); unset, Atlas shows no docs links.
 */
export function docsUrl(config: Pick<Env, "DOCS_SITE_URL">, path = ""): string | null {
  if (!config.DOCS_SITE_URL) return null;
  return `${config.DOCS_SITE_URL.replace(/\/+$/, "")}${path}`;
}
