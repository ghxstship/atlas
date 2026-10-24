import { describe, expect, it } from "vitest";
import { errorState, KNOWN_RULES } from "@/lib/opportunities/action-state";
import {
  applicationIcon,
  currencyDigits,
  deliverableIcon,
  documentIcon,
  engagementIcon,
  engagementLine,
  engagementProperties,
  enumKey,
  formatMoney,
  formatPayRange,
  offerIcon,
  opportunityIcon,
  parseMoney,
} from "@/lib/opportunities/format";
import en from "../../../packages/i18n/messages/en-US/opportunities.json";

describe("opportunities format", () => {
  it("maps every lifecycle state to a record state icon", () => {
    expect(opportunityIcon("Pending Approval")).toBe("in-review");
    expect(opportunityIcon("Published")).toBe("active");
    expect(applicationIcon("Not Selected")).toBe("canceled");
    expect(applicationIcon("Shortlisted")).toBe("ready");
    expect(engagementIcon("Closing")).toBe("in-review");
    expect(documentIcon("Executed")).toBe("complete");
    expect(offerIcon("Countered")).toBe("blocked");
    expect(deliverableIcon("Returned")).toBe("blocked");
  });

  it("builds catalog keys from enum values", () => {
    expect(enumKey("Pending Approval")).toBe("pendingApproval");
    expect(enumKey("Non-Disclosure Agreement")).toBe("nonDisclosureAgreement");
    expect(enumKey("Do Not Engage")).toBe("doNotEngage");
  });

  it("keeps money in minor units with the currency's own digits", () => {
    expect(currencyDigits("USD")).toBe(2);
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("NOT")).toBe(2);
    expect(formatMoney("en-US", 95000, "USD")).toBe("$950.00");
    expect(formatMoney("en-US", null, "USD")).toBeNull();
    expect(parseMoney("950.5", "USD")).toBe(95050);
    expect(parseMoney("1,200", "USD")).toBe(120000);
    expect(parseMoney("", "USD")).toBeNull();
    expect(parseMoney("9.999", "USD")).toBeNaN();
    expect(parseMoney("abc", "USD")).toBeNaN();
    expect(parseMoney("500", "JPY")).toBe(500);
  });

  it("shows a pay range, one end, or nothing for Rate on Request", () => {
    const range = (low: string, high: string) => `${low} to ${high}`;
    expect(formatPayRange("en-US", 80000, 95000, "USD", range)).toBe("$800.00 to $950.00");
    expect(formatPayRange("en-US", 80000, 80000, "USD", range)).toBe("$800.00");
    expect(formatPayRange("en-US", null, 95000, "USD", range)).toBe("$950.00");
    expect(formatPayRange("en-US", null, null, null, range)).toBeNull();
  });
});

describe("engagement record", () => {
  it("shows no role, classification, rate or pay basis for a client or sponsor engagement (1624)", () => {
    const work = ["role", "classification", "account", "dates", "rate", "payBasis"];
    for (const roleType of ["Crew", "Staff", "Contractor", "Artist", "Vendor"] as const) {
      expect(engagementProperties(roleType)).toEqual(work);
    }
    expect(engagementProperties("Client")).toEqual(["account", "dates"]);
    expect(engagementProperties("Sponsor")).toEqual(["account", "dates"]);
  });

  it("names the role under the party when the engagement has one", () => {
    const crew = { projectKey: "NWS", jobTitle: null, roleCode: "5000.51.02" };
    expect(engagementLine(crew, "Crew")).toBe("NWS · Crew · 5000.51.02");
    expect(engagementLine({ ...crew, jobTitle: "Head Rigger" }, "Crew")).toBe(
      "NWS · Crew · Head Rigger",
    );
    expect(engagementLine({ projectKey: "NWS", jobTitle: null, roleCode: null }, "Sponsor")).toBe(
      "NWS · Sponsor",
    );
  });
});

describe("opportunities action state", () => {
  it("maps refusals to their sentence or the generic one with the rule", () => {
    expect(errorState({ kind: "refusal", rule: "pay_range_required", message: "x" })).toEqual({
      error: "refusal.pay_range_required",
    });
    expect(errorState({ kind: "refusal", rule: "XOS-ENG-6", message: "x" })).toEqual({
      error: "refusal.XOS_ENG_6",
    });
    expect(
      errorState({ kind: "refusal", rule: "brand_new_rule", message: "x" }, { a: "1" }),
    ).toEqual({
      error: "refusal.generic",
      rule: "brand_new_rule",
      values: { a: "1" },
    });
    expect(errorState({ kind: "not-found" }).error).toBe("notFound");
    expect(errorState({ kind: "conflict", message: "x" }).error).toBe("conflict");
    expect(errorState({ kind: "invalid", message: "x" }).error).toBe("invalid");
    expect(errorState({ kind: "unexpected", message: "x" }).error).toBe("unexpected");
  });

  it("has a catalog sentence for every known rule", () => {
    const refusals = en.errors.refusal as Record<string, string>;
    for (const rule of KNOWN_RULES)
      expect(refusals[rule.replace(/-/g, "_")], rule).toBeTypeOf("string");
  });
});
