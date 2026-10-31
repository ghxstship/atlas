import { describe, expect, it } from "vitest";
import {
  normalizePlate,
  parseRosterTravelForm,
  parseRosterUniformForm,
  parseRosterVehicleForm,
  rosterFactErrorKey,
} from "../src/roster-facts-forms.ts";

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe("project facts forms (R5)", () => {
  it("uppercases airport codes and reads the switches", () => {
    const parsed = parseRosterTravelForm(
      form({
        inboundAirportCode: " mia ",
        inboundOn: "2027-06-01",
        outboundOn: "2027-06-04",
        needsLodging: "on",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: expect.objectContaining({
        inboundAirportCode: "MIA",
        outboundAirportCode: null,
        needsLodging: true,
        needsGroundTransport: false,
      }),
    });
  });

  it("names a trip home before the arrival, a bad code and an empty form", () => {
    expect(
      parseRosterTravelForm(form({ inboundOn: "2027-06-05", outboundOn: "2027-06-01" })),
    ).toMatchObject({
      ok: false,
      fields: ["outboundOn"],
    });
    expect(parseRosterTravelForm(form({ inboundAirportCode: "MI1" }))).toMatchObject({ ok: false });
    expect(parseRosterTravelForm(form({}))).toMatchObject({
      ok: false,
      fields: ["inboundAirportCode", "inboundOn"],
    });
  });

  it("checks sizes like the database", () => {
    expect(
      parseRosterUniformForm(form({ shirtSize: "M", shoeSize: "10.5", shoeSizeSystem: "US Men" })),
    ).toMatchObject({
      ok: true,
      value: { shirtSize: "M", shoeSize: 10.5, shoeSizeSystem: "US Men", pantsWaistIn: null },
    });
    expect(parseRosterUniformForm(form({ shoeSize: "10.3", shoeSizeSystem: "EU" }))).toMatchObject({
      ok: false,
      fields: ["shoeSize"],
    });
    expect(parseRosterUniformForm(form({ shoeSize: "10" }))).toMatchObject({
      ok: false,
      fields: ["shoeSizeSystem"],
    });
    expect(parseRosterUniformForm(form({ pantsWaistIn: "80" }))).toMatchObject({
      ok: false,
      fields: ["pantsWaistIn"],
    });
    expect(parseRosterUniformForm(form({}))).toMatchObject({ ok: false, fields: ["shirtSize"] });
  });

  it("normalizes the plate and checks the region", () => {
    expect(normalizePlate("abc 12-34")).toBe("ABC1234");
    expect(
      parseRosterVehicleForm(
        form({ make: "Ford", model: "Transit", plate: "abc 12-34", plateRegion: "us-fl" }),
      ),
    ).toEqual({
      ok: true,
      value: {
        make: "Ford",
        model: "Transit",
        color: null,
        plate: "ABC1234",
        plateRegion: "US-FL",
      },
    });
    expect(
      parseRosterVehicleForm(
        form({ make: "Ford", model: "", plate: "ABC", plateRegion: "Florida" }),
      ),
    ).toMatchObject({
      ok: false,
      fields: ["model", "plateRegion"],
    });
  });

  it("maps refusals to their copy keys", () => {
    expect(rosterFactErrorKey({ kind: "refusal", rule: "plate_format", message: "x" })).toBe(
      "plate_format",
    );
    expect(rosterFactErrorKey({ kind: "refusal", rule: "something_else", message: "x" })).toBe(
      "unexpected",
    );
    expect(rosterFactErrorKey({ kind: "not-found" })).toBe("denied");
  });
});
