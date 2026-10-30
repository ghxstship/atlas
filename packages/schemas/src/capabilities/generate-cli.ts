import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { CAPABILITY_CODES_MODULE, renderCapabilityCodesModule } from "./codes.ts";
import { loadCapabilityRegistry } from "./load.ts";
import { CAPABILITY_SEED_MIGRATION, renderCapabilitySeedSql } from "./sql.ts";

/**
 * Capability registry CLI.
 *   generate-cli.ts           writes the capability seed migration and the generated code module
 *   generate-cli.ts --check   writes nothing and exits 1 when either is out of date
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const registry = loadCapabilityRegistry();
const modulePath = `${packageRoot}${CAPABILITY_CODES_MODULE}`;
const options = (await resolveConfig(modulePath)) ?? {};

const outputs: [string, string, string][] = [
  [
    CAPABILITY_SEED_MIGRATION,
    `${repoRoot}${CAPABILITY_SEED_MIGRATION}`,
    renderCapabilitySeedSql(registry),
  ],
  [
    `packages/schemas/${CAPABILITY_CODES_MODULE}`,
    modulePath,
    await format(renderCapabilityCodesModule(registry), { ...options, filepath: modulePath }),
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
      console.error(`${label} is out of date. Run generate:capabilities.`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`Wrote ${label}.`);
  }
}
if (stale) process.exit(1);
if (check) console.log("The capability registry outputs match capabilities.yaml.");
