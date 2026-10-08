import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { SitemapSchema, type Sitemap } from "./schema";

/** A sitemap file that is not valid YAML or does not match the schema. */
export class SitemapLoadError extends Error {
  override readonly name = "SitemapLoadError";
  readonly source: string;

  constructor(source: string, message: string, options?: ErrorOptions) {
    super(`${source}: ${message}`, options);
    this.source = source;
  }
}

/** Parse sitemap YAML text and check it against the schema. */
export function parseSitemap(text: string, source = "sitemap.yaml"): Sitemap {
  let data: unknown;
  try {
    data = parse(text, { strict: true, uniqueKeys: true });
  } catch (error) {
    const message = error instanceof YAMLParseError ? error.message : String(error);
    throw new SitemapLoadError(source, `invalid YAML: ${message}`, { cause: error });
  }
  const result = SitemapSchema.safeParse(data);
  if (!result.success) {
    throw new SitemapLoadError(source, `schema mismatch:\n${z.prettifyError(result.error)}`, {
      cause: result.error,
    });
  }
  return result.data;
}
