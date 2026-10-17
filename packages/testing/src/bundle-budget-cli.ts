import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkRouteBudgets, kb } from "./bundle-budget.ts";

/**
 * Route JavaScript budget check for CI: run after `next build` of Atlas, Gateway and docs.
 * Prints each key page's gzip total and exits 1 when one exceeds its budget. With --chunks, also
 * lists each page's chunks by size, for finding what to split.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ceilings = JSON.parse(
  readFileSync(new URL("../bundle-ceilings.json", import.meta.url), "utf8"),
) as { pages: Record<string, number> };

const rows = checkRouteBudgets(repoRoot, ceilings.pages);
if (rows.length === 0) {
  console.error("No production build found under apps/<app>/.next. Run next build first.");
  process.exit(1);
}
for (const row of rows) {
  const verdict = row.pass ? "ok  " : "OVER";
  console.log(
    `${verdict} ${row.app.padEnd(8)}${row.path.padEnd(36)}${kb(row.gzipBytes).padStart(8)} of ${kb(row.budgetBytes)}`,
  );
  if (process.argv.includes("--chunks")) {
    const { gzipSync } = await import("node:zlib");
    const sized = row.files.map((f) => {
      const body = readFileSync(`${repoRoot}apps/${row.app}/.next/${f}`);
      return { f, gz: gzipSync(body, { level: 9 }).length, head: body.toString("utf8", 0, 90) };
    });
    for (const c of sized.sort((a, b) => b.gz - a.gz).slice(0, 8)) {
      console.log(`       ${kb(c.gz).padStart(7)} ${c.f} ${c.head.replace(/\s+/g, " ")}`);
    }
  }
}
const over = rows.filter((r) => !r.pass);
if (over.length > 0) {
  console.error(`${over.length} page(s) over the route JavaScript budget.`);
  process.exit(1);
}
console.log(`All ${rows.length} key pages within the route JavaScript budget.`);
