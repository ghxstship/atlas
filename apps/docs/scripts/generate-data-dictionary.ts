/**
 * The data dictionary (Sections 3.15 and 7.1): every app and xpms table and every view the API exposes, with each
 * column's type, nullability, foreign key and catalog comment, read from a migrated local database. Comments are
 * required on every table and column (pgTAP 1280), so the dictionary is complete by construction.
 *
 *   pnpm --filter @xos/docs dictionary:generate   # writes content/data-dictionary.json
 *   pnpm --filter @xos/docs dictionary:check      # fails when the committed file differs from the database
 *
 * Like the database types (packages/data/scripts/generate-types.ts), it reads the local stack through the
 * Supabase CLI (`--local`, the project in supabase/config.toml; SUPABASE_WORKDIR selects another stack), and CI
 * runs the check in the database job after applying every migration from empty.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { DICTIONARY_SQL, parseQueryOutput, toDictionary } from "../lib/dictionary-source.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const target = fileURLToPath(new URL("../content/data-dictionary.json", import.meta.url));
const check = process.argv.includes("--check");

const scratch = mkdtempSync(join(tmpdir(), "xos-dictionary-"));
let raw: string;
try {
  const file = join(scratch, "dictionary.sql");
  writeFileSync(file, DICTIONARY_SQL);
  raw = execFileSync("supabase", ["db", "query", "--local", "-o", "json", "-f", file], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 << 20,
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const dictionary = toDictionary(parseQueryOutput(raw));
const options = (await resolveConfig(target)) ?? {};
const text = await format(JSON.stringify(dictionary), { ...options, filepath: target });

if (check) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== text) {
    console.error(
      "apps/docs/content/data-dictionary.json is out of date. Run pnpm --filter @xos/docs dictionary:generate.",
    );
    process.exit(1);
  }
  console.log(
    `Data dictionary matches the database: ${dictionary.tables.length} tables and views, ${dictionary.columnCount} columns.`,
  );
} else {
  writeFileSync(target, text);
  console.log(
    `Wrote apps/docs/content/data-dictionary.json: ${dictionary.tables.length} tables and views, ${dictionary.columnCount} columns.`,
  );
}
