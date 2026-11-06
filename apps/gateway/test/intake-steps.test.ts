import { describe, expect, it } from "vitest";
import { CLIENT_ERROR_ROUTES } from "../lib/client-error-routes";
import { intakeSteps, intakeTaxKinds, parseLinePrice, todayIn } from "../lib/intake-steps";
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

  it("reads a typed price in the invoice's own currency", () => {
    expect(parseLinePrice("1200.50", "USD")).toBe(120050);
    // No minor unit: a JPY price is not multiplied by 100.
    expect(parseLinePrice("1000", "JPY")).toBe(1000);
    // Three minor digits: a KWD price is not ten times too low.
    expect(parseLinePrice("12.500", "KWD")).toBe(12500);
    expect(parseLinePrice("3", "BHD")).toBe(3000);
  });

  it("reads separators, and leaves a blank line unpriced rather than zero", () => {
    expect(parseLinePrice("1,200.50", "USD")).toBe(120050);
    expect(parseLinePrice(".50", "USD")).toBe(50);
    expect(parseLinePrice("", "USD")).toBeNull();
    expect(parseLinePrice("  ", "JPY")).toBeNull();
  });

  it("refuses what it cannot read, so a typed price never silently becomes an unpriced line", () => {
    for (const typed of ["abc", "$12", "1.2.3", "-5", "1,20", "1.200,50"]) {
      expect(parseLinePrice(typed, "USD")).toBe("invalid");
    }
    expect(parseLinePrice("12.345", "USD")).toBe("invalid");
    expect(parseLinePrice("1000.5", "JPY")).toBe("invalid");
    expect(parseLinePrice("9".repeat(20), "USD")).toBe("invalid");
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
