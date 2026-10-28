import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addressLayout,
  addressProblems,
  compareNames,
  composedName,
  displayName,
  familyNameFirst,
  formalName,
  formatPhone,
  formatPostalAddress,
  isValidPostalCode,
  nameSortKey,
  normalizePostalCode,
  phoneCountry,
  POSTAL_CODE_COUNTRIES,
  postalCodePattern,
  phoneHref,
  regionFromLocale,
  requiredAddressFields,
  shortName,
  toE164,
} from "../src/formats/index.ts";

describe("names (Section 15)", () => {
  const mia = { fullName: "Mia Takahashi", givenName: "Mia", familyName: "Takahashi" };
  const kanji = { fullName: null, givenName: "美亜", familyName: "高橋" };

  it("shows the full name as written and never reorders it", () => {
    expect(displayName(mia, "ja-JP")).toBe("Mia Takahashi");
    expect(displayName({ fullName: "Dubois Xavier" }, "en-US")).toBe("Dubois Xavier");
  });

  it("composes given and family names in the locale's order, with no space in CJK scripts", () => {
    expect(familyNameFirst("ja-JP")).toBe(true);
    expect(familyNameFirst("es-US")).toBe(false);
    expect(composedName(mia, "en-US")).toBe("Mia Takahashi");
    expect(composedName(mia, "ja-JP")).toBe("Takahashi Mia");
    expect(composedName(kanji, "ja-JP")).toBe("高橋美亜");
    expect(displayName(kanji, "ja-JP")).toBe("高橋美亜");
    expect(composedName({ givenName: "Cher" }, "en-US")).toBe("Cher");
    expect(composedName({}, "en-US")).toBeNull();
  });

  it("uses the formal, short and sort forms", () => {
    expect(formalName(mia, "hu-HU")).toBe("Takahashi Mia");
    expect(formalName({ fullName: "Ivy Marchetti" }, "en-US")).toBe("Ivy Marchetti");
    expect(shortName({ ...mia, preferredName: "Mimi" }, "en-US")).toBe("Mimi");
    expect(shortName(mia, "en-US")).toBe("Mia");
    expect(shortName({ fullName: "Quinn Ashby" }, "en-US")).toBe("Quinn Ashby");
    expect(displayName({ preferredName: "Arturo" }, "en-US")).toBe("Arturo");
    expect(displayName({}, "en-US")).toBe("");
    expect(nameSortKey(mia, "en-US")).toBe("takahashi mia");
    expect(nameSortKey({ fullName: "Ivy Marchetti" }, "en-US")).toBe("ivy marchetti");
    const people = [mia, { fullName: "Ivy Marchetti", familyName: "Marchetti", givenName: "Ivy" }];
    expect(people.sort((a, b) => compareNames(a, b, "en-US")).map((p) => p.familyName)).toEqual([
      "Marchetti",
      "Takahashi",
    ]);
  });
});

describe("phone numbers (Section 15)", () => {
  it("reads the region from the locale", () => {
    expect(regionFromLocale("en-US")).toBe("US");
    expect(regionFromLocale("es-US")).toBe("US");
    expect(regionFromLocale("ja")).toBe("JP");
    expect(regionFromLocale("not a locale")).toBeNull();
  });

  it("stores what a person types as E.164, or nothing when it is not a number", () => {
    expect(toE164("(305) 555-0142", "US")).toBe("+13055550142");
    expect(toE164("+39 347 123 4567")).toBe("+393471234567");
    expect(toE164("347 123 4567", "IT")).toBe("+393471234567");
    expect(toE164("12", "US")).toBeNull();
    expect(toE164("   ")).toBeNull();
    expect(toE164("305 555 0142", "usa")).toBeNull();
  });

  it("shows a number in national format at home and international format abroad", () => {
    expect(formatPhone("+13055550142", "US")).toBe("(305) 555-0142");
    expect(formatPhone("+393471234567", "US")).toBe("+39 347 123 4567");
    expect(formatPhone("+393471234567", "IT")).toBe("347 123 4567");
    expect(formatPhone("+13055550142")).toBe("+1 305 555 0142");
    expect(formatPhone("not a number", "US")).toBe("not a number");
    expect(phoneCountry("+393471234567")).toBe("IT");
    expect(phoneCountry("x")).toBeNull();
    expect(phoneHref("+1 305 555 0142")).toBe("tel:+13055550142");
  });
});

describe("postal addresses (Section 15)", () => {
  const us = {
    country: "US",
    addressLines: ["548 Market St"],
    locality: "San Francisco",
    administrativeArea: "CA",
    postalCode: "94104",
  };

  it("formats in the country's order, adding the country in the viewer's language when asked", () => {
    expect(formatPostalAddress(us, { locale: "en-US" })).toEqual([
      "548 Market St",
      "San Francisco, CA 94104",
    ]);
    expect(
      formatPostalAddress(
        { country: "de", addressLines: ["Hauptstraße 5"], locality: "Berlin", postalCode: "10115" },
        { locale: "en-US", withCountry: true },
      ),
    ).toEqual(["Hauptstraße 5", "10115 Berlin", "Germany"]);
    expect(
      formatPostalAddress(
        { country: "DE", locality: "Berlin" },
        { locale: "es-US", withCountry: true },
      ).at(-1),
    ).toBe("Alemania");
  });

  it("lays out a form per country", () => {
    expect(addressLayout("US")).toEqual([
      ["recipient"],
      ["organization"],
      ["addressLines"],
      ["locality", "administrativeArea", "postalCode"],
    ]);
    expect(addressLayout("DE").flat()).toEqual([
      "recipient",
      "organization",
      "addressLines",
      "postalCode",
      "locality",
    ]);
  });

  it("validates postal codes and required fields from the metadata", () => {
    expect(isValidPostalCode("US", "94104")).toBe(true);
    expect(isValidPostalCode("US", "94104-1234")).toBe(true);
    expect(isValidPostalCode("US", "9410")).toBe(false);
    expect(isValidPostalCode("CA", "K1A 0B1")).toBe(true);
    expect(isValidPostalCode("GB", "SW1A 1AA")).toBe(true);
    expect(isValidPostalCode("NL", "1012 ab")).toBe(true);
    expect(isValidPostalCode("JP", "100-0001")).toBe(true);
    expect(isValidPostalCode("ZZ", "anything")).toBe(true);
    expect(isValidPostalCode("ZZ", "")).toBe(false);
    expect(requiredAddressFields("US")).toEqual([
      "addressLines",
      "locality",
      "administrativeArea",
      "postalCode",
    ]);
    expect(requiredAddressFields("ZZ")).toEqual(["addressLines", "locality"]);
    expect(addressProblems(us)).toEqual([]);
    expect(addressProblems({ ...us, administrativeArea: " ", postalCode: "1" })).toEqual([
      "administrativeArea",
      "postalCode",
    ]);
  });
});

describe("postal codes as each country writes them (A139)", () => {
  it("adds the separator the country's post uses", () => {
    expect(normalizePostalCode("US", " 94104 1234 ")).toBe("94104-1234");
    expect(normalizePostalCode("US", "941041234")).toBe("94104-1234");
    expect(normalizePostalCode("us", "94104")).toBe("94104");
    expect(normalizePostalCode("CA", "k1a0b1")).toBe("K1A 0B1");
    expect(normalizePostalCode("GB", "sw1a1aa")).toBe("SW1A 1AA");
    expect(normalizePostalCode("GB", "bfpo123")).toBe("BFPO 123");
    expect(normalizePostalCode("NL", "1012ab")).toBe("1012 AB");
    expect(normalizePostalCode("DE", " 10115 ")).toBe("10115");
  });

  it("leaves a code that does not fit as typed, trimmed and in capitals", () => {
    expect(normalizePostalCode("US", "9410")).toBe("9410");
    expect(normalizePostalCode("CA", "abc  12")).toBe("ABC 12");
    expect(isValidPostalCode("US", normalizePostalCode("US", "9410"))).toBe(false);
  });

  it("holds the same patterns as the database check (migration 2320)", () => {
    const sql = readFileSync(
      new URL("../../../supabase/migrations/2320_postal_codes_by_country.sql", import.meta.url),
      "utf8",
    );
    const inSql = Object.fromEntries(
      [...sql.matchAll(/when '([A-Z]{2})' then '([^']+)'/g)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(inSql).sort()).toEqual([...POSTAL_CODE_COUNTRIES]);
    for (const country of POSTAL_CODE_COUNTRIES) {
      expect(inSql[country], country).toBe(postalCodePattern(country));
    }
    expect(postalCodePattern("ZZ")).toBeNull();
  });
});

describe("the region of a locale on an engine without Intl.Locale (Hermes, A93)", () => {
  it("reads the region from the tag instead of throwing", async () => {
    const { regionOfLocale, resolveUnitSystem } = await import("../src/formats/units.ts");
    expect(regionOfLocale("es-US")).toBe("US");
    const locale = Intl.Locale;
    try {
      // Compass runs on Hermes, which has no Intl.Locale.
      (Intl as { Locale?: unknown }).Locale = undefined;
      expect(regionOfLocale("es-US")).toBe("US");
      expect(regionOfLocale("zh-Hant-TW")).toBe("TW");
      expect(regionOfLocale("es-419")).toBe("419");
      expect(regionOfLocale("fr")).toBeNull();
      expect(resolveUnitSystem("jurisdiction", { locale: "en-US" })).toBe("imperial");
      expect(resolveUnitSystem("jurisdiction", { locale: "de-DE" })).toBe("metric");
    } finally {
      (Intl as { Locale?: unknown }).Locale = locale;
    }
  });
});
