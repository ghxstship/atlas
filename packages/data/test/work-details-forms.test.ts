import { describe, expect, it } from "vitest";
import {
  parseAccessibilityForm,
  parseContactForm,
  parseDietaryForm,
  parseId,
  parseLoyaltyForm,
  parseNamePartsForm,
  parsePassportForm,
  parseShareForm,
  shareFormError,
  workDetailErrorKey,
} from "../src/work-details-forms.ts";

const form = (entries: readonly [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

const E164 = (input: string) => {
  const digits = input.replace(/[^0-9+]/g, "");
  if (/^\+[1-9][0-9]{6,14}$/.test(digits)) return digits;
  return /^[0-9]{10}$/.test(digits) ? `+1${digits}` : null;
};
const ID = "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f";

describe("work details form parsers", () => {
  it("reads dietary and accessibility needs as known values only", () => {
    const dietary = parseDietaryForm(
      form([
        ["dietaryNeeds", "Vegan"],
        ["dietaryNeeds", "Nut Free"],
        ["dietaryNeeds", "Carnivore"],
        ["allergies", "Peanuts, severe"],
      ]),
    );
    expect(dietary.ok && dietary.value).toEqual({
      dietaryNeeds: ["Vegan", "Nut Free"],
      allergies: "Peanuts, severe",
      dietaryNotes: null,
    });
    expect(parseDietaryForm(form([["allergies", "a".repeat(501)]])).ok).toBe(false);
    const access = parseAccessibilityForm(form([["accessibilityNeeds", "Seating"]]));
    expect(access.ok && access.value).toEqual({
      accessibilityNeeds: ["Seating"],
      accessibilityNotes: null,
    });
    expect(parseAccessibilityForm(form([["accessibilityNotes", "a".repeat(1001)]])).ok).toBe(false);
  });

  it("reads passport details and keeps the number apart", () => {
    const passport = parsePassportForm(
      form([
        ["passportIssuingCountry", "it"],
        ["passportExpiresOn", "2031-04-30"],
        ["passportName", "IVY MARCHETTI"],
        ["passportNumber", ""],
      ]),
    );
    expect(passport.ok && passport.value).toEqual({
      patch: {
        passportIssuingCountry: "IT",
        passportExpiresOn: "2031-04-30",
        passportName: "IVY MARCHETTI",
      },
      number: null,
    });
    expect(
      parsePassportForm(
        form([
          ["passportIssuingCountry", "I1"],
          ["passportExpiresOn", "30/04/2031"],
        ]),
      ),
    ).toMatchObject({ ok: false, fields: ["passportIssuingCountry", "passportExpiresOn"] });
  });

  it("reads an emergency contact with its phones in E.164", () => {
    const contact = parseContactForm(
      form([
        ["fullName", "Ana Ruiz"],
        ["relationship", "Friend"],
        ["phone", "(305) 555-0142"],
        ["alternatePhone", ""],
        ["email", "ana@example.com"],
        ["sortOrder", "2"],
      ]),
      E164,
    );
    expect(contact.ok && contact.value).toEqual({
      fullName: "Ana Ruiz",
      relationship: "Friend",
      phoneE164: "+13055550142",
      alternatePhoneE164: null,
      email: "ana@example.com",
      sortOrder: 2,
    });
    expect(parseContactForm(form([["phone", "+13055550142"]]), E164)).toMatchObject({
      ok: false,
      fields: ["fullName"],
    });
    expect(
      parseContactForm(
        form([
          ["fullName", "A"],
          ["email", "not-an-email"],
        ]),
        E164,
      ),
    ).toMatchObject({
      fields: ["email"],
      code: "invalid",
    });
    expect(
      parseContactForm(
        form([
          ["fullName", "A"],
          ["phone", "12"],
          ["alternatePhone", "34"],
        ]),
        E164,
      ),
    ).toEqual({ ok: false, fields: ["phone", "alternatePhone"], code: "phone" });
    const outOfRange = parseContactForm(
      form([
        ["fullName", "A"],
        ["phone", "+13055550142"],
        ["sortOrder", "500"],
      ]),
      E164,
    );
    expect(outOfRange.ok && outOfRange.value.sortOrder).toBe(0);
  });

  it("reads loyalty programs, ids, shares and name parts", () => {
    expect(
      parseLoyaltyForm(
        form([
          ["programKind", "Hotel"],
          ["programName", "Bonvoy"],
          ["memberNumber", "BV-0000-TEST"],
        ]),
      ),
    ).toEqual({
      ok: true,
      value: { programKind: "Hotel", programName: "Bonvoy", memberNumber: "BV-0000-TEST" },
    });
    expect(parseLoyaltyForm(form([["programKind", "Boat"]]))).toMatchObject({
      fields: ["programKind", "programName", "memberNumber"],
    });
    expect(parseId(form([["id", ID]]), "id")).toBe(ID);
    expect(parseId(form([["id", "1"]]), "id")).toBeNull();
    expect(
      parseShareForm(
        form([
          ["engagementId", ID],
          ["categories", "Passport"],
          ["categories", "Contact"],
          ["categories", "Uniform Sizes"],
          ["categories", "Nope"],
        ]),
      ),
    ).toEqual({ ok: true, value: { engagementId: ID, categories: ["Passport", "Contact"] } });
    // Uniform Sizes is retired (R6a): a share of it alone names nothing.
    expect(
      parseShareForm(
        form([
          ["engagementId", ID],
          ["categories", "Uniform Sizes"],
        ]),
      ),
    ).toMatchObject({ fields: ["categories"] });
    expect(parseShareForm(form([["categories", "Passport"]]))).toMatchObject({
      fields: ["engagementId"],
    });
    expect(parseShareForm(form([["engagementId", ID]]))).toMatchObject({ fields: ["categories"] });
    // Contact goes with another category (2664): API v1 lists at least one beside it.
    expect(
      parseShareForm(
        form([
          ["engagementId", ID],
          ["categories", "Contact"],
        ]),
      ),
    ).toMatchObject({ fields: ["contactAlone"] });
    expect(shareFormError(["contactAlone"])).toBe("work_detail_share_contact_alone");
    expect(shareFormError(["categories"])).toBe("work_detail_share_categories");
    expect(shareFormError(["engagementId"])).toBe("invalid");
    expect(
      parseNamePartsForm(
        form([
          ["givenName", "Ivy"],
          ["familyName", ""],
        ]),
      ),
    ).toEqual({ ok: true, value: { givenName: "Ivy", familyName: null } });
    expect(parseNamePartsForm(form([["givenName", "x".repeat(101)]])).ok).toBe(false);
  });

  it("maps repository errors to catalog keys", () => {
    expect(
      workDetailErrorKey({ kind: "refusal", rule: "emergency_contact_limit", message: "" }),
    ).toBe("emergency_contact_limit");
    expect(
      workDetailErrorKey({ kind: "refusal", rule: "work_detail_field_moved", message: "" }),
    ).toBe("work_detail_field_moved");
    expect(
      workDetailErrorKey({ kind: "refusal", rule: "work_detail_category_retired", message: "" }),
    ).toBe("work_detail_category_retired");
    expect(
      workDetailErrorKey({ kind: "refusal", rule: "work_detail_share_contact_alone", message: "" }),
    ).toBe("work_detail_share_contact_alone");
    expect(workDetailErrorKey({ kind: "refusal", rule: "something_else", message: "" })).toBe(
      "unexpected",
    );
    expect(workDetailErrorKey({ kind: "not-found" })).toBe("denied");
    expect(workDetailErrorKey({ kind: "conflict", message: "" })).toBe("conflict");
    expect(workDetailErrorKey({ kind: "invalid", message: "" })).toBe("invalid");
    expect(workDetailErrorKey({ kind: "unexpected", message: "" })).toBe("unexpected");
  });
});
