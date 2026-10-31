import { describe, expect, it } from "vitest";
import { addressFormat, addressLines, readAddress, VENUE_ADDRESS } from "@/lib/address";

/**
 * A139: venue, vendor and legal entity addresses lay out and validate by country (Section 15). The
 * server hands each form its country's rows and required fields, and reads a submitted address back
 * against the same country before the database checks the postal code again (migration 2320).
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

describe("address forms by country", () => {
  it("lays out the fields Atlas records in the country's order", () => {
    expect(addressFormat("US")).toEqual({
      country: "US",
      rows: [["streetAddress"], ["locality", "administrativeArea", "postalCode"]],
      required: ["streetAddress", "locality", "administrativeArea", "postalCode"],
    });
    expect(addressFormat("de").rows.flat()).toEqual(["streetAddress", "postalCode", "locality"]);
    expect(addressFormat("DE").required).toEqual(["streetAddress", "locality", "postalCode"]);
  });

  it("leaves out a field the record takes from elsewhere", () => {
    const entity = addressFormat("US", { omit: ["administrativeArea"] });
    expect(entity.rows).toEqual([["streetAddress"], ["locality", "postalCode"]]);
    expect(entity.required).not.toContain("administrativeArea");
  });

  it("lays out a venue address in its country's order with every field optional", () => {
    expect(addressFormat("US", VENUE_ADDRESS)).toEqual({
      country: "US",
      rows: [["streetAddress"], ["locality", "postalCode"]],
      required: [],
    });
  });
});

describe("reading a submitted address", () => {
  const sf = {
    streetAddress: " 548  Market St ",
    locality: "San Francisco",
    administrativeArea: "CA",
    postalCode: "94104 1234",
  };

  it("records nothing for an address left blank", () => {
    expect(readAddress(form({ streetAddress: " ", postalCode: "" }), "US")).toEqual({
      ok: true,
      value: { streetAddress: null, locality: null, administrativeArea: null, postalCode: null },
    });
  });

  it("tidies spacing and writes the postal code as the country does", () => {
    expect(readAddress(form(sf), "US")).toEqual({
      ok: true,
      value: {
        streetAddress: "548 Market St",
        locality: "San Francisco",
        administrativeArea: "CA",
        postalCode: "94104-1234",
      },
    });
  });

  it("names the fields a started address is missing and a postal code that does not fit", () => {
    expect(readAddress(form({ ...sf, locality: "", postalCode: "SW1A 1AA" }), "US")).toEqual({
      ok: false,
      problems: { locality: "required", postalCode: "postalCode" },
    });
    const blank = { locality: "", administrativeArea: "", postalCode: "" };
    expect(readAddress(form({ ...blank, streetAddress: "1 Front Street W" }), "CA")).toEqual({
      ok: false,
      problems: { locality: "required", administrativeArea: "required", postalCode: "required" },
    });
  });

  it("does not ask for an omitted field, and checks only lengths without a country", () => {
    expect(
      readAddress(form({ ...sf, administrativeArea: "" }), "US", { omit: ["administrativeArea"] })
        .ok,
    ).toBe(true);
    expect(readAddress(form({ ...sf, postalCode: "anything" }), null).ok).toBe(true);
    expect(readAddress(form({ ...sf, locality: "x".repeat(101) }), null)).toEqual({
      ok: false,
      problems: { locality: "tooLong" },
    });
  });

  it("takes a partial venue address but still checks its postal code", () => {
    const cityOnly = { streetAddress: "", locality: "Miami", postalCode: "" };
    expect(readAddress(form(cityOnly), "US", VENUE_ADDRESS)).toEqual({
      ok: true,
      value: { streetAddress: null, locality: "Miami", administrativeArea: null, postalCode: null },
    });
    expect(readAddress(form({ ...cityOnly, postalCode: "SW1A 1AA" }), "US", VENUE_ADDRESS)).toEqual(
      { ok: false, problems: { postalCode: "postalCode" } },
    );
  });

  it("does not ask for a required field the form did not show", () => {
    // A GB layout has no state; the person changed the country to US before saving.
    const gbFields = {
      streetAddress: "1 Main St",
      locality: "Springfield",
      postalCode: "62701",
    };
    expect(readAddress(form(gbFields), "US")).toEqual({
      ok: true,
      value: { ...gbFields, administrativeArea: null },
    });
    expect(readAddress(form({ ...gbFields, administrativeArea: "" }), "US")).toEqual({
      ok: false,
      problems: { administrativeArea: "required" },
    });
  });
});

describe("showing an address", () => {
  const value = {
    streetAddress: "Hauptstraße 5",
    locality: "Berlin",
    administrativeArea: null,
    postalCode: "10115",
  };

  it("uses the country's format, naming the country when it is not the viewer's", () => {
    expect(addressLines(value, "DE", { locale: "en-US", viewerCountry: "US" })).toEqual([
      "Hauptstraße 5",
      "10115 Berlin",
      "Germany",
    ]);
    expect(addressLines(value, "DE", { locale: "es-US", viewerCountry: "DE" })).toEqual([
      "Hauptstraße 5",
      "10115 Berlin",
    ]);
  });

  it("shows nothing without an address or a country", () => {
    const none = {
      streetAddress: null,
      locality: null,
      administrativeArea: null,
      postalCode: null,
    };
    expect(addressLines(none, "US", { locale: "en-US" })).toBeNull();
    expect(addressLines(value, null, { locale: "en-US" })).toBeNull();
  });
});
