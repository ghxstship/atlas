import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OURAIRPORTS_URL, snapshotCsv } from "../../src/airports/fetch.ts";
import { AIRPORTS_SEED_MIGRATION, renderAirportsSeed } from "../../src/airports/generate.ts";
import { loadAirports, parseCsv, selectAirports } from "../../src/airports/load.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const HEADER = "type,name,municipality,iso_country,scheduled_service,iata_code";

describe("airports seed", () => {
  it("matches the committed migration", () => {
    expect(readFileSync(`${repoRoot}${AIRPORTS_SEED_MIGRATION}`, "utf8")).toBe(
      renderAirportsSeed(loadAirports()),
    );
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
      {
        iataCode: "MIA",
        name: "Miami International Airport",
        municipality: "Miami",
        countryCode: "US",
      },
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
      {
        iataCode: "ORD",
        name: 'Chicago O\'Hare "Field", main',
        municipality: "Chicago",
        countryCode: "US",
      },
    ]);
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });

  it("refuses a missing column and a bad country", () => {
    expect(() => selectAirports("type,name\nlarge_airport,X")).toThrow(/municipality/);
    expect(() => selectAirports(`${HEADER}\nlarge_airport,Bad,Town,USA,yes,BAD`)).toThrow(
      /country/,
    );
    expect(selectAirports("")).toEqual([]);
  });

  it("writes the snapshot from the OurAirports layout, dated, with the loader's columns", () => {
    const source = [
      '"id","ident","type","name","latitude_deg","iso_country","municipality","scheduled_service","iata_code"',
      '1,"KMIA","large_airport","Miami International Airport",25.79,"US","Miami","yes","MIA"',
      '2,"US-1","small_airport","Strip, ""North""",1,"US","Nowhere","no",""',
      '3,"EGLL","large_airport","London Heathrow Airport",51.47,"GB","London","yes","LHR"',
      '4,"KAAA","medium_airport","Quiet Field, East",40.1,"US","Quiet","no","QFE"',
    ].join("\n");
    const snapshot = snapshotCsv(source, "2026-10-30");
    expect(snapshot).toContain(`downloaded from ${OURAIRPORTS_URL}`);
    expect(snapshot).toContain("# on 2026-10-30 by pnpm --filter @xos/schemas fetch:airports");
    const data = snapshot.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    expect(data).toEqual([
      HEADER,
      "large_airport,Miami International Airport,Miami,US,yes,MIA",
      "large_airport,London Heathrow Airport,London,GB,yes,LHR",
      'medium_airport,"Quiet Field, East",Quiet,US,no,QFE',
    ]);
    expect(selectAirports(snapshot).map((a) => a.iataCode)).toEqual(["LHR", "MIA"]);
    expect(() => snapshotCsv(source, "30 Oct 2026")).toThrow(/YYYY-MM-DD/);
    expect(() => snapshotCsv("type,name\nlarge_airport,X", "2026-10-30")).toThrow(/municipality/);
  });

  it("escapes quotes and batches the upsert", () => {
    const sql = renderAirportsSeed([
      { iataCode: "ORD", name: "O'Hare", municipality: null, countryCode: "US" },
    ]);
    expect(sql).toContain("('ORD', 'O''Hare', null, 'US')");
    expect(sql).toContain("on conflict (iata_code) do update");
  });
});
