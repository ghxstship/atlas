import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPlanRegistry } from "./load.ts";
import { PLAN_SEED_MIGRATION, renderPlanSeedSql } from "./sql.ts";

/**
 * Writes the plan seed migration from plans.yaml.
 * With --check, writes nothing and exits 1 when the committed migration is out of date.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const target = `${repoRoot}${PLAN_SEED_MIGRATION}`;
const sql = renderPlanSeedSql(loadPlanRegistry());

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = readFileSync(target, "utf8");
  } catch (error) {
    console.error(`Cannot read ${PLAN_SEED_MIGRATION}: ${String(error)}`);
    process.exit(1);
  }
  if (current !== sql) {
    console.error(`${PLAN_SEED_MIGRATION} is out of date. Run generate:plans.`);
    process.exit(1);
  }
  console.log(`${PLAN_SEED_MIGRATION} matches plans.yaml.`);
} else {
  writeFileSync(target, sql);
  console.log(`Wrote ${PLAN_SEED_MIGRATION}.`);
}
