import { describe, expect, it } from "vitest";
import { CLIENT_ERROR_ROUTES } from "../lib/client-error-routes";
import { intakeSteps, intakeTaxKinds, todayIn, toMinorUnits } from "../lib/intake-steps";
import { KNOWN_REFUSALS } from "../lib/action-result";

const base = {
  roleType: "Contractor",
  collectTaxForm: false,
  collectPayout: false,
  collectInvoice: false,
  agreement: null,
} as const;

describe("the vendor intake wizard's plan", () => {
  it("asks only what the link collects, and always ends on Review", () => {
    expect(intakeSteps(base)).toEqual(["review"]);
    expect(intakeSteps({ ...base, roleType: "Vendor" })).toEqual(["company", "review"]);
    expect(
      intakeSteps({
        roleType: "Vendor",
        collectTaxForm: true,
        collectPayout: true,
        collectInvoice: true,
        agreement: { title: "MSA" },
      }),
    ).toEqual(["company", "tax", "payout", "agreement", "invoice", "review"]);
  });

  it("offers the tax forms the database accepts for each payee", () => {
    expect(intakeTaxKinds(true)).toEqual(["W-9", "W-8BEN-E"]);
    expect(intakeTaxKinds(false)).toEqual(["W-9", "W-8BEN"]);
  });

  it("defaults dates to today in the zone", () => {
    expect(todayIn("Asia/Tokyo", new Date("2026-03-02T20:00:00Z"))).toBe("2026-03-03");
    expect(todayIn("America/Los_Angeles", new Date("2026-03-02T02:00:00Z"))).toBe("2026-03-01");
  });

  it("reads a typed price as minor units", () => {
    expect(toMinorUnits("1200.50")).toBe(120050);
    expect(toMinorUnits("")).toBeNull();
    expect(toMinorUnits("abc")).toBeNull();
    expect(toMinorUnits("10", 0)).toBe(10);
  });
});

describe("what leaves the browser", () => {
  it("templates intake and form paths, so a token never reaches an error report or a product event", () => {
    expect(CLIENT_ERROR_ROUTES).toContain("/onboard/[token]");
    expect(CLIENT_ERROR_ROUTES).toContain("/forms/[token]");
  });
});

describe("intake refusals", () => {
  it("have their own copy", () => {
    for (const rule of [
      "payout_reference_bank_number",
      "vendor_intake_signature",
      "intake_link_full",
      "intake_invoice_used",
    ]) {
      expect(KNOWN_REFUSALS).toContain(rule);
    }
  });
});
