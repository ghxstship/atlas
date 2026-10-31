import { describe, expect, it } from "vitest";
import { groupByAct, normalizeAct, trigramSimilarity } from "../src/intake.ts";
import {
  airportCodes,
  checkItinerary,
  localInstant,
  toSegments,
  type ItineraryLine,
} from "../src/itinerary.ts";
import { withholdIdentity } from "../src/redact.ts";
import { computeTieOut, extendedMinor, priceVariance } from "../src/tieout.ts";

describe("tie-out", () => {
  it("rounds half away from zero exactly as private.extended_minor does", () => {
    expect(extendedMinor(1.5, 4999)).toBe(7499);
    expect(extendedMinor("1.005", 100)).toBe(101);
    expect(extendedMinor(-2.5, 1)).toBe(-3);
    expect(extendedMinor(-1.5, 3)).toBe(-5);
    expect(extendedMinor(2, -1250)).toBe(-2500);
    expect(extendedMinor(0.333, 3)).toBe(1);
    expect(extendedMinor(null, 100)).toBeNull();
    expect(extendedMinor(2, null)).toBeNull();
  });

  it("ties when lines plus tax and shipping equal the printed total", () => {
    const tie = computeTieOut({
      lines: [
        { quantity: 4, unitPriceMinor: 4500 },
        { quantity: 1, unitPriceMinor: -1000 },
      ],
      printed: { subtotal: 17000, tax: 1190, shipping: 500, total: 18690 },
    });
    expect(tie).toEqual({
      linesMinor: 17000,
      subtotalResidualMinor: 0,
      totalResidualMinor: 0,
      unpricedLines: [],
      status: "ties",
    });
  });

  it("returns the signed residual otherwise, and counts a receipt's tip", () => {
    expect(
      computeTieOut({
        lines: [{ quantity: 2, unitPriceMinor: 1500 }],
        printed: { tip: 600, total: 3900 },
      }),
    ).toMatchObject({ linesMinor: 3000, totalResidualMinor: 300, status: "residual" });
    expect(
      computeTieOut({ lines: [{ quantity: 2, unitPriceMinor: 1500 }], printed: { total: 2900 } }),
    ).toMatchObject({ totalResidualMinor: -100, status: "residual" });
  });

  it("is incomplete when the total or a line price is unread", () => {
    expect(
      computeTieOut({ lines: [{ quantity: 1, unitPriceMinor: 100 }], printed: {} }).status,
    ).toBe("incomplete");
    expect(
      computeTieOut({
        lines: [
          { quantity: 1, unitPriceMinor: 100 },
          { quantity: 3, unitPriceMinor: null },
        ],
        printed: { total: 100 },
      }),
    ).toMatchObject({ status: "incomplete", unpricedLines: [1], linesMinor: 100 });
  });

  it("measures price variance against history", () => {
    expect(priceVariance(5000, 4500)).toBeCloseTo(0.111, 3);
    expect(priceVariance(4500, null)).toBeNull();
  });
});

const line = (over: Partial<ItineraryLine>): ItineraryLine => ({
  passengerName: "Ivy Marchetti",
  travelMode: "Flight",
  serviceIdentifier: "GA 100",
  departsFrom: "MIA",
  departsLocal: "2027-06-01T08:15",
  departsTimeZone: "America/New_York",
  arrivesAtPlace: "ORD",
  arrivesLocal: "2027-06-01T10:20",
  arrivesTimeZone: "America/Chicago",
  ...over,
});

describe("itinerary checks", () => {
  const airports = new Set(["MIA", "ORD", "LAX", "JFK"]);

  it("makes instants in each place's zone", () => {
    const [segment] = toSegments([line({})]);
    expect(segment).toEqual({
      departsAt: "2027-06-01T12:15:00.000Z",
      arrivesAt: "2027-06-01T15:20:00.000Z",
    });
    expect(localInstant("2027-06-01T08:15", null)).toBeNull();
    expect(
      toSegments([line({ departsTimeZone: null })], { departsTimeZone: "UTC" })[0]?.departsAt,
    ).toBe("2027-06-01T08:15:00.000Z");
  });

  it("keeps a red-eye that crosses midnight in order", () => {
    const redEye = line({
      departsFrom: "LAX",
      departsLocal: "2027-06-01T22:30",
      departsTimeZone: "America/Los_Angeles",
      arrivesAtPlace: "JFK",
      arrivesLocal: "2027-06-02T06:55",
      arrivesTimeZone: "America/New_York",
    });
    const flags = checkItinerary([redEye], airports);
    expect(flags.map((f) => f.type)).toEqual(["inferred_zone"]);
    expect(toSegments([redEye])[0]).toEqual({
      departsAt: "2027-06-02T05:30:00.000Z",
      arrivesAt: "2027-06-02T10:55:00.000Z",
    });
  });

  it("reads a time on a daylight saving change day as a calendar does", () => {
    const [segment] = toSegments([
      line({
        departsLocal: "2027-03-14T02:30",
        arrivesLocal: "2027-03-14T05:00",
        arrivesTimeZone: "America/New_York",
      }),
    ]);
    expect(segment?.departsAt).toBe("2027-03-14T07:30:00.000Z");
    expect(segment?.arrivesAt).toBe("2027-03-14T09:00:00.000Z");
  });

  it("flags an arrival before departure, an unknown airport and a repeated passenger segment", () => {
    const lines = [
      line({ arrivesLocal: "2027-06-01T06:00", arrivesTimeZone: "America/New_York" }),
      line({ arrivesAtPlace: "Gate 4, Old Field" }),
      line({ passengerName: "IVY MARCHETTI", serviceIdentifier: "ga 100" }),
      line({ passengerName: "Arturo Bell" }),
      line({
        travelMode: "Ground",
        departsFrom: "Hotel Lobby",
        arrivesAtPlace: "Venue Dock",
        departsTimeZone: null,
        arrivesTimeZone: null,
      }),
    ];
    const flags = checkItinerary(lines, airports, { inferredYear: [3] });
    expect(flags.filter((f) => f.type !== "inferred_zone")).toEqual([
      { type: "arrival_before_departure", line: 0 },
      { type: "unknown_airport", line: 1 },
      { type: "duplicate_in_batch", line: 1 },
      { type: "duplicate_in_batch", line: 2 },
      { type: "inferred_year", line: 3 },
    ]);
    expect(flags.some((f) => f.type === "inferred_zone" && f.line === 4)).toBe(false);
    expect(airportCodes("MIA Terminal D")).toEqual(["MIA"]);
  });

  it("checks a multi-passenger booking segment by segment", () => {
    const booking = ["Ivy Marchetti", "Arturo Bell", "Sam Kowalski"].map((name) =>
      line({ passengerName: name }),
    );
    expect(
      checkItinerary(booking, airports).filter((f) => f.type === "duplicate_in_batch"),
    ).toEqual([]);
  });
});

describe("act grouping", () => {
  it("normalizes an act's name", () => {
    expect(normalizeAct("The Midnight Owls")).toBe("midnight owls");
    expect(normalizeAct("Midnight Owls (DJ set)")).toBe("midnight owls");
    expect(normalizeAct("MIDNIGHT OWLS f/s/o Owl Touring LLC")).toBe("midnight owls");
    expect(normalizeAct("Beyoncé (Live)")).toBe("beyonce");
  });

  it("puts one act's files together and keeps unrelated acts apart", () => {
    const files = [
      { file: "a.pdf", act: "The Midnight Owls" },
      { file: "b.pdf", act: "Coastal Drift" },
      { file: "c.pdf", act: "Midnight Owls (DJ set)" },
      { file: "d.pdf", act: "MIDNIGHT OWLS f/s/o Owl Touring LLC" },
      { file: "e.pdf", act: "Midnight Oil" },
    ];
    const groups = groupByAct(files, (f) => f.act);
    expect(groups.map((g) => [g.act, g.items.map((i) => i.file)])).toEqual([
      ["coastal drift", ["b.pdf"]],
      ["midnight oil", ["e.pdf"]],
      ["midnight owls", ["a.pdf", "c.pdf", "d.pdf"]],
    ]);
    expect(trigramSimilarity("midnight owls", "midnight oil")).toBeLessThan(0.85);
  });
});

describe("identity withholding", () => {
  it("withholds passport, birth date and known traveler values and keeps the label", () => {
    expect(withholdIdentity("Passport No: X1234567, DOB 04/12/1990")).toBe(
      "Passport No: [withheld], DOB [withheld]",
    );
    expect(withholdIdentity("Known Traveler Number: 98765432")).toBe(
      "Known Traveler Number: [withheld]",
    );
    expect(withholdIdentity("Passport expiry 12 MAR 2031")).toBe("Passport expiry [withheld]");
    expect(withholdIdentity("Policy expiration 03/31/2027")).toBe("Policy expiration 03/31/2027");
  });
});
