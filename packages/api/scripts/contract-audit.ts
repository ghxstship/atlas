/**
 * Audits the frozen v1 catalog against a database (ADR 0023).
 *
 *   pnpm --filter @xos/api audit:contract --sql > /tmp/dump.sql
 *   psql "$DATABASE_URL" -At -v default_transaction_read_only=on -f /tmp/dump.sql > /tmp/dump.json
 *   pnpm --filter @xos/api audit:contract --dump /tmp/dump.json [--uncorrected] [--json]
 *
 * The dump query is read-only. Without `--uncorrected` the audit reads the corrected catalog, so
 * it shows what remains for module agents to propose.
 */
import { readFileSync } from "node:fs";
import { buildOpenApiDocument, frozenCatalog, uncorrectedFrozenCatalog } from "../src/app.ts";
import { SCHEMA_DUMP_SQL, auditCatalog } from "../src/catalog/schema-audit.ts";
import type { SchemaDump } from "../src/catalog/schema-audit.ts";

const args = process.argv.slice(2);
if (args.includes("--sql")) {
  console.log(`${SCHEMA_DUMP_SQL.trim()};`);
} else {
  const at = args.indexOf("--dump");
  const file = at === -1 ? undefined : args[at + 1];
  if (file === undefined) {
    console.error("Pass --sql to print the dump query, or --dump <file.json> to audit a dump.");
    process.exitCode = 2;
  } else {
    const dump = JSON.parse(readFileSync(file, "utf8")) as SchemaDump;
    const specs = args.includes("--uncorrected") ? uncorrectedFrozenCatalog : frozenCatalog;
    const audits = auditCatalog(specs, buildOpenApiDocument(specs), dump);
    if (args.includes("--json")) {
      console.log(JSON.stringify(audits, null, 2));
    } else {
      for (const a of audits) {
        const shown = a.findings.filter((f) => f.kind !== "extra_column");
        if (shown.length === 0) continue;
        const text = shown.map((f) => [f.kind, f.field, f.detail].filter(Boolean).join(" "));
        console.log(`${a.module} ${a.op} (${a.table}): ${text.join("; ")}`);
      }
    }
  }
}
