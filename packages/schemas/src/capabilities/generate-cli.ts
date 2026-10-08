import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCapabilityRegistry } from "./load.ts";
import { CAPABILITY_SEED_MIGRATION, renderCapabilitySeedSql } from "./sql.ts";

/**
 * Writes the capability seed migration from capabilities.yaml.
 * With --check, writes nothing and exits 1 when the committed migration is out of date.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const target = `${repoRoot}${CAPABILITY_SEED_MIGRATION}`;
const sql = renderCapabilitySeedSql(loadCapabilityRegistry());

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = readFileSync(target, "utf8");
  } catch (error) {
    console.error(`Cannot read ${CAPABILITY_SEED_MIGRATION}: ${String(error)}`);
    process.exit(1);
  }
  if (current !== sql) {
    console.error(`${CAPABILITY_SEED_MIGRATION} is out of date. Run generate:capabilities.`);
    process.exit(1);
  }
  console.log(`${CAPABILITY_SEED_MIGRATION} matches capabilities.yaml.`);
} else {
  writeFileSync(target, sql);
  console.log(`Wrote ${CAPABILITY_SEED_MIGRATION}.`);
}
