import {
  parseAccessibilityForm,
  parseContactForm,
  parseDietaryForm,
  parseTravelForm,
  parseUniformForm,
} from "@xos/data/work-details-forms";
import { toE164 } from "@xos/i18n/formats";
import { describe, expect, it } from "vitest";
import {
  fieldErrorKeys,
  formFields,
  MAX_CONTACTS,
  NEW_CONTACT,
  nextSortOrder,
  saveErrorKey,
  SIZE_CHOICES,
  toggled,
  travelFields,
  uniformFields,
} from "../src/settings/workDetails";

/**
 * Work Details editing in Compass (A111, S4.5.6-44): the phone's forms feed the parsers Atlas and Gateway share, so
 * the same values pass and the same values are refused.
 */

describe("the fields of a Work Details form", () => {
  it("read as a submitted form does: text, every chosen value, and absent fields", () => {
    const form = formFields({ allergies: "peanuts", dietaryNeeds: ["Vegan", "Halal"] });
    expect(form.get("allergies")).toBe("peanuts");
    expect(form.getAll("dietaryNeeds")).toEqual(["Vegan", "Halal"]);
    expect(form.get("dietaryNeeds")).toBe("Vegan");
    expect(form.get("missing")).toBeNull();
    expect(form.getAll("missing")).toEqual([]);
  });

  it("pass the uniform parser with the saved sizes, blank meaning none", () => {
    const fields = uniformFields(null);
    expect(Object.values(fields).every((v) => v === "")).toBe(true);
    expect(
      parseUniformForm(formFields({ ...fields, shirtSize: "L", shoeSize: " US 10.5 " })),
    ).toEqual({
      ok: true,
      value: {
        shirtSize: "L",
        jacketSize: null,
        gloveSize: null,
        pantsSize: null,
        shoeSize: "US 10.5",
        hatSize: null,
        uniformNotes: null,
      },
    });
  });

  it("offer every garment size and none", () => {
    expect(SIZE_CHOICES[0]).toBe("");
    expect(SIZE_CHOICES).toContain("XL");
  });

  it("send the chosen needs as the shared parsers expect", () => {
    const dietary = parseDietaryForm(
      formFields({
        dietaryNeeds: toggled(toggled([], "Vegan"), "Kosher"),
        allergies: "",
        dietaryNotes: "",
      }),
    );
    expect(dietary).toMatchObject({ ok: true, value: { dietaryNeeds: ["Vegan", "Kosher"] } });
    const access = parseAccessibilityForm(
      formFields({ accessibilityNeeds: toggled(["Seating"], "Seating"), accessibilityNotes: "" }),
    );
    expect(access).toMatchObject({ ok: true, value: { accessibilityNeeds: [] } });
  });

  it("name the travel fields to fix", () => {
    const parsed = parseTravelForm(formFields({ ...travelFields(null), homeAirport: "MIAMI" }));
    expect(fieldErrorKeys(parsed)).toEqual({ homeAirport: "workDetails.errors.invalid" });
    expect(
      fieldErrorKeys(parseTravelForm(formFields({ ...travelFields(null), homeAirport: "mia" }))),
    ).toEqual({});
  });

  it("read a contact's phone in the person's region", () => {
    const parsed = parseContactForm(
      formFields({ ...NEW_CONTACT, fullName: "Ana Ruiz", phone: "305 555 0142", sortOrder: "2" }),
      (input) => toE164(input, "US"),
    );
    expect(parsed).toMatchObject({ ok: true, value: { phoneE164: "+13055550142", sortOrder: 2 } });
    const bad = parseContactForm(
      formFields({ ...NEW_CONTACT, fullName: "Ana", phone: "12" }),
      (input) => toE164(input, "US"),
    );
    expect(fieldErrorKeys(bad)).toEqual({ phone: "workDetails.errors.phone" });
  });
});

describe("emergency contacts", () => {
  it("are called in order, a new one after the last", () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([{ sortOrder: 0 }, { sortOrder: 3 }])).toBe(4);
    expect(MAX_CONTACTS).toBe(5);
  });
});

describe("a refused save", () => {
  it("names its rule's sentence", () => {
    expect(
      saveErrorKey({ kind: "refusal", rule: "emergency_contact_limit", message: "limit" }),
    ).toBe("workDetails.errors.emergency_contact_limit");
    expect(saveErrorKey({ kind: "unexpected", message: "boom" })).toBe(
      "workDetails.errors.unexpected",
    );
  });
});
