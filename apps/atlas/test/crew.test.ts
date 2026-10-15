import { describe, expect, it } from "vitest";
import { errorMessage, KNOWN_REFUSALS } from "../lib/crew/errors";
import { fromMinor, toMinor } from "../lib/crew/money";
import { planFeatures } from "../lib/crew/plan";
import { lifecycleStates, rateCardPhase, stateIcon } from "../lib/crew/states";
import {
  addDays,
  dayIn,
  hoursFromMinutes,
  isIsoDate,
  isoToZoned,
  mondayOf,
  zonedToIso,
  zoneOffsetMinutes,
} from "../lib/crew/time";
import { withParams, flatParams } from "../lib/crew/query";
import en from "../../../packages/i18n/messages/en-US/crew.json" with { type: "json" };

describe("crew time helpers", () => {
  it("converts zoned form values to instants across daylight saving", () => {
    expect(zonedToIso("2027-06-01T08:00", "America/New_York")).toBe("2027-06-01T12:00:00.000Z");
    expect(zonedToIso("2027-01-15T08:00", "America/New_York")).toBe("2027-01-15T13:00:00.000Z");
    expect(zonedToIso("2027-03-14T12:00", "America/New_York")).toBe("2027-03-14T16:00:00.000Z");
    expect(zonedToIso("not a date", "UTC")).toBeNull();
    expect(isoToZoned("2027-06-01T12:00:00.000Z", "America/New_York")).toBe("2027-06-01T08:00");
    expect(dayIn("2027-06-02T02:00:00.000Z", "America/New_York")).toBe("2027-06-01");
    expect(zoneOffsetMinutes(new Date("2027-06-01T12:00:00Z"), "America/New_York")).toBe(-240);
  });

  it("walks weeks and days", () => {
    expect(mondayOf("2027-06-03")).toBe("2027-05-31");
    expect(mondayOf("2027-05-31")).toBe("2027-05-31");
    expect(mondayOf("2027-06-06")).toBe("2027-05-31");
    expect(addDays("2027-05-31", 7)).toBe("2027-06-07");
    expect(isIsoDate("2027-06-01")).toBe(true);
    expect(isIsoDate("2027-6-1")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(hoursFromMinutes(450)).toBe(7.5);
  });
});

describe("crew money", () => {
  it("keeps blank unpriced and parses minor units exactly", () => {
    expect(toMinor("", 2)).toBeNull();
    expect(toMinor("0", 2)).toBe(0);
    expect(toMinor("12.5", 2)).toBe(1250);
    expect(toMinor("12.345", 2)).toBeUndefined();
    expect(toMinor("abc", 2)).toBeUndefined();
    expect(toMinor("1200", 0)).toBe(1200);
    expect(fromMinor(1250, 2)).toBe("12.50");
    expect(fromMinor(5, 2)).toBe("0.05");
    expect(fromMinor(null, 2)).toBe("");
    expect(fromMinor(1200, 0)).toBe("1200");
  });
});

describe("crew plan, states and refusals", () => {
  it("resolves plan features through extends", () => {
    expect(planFeatures("team").has("payroll_export")).toBe(true);
    expect(planFeatures("pro").has("payroll_export")).toBe(false);
    expect(planFeatures("team").has("upl_export")).toBe(true);
    expect(planFeatures("nonexistent").size).toBe(0);
  });

  it("draws every lifecycle state with an icon", () => {
    expect(stateIcon("shift", "Accepted")).toBe("ready");
    expect(stateIcon("payrollRun", "Unknown")).toBe("proposed");
    expect(lifecycleStates("payPeriod")).toEqual(["Open", "Closed", "Posted"]);
    expect(rateCardPhase({ effectiveFrom: "2027-01-01", effectiveTo: null }, "2026-12-31")).toBe(
      "Upcoming",
    );
    expect(
      rateCardPhase({ effectiveFrom: "2027-01-01", effectiveTo: "2027-06-30" }, "2027-07-01"),
    ).toBe("Ended");
    expect(rateCardPhase({ effectiveFrom: "2027-01-01", effectiveTo: null }, "2027-03-01")).toBe(
      "Current",
    );
  });

  it("has copy for every known refusal and explains each error kind", () => {
    const refusals = en.refusals as Record<string, string>;
    for (const rule of KNOWN_REFUSALS) expect(refusals[rule], rule).toBeTruthy();
    const t = (key: string, values?: Record<string, string | number>) =>
      values ? `${key}:${JSON.stringify(values)}` : key;
    expect(errorMessage(t, { kind: "refusal", rule: "time_entry_overlap", message: "x" })).toBe(
      "crew.refusals.time_entry_overlap",
    );
    expect(errorMessage(t, { kind: "refusal", rule: "new_rule", message: "x" })).toContain(
      "new_rule",
    );
    expect(errorMessage(t, { kind: "not-found" })).toBe("crew.errors.notFound");
    expect(errorMessage(t, { kind: "conflict", message: "x" })).toBe("crew.errors.conflict");
    expect(errorMessage(t, { kind: "invalid", message: "x" })).toBe("crew.errors.invalid");
    expect(errorMessage(t, { kind: "unexpected", message: "x" })).toBe("crew.errors.unexpected");
  });

  it("keeps the query string when changing one key", () => {
    const current = flatParams({ view: "table", state: ["Draft", "Published"], peek: undefined });
    expect(withParams("/o/crew/shifts", current, { peek: "s1" })).toBe(
      "/o/crew/shifts?view=table&state=Draft&peek=s1",
    );
    expect(withParams("/o/crew/shifts", current, { view: null, state: null })).toBe(
      "/o/crew/shifts",
    );
  });
});
