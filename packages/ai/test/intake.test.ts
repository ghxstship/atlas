import { describe, expect, it } from "vitest";
import {
  extendedMinor,
  inferYear,
  isAreaTimeZone,
  matchExact,
  normalizeAct,
  normalizePersonName,
  prefilledFee,
  tieOut,
} from "../src/intake.ts";

describe("normalizePersonName", () => {
  it("reads the airline and list forms as first last", () => {
    expect(normalizePersonName("SMITH/JOHN MR")).toBe("john smith");
    expect(normalizePersonName("Smith, John")).toBe("john smith");
    expect(normalizePersonName("Mr. John Smith")).toBe("john smith");
  });

  it("folds case and accents", () => {
    expect(normalizePersonName("MÁRQUEZ/ÁNGEL")).toBe("angel marquez");
    expect(normalizePersonName("Dr José Núñez")).toBe("jose nunez");
  });

  it("keeps a middle name, so it never matches without it", () => {
    expect(normalizePersonName("SMITH/JOHN ANDREW MR")).toBe("john andrew smith");
  });
});

describe("normalizeAct", () => {
  it("folds case and punctuation and drops a leading the", () => {
    expect(normalizeAct("The Midnight Owls!")).toBe("midnight owls");
    expect(normalizeAct("MIDNIGHT OWLS")).toBe("midnight owls");
  });

  it("removes a featuring tail", () => {
    expect(normalizeAct("Sol Rivera feat. Luna Vale")).toBe("sol rivera");
    expect(normalizeAct("Sol Rivera ft. Luna Vale")).toBe("sol rivera");
    expect(normalizeAct("Sol Rivera (DJ Set)")).toBe("sol rivera");
  });

  it("keeps two acts apart", () => {
    expect(normalizeAct("Midnight Owl")).not.toBe(normalizeAct("Midnight Owls"));
  });
});

describe("matchExact", () => {
  const candidates = [
    { id: "a", normalized: "john smith" },
    { id: "b", normalized: "jane smith" },
    { id: "c", normalized: "jane smith" },
    { id: "a", normalized: "john smith" },
  ];

  it("answers the one exact match", () => {
    expect(matchExact("john smith", candidates)).toBe("a");
  });

  it("answers null for two people of one name, and never a near match", () => {
    expect(matchExact("jane smith", candidates)).toBeNull();
    expect(matchExact("jon smith", candidates)).toBeNull();
    expect(matchExact("", candidates)).toBeNull();
  });
});

describe("tieOut", () => {
  it("ties with no residual", () => {
    expect(
      tieOut({
        lines: [
          { quantity: 2, unitPriceMinor: 45000 },
          { quantity: 1, unitPriceMinor: 10000 },
        ],
        printedTotalMinor: 100000,
      }),
    ).toMatchObject({
      status: "ties",
      computedSubtotalMinor: 100000,
      computedTotalMinor: 100000,
      residualMinor: 0,
      missing: [],
    });
  });

  it("gives the exact residual, tolerance zero", () => {
    expect(
      tieOut({ lines: [{ quantity: 1, unitPriceMinor: 99999 }], printedTotalMinor: 100000 }),
    ).toMatchObject({ status: "residual", residualMinor: 1 });
  });

  it("adds printed tax only when given", () => {
    expect(
      tieOut({
        lines: [{ quantity: 1, unitPriceMinor: 1000 }],
        printedTaxMinor: 80,
        printedTotalMinor: 1080,
      }),
    ).toMatchObject({ status: "ties", computedTotalMinor: 1080 });
  });

  it("is not checkable, naming what is missing", () => {
    expect(
      tieOut({ lines: [{ quantity: 1, unitPriceMinor: null }], printedTotalMinor: 100 }),
    ).toMatchObject({
      status: "not_checkable",
      residualMinor: null,
      missing: [{ field: "unit_price_minor", line: 1 }],
    });
    expect(tieOut({ lines: [{ quantity: 1, unitPriceMinor: 100 }] })).toMatchObject({
      status: "not_checkable",
      missing: [{ field: "printed_total_minor" }],
    });
  });

  // private.extended_minor is round(quantity * price): half away from zero, on numeric, not floats.
  it.each([
    [1.005, 100, 101],
    ["1.005", 100, 101],
    [0.5, 1, 1],
    [1.5, 1, 2],
    [2.5, 1, 3],
    [-2.5, 1, -3],
    [0.333, 100, 33],
    [0.335, 100, 34],
    [1.1, 3, 3],
    [2, 45000, 90000],
  ] as const)("extends %s x %s as SQL does: %s", (quantity, price, expected) => {
    expect(extendedMinor(quantity, price)).toBe(expected);
  });

  it("leaves an unread quantity or price unread", () => {
    expect(extendedMinor(null, 100)).toBeNull();
    expect(extendedMinor(1, null)).toBeNull();
    expect(extendedMinor("x", 100)).toBeNull();
  });
});

describe("inferYear", () => {
  it("takes the next occurrence on or after today", () => {
    expect(inferYear(3, 12, "2027-01-04")).toBe("2027-03-12");
    expect(inferYear(1, 4, "2027-01-04")).toBe("2027-01-04");
    expect(inferYear(1, 3, "2027-01-04")).toBe("2028-01-03");
  });

  it("crosses New Year", () => {
    expect(inferYear(1, 2, "2026-12-30")).toBe("2027-01-02");
    expect(inferYear(12, 31, "2027-01-02")).toBe("2027-12-31");
  });

  it("waits for a leap year, and refuses a day no year has", () => {
    expect(inferYear(2, 29, "2027-03-01")).toBe("2028-02-29");
    expect(inferYear(2, 30, "2027-03-01")).toBeNull();
  });
});

describe("prefilledFee", () => {
  it("carries a printed fee only on a Flat Fee row", () => {
    expect(prefilledFee("Flat Fee", 750000)).toBe(750000);
  });

  it("never carries a total onto a day rate, the only basis canon has today", () => {
    expect(prefilledFee("Day Rate", 750000)).toBeNull();
    expect(prefilledFee(null, 750000)).toBeNull();
  });

  it("stays empty when no fee was read", () => {
    expect(prefilledFee("Flat Fee", null)).toBeNull();
  });
});

describe("isAreaTimeZone", () => {
  it("takes an Area/Location name and UTC", () => {
    expect(isAreaTimeZone("America/Chicago")).toBe(true);
    expect(isAreaTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isAreaTimeZone("UTC")).toBe(true);
  });

  it("drops what Intl takes but private.assert_time_zone may refuse", () => {
    expect(isAreaTimeZone("+05:00")).toBe(false);
    expect(isAreaTimeZone("EST")).toBe(false);
    expect(isAreaTimeZone("Mars/Olympus")).toBe(false);
  });
});
