import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODES,
  countryName,
  countryOptions,
  isCountryCode,
} from "../src/formats/countries.ts";
import { betaLocales, launchLocales, locales, offeredLocaleList } from "../src/locales.ts";
import {
  createOfferingCache,
  DEFAULT_OFFERING,
  offeringFrom,
  offeringNames,
  planFeatureOffered,
  readOffering,
  type OfferingClient,
} from "../src/offering.ts";

const migration = readFileSync(
  new URL("../../../supabase/migrations/6150_offered_territories.sql", import.meta.url),
  "utf8",
);

const EEA_ROW = {
  code: "EEA",
  name_en: "the European Economic Area",
  name_es: "el Espacio Económico Europeo",
  country_codes: ["DE", "FR"],
  currency_codes: ["EUR"],
  locale_codes: ["fr-FR", "de-DE"],
};
const US_ROW = {
  code: "US",
  name_en: "the United States",
  name_es: "los Estados Unidos",
  country_codes: ["US"],
  currency_codes: ["USD"],
  locale_codes: ["en-US", "es-US"],
};

function clientAnswering(answer: { data: unknown; error: unknown }): OfferingClient {
  return { schema: () => ({ rpc: () => Promise.resolve(answer) }) };
}

describe("where XOS is offered (ADR 0156)", () => {
  it("defaults to the United States alone, in dollars, in the launch languages", () => {
    expect(DEFAULT_OFFERING.territories.map((t) => t.code)).toEqual(["US"]);
    expect(DEFAULT_OFFERING.currencies).toEqual(["USD"]);
    expect(DEFAULT_OFFERING.locales).toEqual([...launchLocales]);
    expect(DEFAULT_OFFERING.countries).toContain("PR");
    expect(DEFAULT_OFFERING.countries).not.toContain("GB");
  });

  it("keeps the default equal to what migration 6150 seeds as open", () => {
    const us = DEFAULT_OFFERING.territories[0];
    const countries = (us?.countries ?? []).map((c) => `'${c}'`).join(", ");
    expect(migration).toContain(`('US', 'the United States', 'los Estados Unidos', array[${countries}], array['USD'], array['en-US', 'es-US'], true`);
    // Only the US row is seeded open.
    expect(migration.match(/\btrue,\n\s+'/g)).toHaveLength(1);
  });

  it("reads what the database offers, adding its currencies and languages", async () => {
    const offering = await readOffering(
      clientAnswering({ data: [US_ROW, EEA_ROW], error: null }),
    );
    expect(offering.currencies).toEqual(["USD", "EUR"]);
    expect(offering.locales).toEqual(["en-US", "es-US", "fr-FR", "de-DE"]);
    expect(offering.countries).toEqual(["US", "DE", "FR"]);
  });

  it("fails closed: an error, an empty answer or a thrown call reads as the launch state", async () => {
    expect(await readOffering(clientAnswering({ data: null, error: { message: "down" } }))).toBe(
      DEFAULT_OFFERING,
    );
    expect(await readOffering(clientAnswering({ data: [], error: null }))).toBe(DEFAULT_OFFERING);
    const throwing: OfferingClient = {
      schema: () => {
        throw new Error("no client");
      },
    };
    expect(await readOffering(throwing)).toBe(DEFAULT_OFFERING);
  });

  it("always keeps en-US and es-US, and ignores a locale no build ships", () => {
    expect(offeredLocaleList([])).toEqual([...launchLocales]);
    expect(offeredLocaleList(["nl-NL", "ja-JP"])).toEqual([...launchLocales, "ja-JP"]);
    expect(offeringFrom([]).locales).toEqual([...launchLocales]);
    // Closed is a switch, never a deletion: the Beta locales stay shipped.
    expect(locales).toEqual([...launchLocales, ...betaLocales]);
  });

  it("names the territories in the reader's language", () => {
    expect(offeringNames(DEFAULT_OFFERING, "en-US")).toEqual(["the United States"]);
    expect(offeringNames(DEFAULT_OFFERING, "es-US")).toEqual(["los Estados Unidos"]);
  });

  it("hides a plan feature that names a closed territory", () => {
    expect(planFeatureOffered("eu_data_residency", DEFAULT_OFFERING)).toBe(false);
    expect(planFeatureOffered("saml_sso", DEFAULT_OFFERING)).toBe(true);
    const open = offeringFrom([
      ...DEFAULT_OFFERING.territories,
      { code: "EEA", nameEn: "", nameEs: "", countries: [], currencies: [], locales: [] },
    ]);
    expect(planFeatureOffered("eu_data_residency", open)).toBe(true);
  });

  it("keeps a good read for its time, and never keeps the fallback", async () => {
    let now = 0;
    let reads = 0;
    let next = offeringFrom([]);
    const cached = createOfferingCache(
      () => {
        reads += 1;
        return Promise.resolve(next);
      },
      60,
      () => now,
    );
    await cached();
    now = 59_000;
    await cached();
    expect(reads).toBe(1);
    now = 60_000;
    next = DEFAULT_OFFERING;
    await cached();
    now = 60_001;
    await cached();
    expect(reads).toBe(3);
  });
});

describe("the country question", () => {
  it("holds the whole ISO list, each code once, offered or not", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(isCountryCode("DE")).toBe(true);
    expect(isCountryCode("de")).toBe(false);
    expect(isCountryCode("")).toBe(false);
  });

  it("reads in the reader's language, in alphabetical order", () => {
    expect(countryName("DE", "es-US")).toBe("Alemania");
    const options = countryOptions("en-US");
    expect(options).toHaveLength(249);
    expect(options[0]?.label.localeCompare(options[1]?.label ?? "", "en-US")).toBeLessThan(0);
    expect(options.find((o) => o.value === "US")?.label).toBe("United States");
  });
});
