import { describe, expect, it } from "vitest";
import {
  hasFilters,
  hasMoreFilters,
  parseExploreQuery,
  recommendationReasons,
  resolvePlace,
} from "@/lib/explore";
import { profileStrength, STRENGTH_LINKS, STRENGTH_STEPS } from "@/lib/profile";

const places = [{ label: "Miami", latitude: 25.77, longitude: -80.19, listingCount: 3 }];

describe("Explore query (A89: the missing discovery filters)", () => {
  it("reads discipline, category, certification, place, radius, order and passed listings", () => {
    const parsed = parseExploreQuery({
      q: " towers ",
      role: ["Vendor", "Wizard"],
      disc: "5000.01",
      cat: "5000.01.02",
      cert: " ETCP ",
      near: "miami",
      radius: "100",
      sort: "soonest",
      passed: "1",
    });
    expect(parsed).toMatchObject({
      q: "towers",
      roles: ["Vendor"],
      disc: "5000.01",
      cat: "5000.01.02",
      cert: "ETCP",
      near: "miami",
      radiusKm: 100,
      sort: "soonest",
      passed: true,
    });
    expect(parsed.filter).toEqual({
      query: "towers",
      roleTypes: ["Vendor"],
      discCode: "5000.01",
      catUrid: "5000.01.02",
      certificationName: "ETCP",
      sort: "soonest",
      includePassed: true,
    });
    expect(hasFilters(parsed)).toBe(true);
    expect(hasMoreFilters(parsed)).toBe(true);
    expect(resolvePlace(parsed, places)).toEqual({
      label: "Miami",
      latitude: 25.77,
      longitude: -80.19,
      radiusKm: 100,
    });
  });

  it("drops what it does not recognize rather than guessing", () => {
    const parsed = parseExploreQuery({
      disc: "audio",
      cat: "9000.01.01",
      radius: "7",
      sort: "paid",
      near: "Atlantis",
    });
    expect(parsed).toMatchObject({
      disc: "",
      cat: "9000.01.01",
      radiusKm: 50,
      sort: "recommended",
    });
    expect(resolvePlace(parsed, places)).toBeNull();
    // A category outside the chosen discipline is dropped.
    expect(parseExploreQuery({ disc: "5000.01", cat: "9000.01.01" }).cat).toBe("");
    expect(hasFilters(parseExploreQuery({ sort: "soonest", passed: "1" }))).toBe(false);
    expect(hasMoreFilters(parseExploreQuery({}))).toBe(false);
  });

  it("names why a listing is recommended", () => {
    const parts = {
      score: 100,
      skills: 40,
      certifications: 30,
      location: 20,
      availability: 10,
      certificationsRequired: 2,
      certificationsMet: 2,
    };
    expect(recommendationReasons(parts)).toEqual(["skills", "certifications", "near", "available"]);
    expect(
      recommendationReasons({
        ...parts,
        skills: 25,
        location: 5,
        availability: 0,
        certificationsRequired: 0,
      }),
    ).toEqual(["discipline"]);
  });
});

describe("profile strength (A89: shows what is missing and links to it)", () => {
  it("lists every missing step with a link", () => {
    const strength = profileStrength({
      headline: "Rigger",
      city: null,
      bio: null,
      skills: 2,
      certifications: 0,
      rateMinor: null,
      languages: 1,
      links: 0,
      availability: 0,
    });
    expect(strength.next).toBe("city");
    expect(strength.missing).toEqual([
      "city",
      "certifications",
      "rate",
      "availability",
      "bio",
      "links",
    ]);
    expect(strength.percent).toBe(33);
    for (const step of STRENGTH_STEPS)
      expect(STRENGTH_LINKS[step]).toMatch(/^\/(settings\/)?profile#/);
  });
});
