import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AIRPORTS_SEED_MIGRATION, renderAirportsSeed } from "../../src/airports/generate.ts";
import { loadAirports, parseCsv, selectAirports } from "../../src/airports/load.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const HEADER = "type,name,municipality,iso_country,scheduled_service,iata_code";

describe("airports seed", () => {
  it("matches the committed migration", () => {
    expect(readFileSync(`${repoRoot}${AIRPORTS_SEED_MIGRATION}`, "utf8")).toBe(renderAirportsSeed(loadAirports()));
  });

  it("holds the airports the tests and journeys name, sorted by code", () => {
    const codes = loadAirports().map((a) => a.iataCode);
    expect(codes).toEqual(expect.arrayContaining(["MIA", "JFK", "LHR"]));
    expect([...codes].sort()).toEqual(codes);
  });

  it("keeps scheduled large and medium airports with an IATA code", () => {
    const csv = [
      "# a comment",
      HEADER,
      "large_airport,Miami International Airport,Miami,US,yes,MIA",
      "small_airport,Somewhere Strip,Nowhere,US,yes,SWS",
      "medium_airport,No Service Field,Quiet,US,no,NSF",
      "heliport,Pad,Downtown,US,yes,PAD",
      "medium_airport,Lower Code,Town,US,yes,abc",
      "medium_airport,Blank Town,,US,yes,BLK",
    ].join("\n");
    expect(selectAirports(csv)).toEqual([
      { iataCode: "BLK", name: "Blank Town", municipality: null, countryCode: "US" },
      { iataCode: "MIA", name: "Miami International Airport", municipality: "Miami", countryCode: "US" },
    ]);
  });

  it("keeps the large airport on a duplicate code", () => {
    const csv = [
      HEADER,
      "medium_airport,First Medium,Town,US,yes,DUP",
      "large_airport,The Large One,Town,US,yes,DUP",
      "medium_airport,Second Medium,Town,US,yes,DUP",
    ].join("\n");
    expect(selectAirports(csv).map((a) => a.name)).toEqual(["The Large One"]);
  });

  it("reads quoted fields and finds columns by name", () => {
    const csv = [
      '"id","iata_code","name","type","scheduled_service","iso_country","municipality"',
      '1,"ORD","Chicago O\'Hare ""Field"", main","large_airport","yes","US","Chicago"',
    ].join("\r\n");
    expect(selectAirports(csv)).toEqual([
      { iataCode: "ORD", name: 'Chicago O\'Hare "Field", main', municipality: "Chicago", countryCode: "US" },
    ]);
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });

  it("refuses a missing column and a bad country", () => {
    expect(() => selectAirports("type,name\nlarge_airport,X")).toThrow(/municipality/);
    expect(() => selectAirports(`${HEADER}\nlarge_airport,Bad,Town,USA,yes,BAD`)).toThrow(/country/);
    expect(selectAirports("")).toEqual([]);
  });

  it("escapes quotes and batches the upsert", () => {
    const sql = renderAirportsSeed([{ iataCode: "ORD", name: "O'Hare", municipality: null, countryCode: "US" }]);
    expect(sql).toContain("('ORD', 'O''Hare', null, 'US')");
    expect(sql).toContain("on conflict (iata_code) do update");
  });
});
