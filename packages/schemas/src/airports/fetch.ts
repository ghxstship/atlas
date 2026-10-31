import { parseCsv } from "./load.ts";

/** Where OurAirports publishes airports.csv (https://ourairports.com/data/, public domain). */
export const OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";

/** The columns the committed snapshot keeps: the ones packages/schemas/src/airports/load.ts reads. */
export const SNAPSHOT_COLUMNS = [
  "type",
  "name",
  "municipality",
  "iso_country",
  "scheduled_service",
  "iata_code",
] as const;

const SNAPSHOT_TYPES = new Set(["large_airport", "medium_airport"]);

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The committed snapshot packages/schemas/airports/airports.csv from the text of OurAirports airports.csv: a header
 * comment naming the source and the download date, then the large and medium airports with the six columns the loader
 * reads, in the source's order. The loader still applies the full filter (scheduled service, IATA code), so the
 * snapshot only drops rows and columns it would never keep, which keeps the committed file small.
 */
export function snapshotCsv(
  source: string,
  downloadedOn: string,
  url: string = OURAIRPORTS_URL,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(downloadedOn))
    throw new Error("the download date must be YYYY-MM-DD");
  const [header, ...rows] = parseCsv(source).filter((r) => r.some((f) => f.trim() !== ""));
  if (!header) throw new Error("airports.csv is empty");
  const indexes = SNAPSHOT_COLUMNS.map((name) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`airports.csv has no ${name} column`);
    return index;
  });
  const type = header.indexOf("type");
  const kept = rows
    .filter((row) => SNAPSHOT_TYPES.has((row[type] ?? "").trim()))
    .map((row) => indexes.map((i) => csvField(row[i] ?? "")).join(","));
  return [
    "# Airports for travel requests (R5, ADR 0102). Read by packages/schemas/src/airports/load.ts, which keeps rows of type",
    "# large_airport or medium_airport with scheduled_service yes and an IATA code of three capital letters, and writes",
    "# supabase/migrations/2652_airports_seed.sql (pnpm --filter @xos/schemas generate:airports).",
    `# Source: OurAirports airports.csv (https://ourairports.com/data/, public domain), downloaded from ${url}`,
    `# on ${downloadedOn} by pnpm --filter @xos/schemas fetch:airports, which keeps the large and medium airports and the`,
    "# columns the loader reads.",
    SNAPSHOT_COLUMNS.join(","),
    ...kept,
    "",
  ].join("\n");
}
