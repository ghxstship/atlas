import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { loadPlanRegistry } from "./load.ts";
import { PLAN_OFFERING_MODULE, renderPlanOfferingModule } from "./offering-module.ts";
import { PLAN_SEED_MIGRATION, renderPlanSeedSql } from "./sql.ts";

/**
 * Plan registry CLI.
 *   generate-cli.ts           writes the plan seed migration and the generated offering module from plans.yaml
 *   generate-cli.ts --check   writes nothing and exits 1 when either is out of date
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const registry = loadPlanRegistry();
const modulePath = `${packageRoot}${PLAN_OFFERING_MODULE}`;
const options = (await resolveConfig(modulePath)) ?? {};

const outputs: [string, string, string][] = [
  [PLAN_SEED_MIGRATION, `${repoRoot}${PLAN_SEED_MIGRATION}`, renderPlanSeedSql(registry)],
  [
    `packages/schemas/${PLAN_OFFERING_MODULE}`,
    modulePath,
    await format(renderPlanOfferingModule(registry), { ...options, filepath: modulePath }),
  ],
];

const check = process.argv.includes("--check");
let stale = false;
for (const [label, path, text] of outputs) {
  if (check) {
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch (error) {
      console.error(`Cannot read ${label}: ${String(error)}`);
      current = "";
    }
    if (current !== text) {
      console.error(`${label} is out of date. Run generate:plans.`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`Wrote ${label}.`);
  }
}
if (stale) process.exit(1);
if (check) console.log("The plan registry outputs match plans.yaml.");
