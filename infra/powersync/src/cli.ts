/**
 * PowerSync readiness check (runbook: infra/powersync/README.md).
 *
 *   node --experimental-strip-types infra/powersync/src/cli.ts [--container supabase_db_xos4-shared] [--out powersync.sql]
 *
 * Reads the sync rules, reads the catalog of a local, migrated XOS database through `docker exec`
 * (read-only), prints every problem that would stop replication or leak internal columns, and
 * writes the replication role and publication SQL. Exits 1 when there are problems.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  describeProblem,
  parseRules,
  planPublication,
  publicationSql,
  type CatalogEntry,
} from "./rules.ts";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const container = argument("--container", "supabase_db_xos4-shared");
if (!/^supabase_db_xos4[a-z0-9-]*$/.test(container)) {
  console.error(`${container} is not a local XOS database container.`);
  process.exit(2);
}
const out = argument("--out", "powersync-publication.sql");
const rulesPath = fileURLToPath(new URL("../../../packages/sync/sync-rules.yaml", import.meta.url));

const catalogSql = `
select n.nspname, c.relname, c.relkind::text,
       coalesce((select string_agg(a.attname, ',' order by a.attnum) from pg_catalog.pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '')
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('app', 'private', 'xpms', 'api_external') and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition`;

const raw = execFileSync(
  "docker",
  [
    "exec",
    container,
    "psql",
    "-U",
    "postgres",
    "-h",
    "localhost",
    "-d",
    "postgres",
    "-X",
    "-tA",
    "-F",
    "\t",
    "-c",
    catalogSql,
  ],
  { encoding: "utf8" },
);
const catalog: CatalogEntry[] = raw
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => {
    const [schema = "", name = "", kind = "r", columns = ""] = line.split("\t");
    return {
      schema,
      name,
      kind: kind as CatalogEntry["kind"],
      columns: columns ? columns.split(",") : [],
    };
  });

const plan = planPublication(parseRules(readFileSync(rulesPath, "utf8")), catalog);
writeFileSync(out, publicationSql(plan));
console.log(`Wrote ${out}: ${plan.tables.length} tables, ${plan.partitioned.length} partitioned.`);
for (const problem of plan.problems) console.error(`problem: ${describeProblem(problem)}`);
process.exit(plan.problems.length > 0 ? 1 : 0);
