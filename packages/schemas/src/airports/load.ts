import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One airport of app.airports (migration 2651). */
export interface Airport {
  readonly iataCode: string;
  readonly name: string;
  readonly municipality: string | null;
  readonly countryCode: string;
}

/** Repository-relative path of the committed airports snapshot. */
export const AIRPORTS_CSV = "packages/schemas/airports/airports.csv";

const KEPT_TYPES = new Set(["large_airport", "medium_airport"]);
const IATA = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;

/** Splits CSV text into rows of fields, honoring double-quoted fields with doubled quotes and embedded commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The airports a travel request may name, from CSV text in the OurAirports airports.csv layout (columns found by
 * header name; lines starting with # are comments): type large_airport or medium_airport, scheduled_service yes and
 * an IATA code of three capital letters. On a duplicate code the large airport wins, then the first row. Sorted by
 * code. Throws on a kept row whose name or country breaks the table's checks.
 */
export function selectAirports(text: string): Airport[] {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const [header, ...rows] = parseCsv(lines).filter((r) => r.some((f) => f.trim() !== ""));
  if (!header) return [];
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`airports.csv has no ${name} column`);
    return index;
  };
  const type = column("type");
  const name = column("name");
  const municipality = column("municipality");
  const country = column("iso_country");
  const scheduled = column("scheduled_service");
  const iata = column("iata_code");

  const chosen = new Map<string, { airport: Airport; large: boolean }>();
  for (const row of rows) {
    const code = (row[iata] ?? "").trim();
    const kind = (row[type] ?? "").trim();
    if (!KEPT_TYPES.has(kind) || (row[scheduled] ?? "").trim() !== "yes" || !IATA.test(code))
      continue;
    const airportName = (row[name] ?? "").trim();
    const countryCode = (row[country] ?? "").trim();
    const town = (row[municipality] ?? "").trim();
    if (airportName.length < 1 || airportName.length > 200)
      throw new Error(`${code}: the name must be 1 to 200 characters`);
    if (!COUNTRY.test(countryCode))
      throw new Error(`${code}: the country must be two capital letters`);
    const large = kind === "large_airport";
    const existing = chosen.get(code);
    if (existing && (existing.large || !large)) continue;
    chosen.set(code, {
      airport: {
        iataCode: code,
        name: airportName,
        municipality: town === "" ? null : town.slice(0, 120),
        countryCode,
      },
      large,
    });
  }
  return [...chosen.values()]
    .map((c) => c.airport)
    .sort((a, b) => a.iataCode.localeCompare(b.iataCode));
}

/** Reads and selects the committed snapshot. */
export function loadAirports(): Airport[] {
  const path = fileURLToPath(new URL("../../airports/airports.csv", import.meta.url));
  return selectAirports(readFileSync(path, "utf8"));
}
