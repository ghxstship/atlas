import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AIRPORTS_SEED_MIGRATION, renderAirportsSeed } from "./generate.ts";
import { loadAirports } from "./load.ts";

/**
 * Airports seed CLI.
 *   generate-cli.ts           writes supabase/migrations/2652_airports_seed.sql from airports/airports.csv
 *   generate-cli.ts --check   writes nothing and exits 1 when the seed is out of date
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const target = `${repoRoot}${AIRPORTS_SEED_MIGRATION}`;
const generated = renderAirportsSeed(loadAirports());

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch (error) {
    console.error(`Cannot read ${AIRPORTS_SEED_MIGRATION}: ${String(error)}`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(`${AIRPORTS_SEED_MIGRATION} is out of date. Run generate:airports.`);
    process.exit(1);
  }
  console.log(`${AIRPORTS_SEED_MIGRATION} matches airports/airports.csv.`);
} else {
  writeFileSync(target, generated);
  console.log(`Wrote ${AIRPORTS_SEED_MIGRATION}.`);
}
