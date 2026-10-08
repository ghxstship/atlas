import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSitemap } from "./load";
import type { Sitemap } from "./schema";

/** Read and parse a sitemap file from disk (build scripts and tests only). */
export function loadSitemapFile(path: string | URL): Sitemap {
  const filePath = typeof path === "string" ? path : fileURLToPath(path);
  return parseSitemap(readFileSync(filePath, "utf8"), filePath);
}
