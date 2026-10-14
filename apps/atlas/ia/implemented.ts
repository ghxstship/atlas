/**
 * Build-time only: reads ia/implemented/*.txt with node:fs, so the route generator and tests may
 * import it but the Next.js app must not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nodes whose page is written by hand, read from ia/implemented/*.txt: one file per owning agent,
 * one sitemap node id per line, with # comments. Separate files let module agents claim pages in
 * parallel without editing a shared list. The generator never writes these pages and fails when
 * one is missing. A module agent implementing a page adds its node id to its own file (for
 * example ia/implemented/projects.txt) and replaces the page file.
 */
export const IMPLEMENTED: ReadonlySet<string> = readImplemented();

function readImplemented(): ReadonlySet<string> {
  const dir = fileURLToPath(new URL("./implemented/", import.meta.url));
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#")),
    );
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`ia/implemented lists ${id} twice.`);
    seen.add(id);
  }
  return seen;
}
