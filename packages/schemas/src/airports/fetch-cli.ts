import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OURAIRPORTS_URL, snapshotCsv } from "./fetch.ts";
import { AIRPORTS_SEED_MIGRATION, renderAirportsSeed } from "./generate.ts";
import { AIRPORTS_CSV, selectAirports } from "./load.ts";

/**
 * Airports snapshot CLI (owner step, R5): downloads OurAirports airports.csv, writes the committed snapshot
 * packages/schemas/airports/airports.csv with today's date in its header, and regenerates
 * supabase/migrations/2652_airports_seed.sql from it. Run it from a machine allowed to reach the source, then commit
 * both files.
 *   fetch-cli.ts   downloads from OURAIRPORTS_URL
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const response = await fetch(OURAIRPORTS_URL);
if (!response.ok) {
  console.error(`Cannot download ${OURAIRPORTS_URL}: HTTP ${response.status}.`);
  process.exit(1);
}
const snapshot = snapshotCsv(await response.text(), new Date().toISOString().slice(0, 10));
const airports = selectAirports(snapshot);
writeFileSync(`${repoRoot}${AIRPORTS_CSV}`, snapshot);
writeFileSync(`${repoRoot}${AIRPORTS_SEED_MIGRATION}`, renderAirportsSeed(airports));
console.log(`Wrote ${AIRPORTS_CSV} and ${AIRPORTS_SEED_MIGRATION} (${airports.length} airports).`);
