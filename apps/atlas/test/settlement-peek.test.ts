import type { EngagementRef } from "@xos/data/settlements";
import { describe, expect, it } from "vitest";
import enFinance from "../../../packages/i18n/messages/en-US/finance.json";
import esFinance from "../../../packages/i18n/messages/es-US/finance.json";
import enOpportunities from "../../../packages/i18n/messages/en-US/opportunities.json";
import { engagementOptions } from "@/lib/finance/engagement-options";
import { settlementMoves } from "@/lib/finance/settlement-moves";
import { enumKey } from "@/lib/opportunities/format";

/**
 * Crawl 4.9, Finance > Payments > Settlements: a settlement's author saw no Submit and no reason, and
 * New settlement listed "NWS · Demo Crew Member · Staff" four times.
 */
describe("settlementMoves", () => {
  const finance = { canWrite: true, canApprove: true, canPay: true };

  it("tells the author of a draft why Submit is missing", () => {
    const own = settlementMoves("Proposed", { ...finance, author: true });
    expect(own.allowed).toEqual(["Canceled"]);
    expect(own.ownDraft).toBe(true);
  });

  it("offers Submit to another approver, with no sentence", () => {
    expect(settlementMoves("Proposed", { ...finance, author: false })).toEqual({
      allowed: ["Submitted", "Canceled"],
      ownDraft: false,
    });
  });

  it("says nothing to someone who cannot submit anyway, or once it left the draft", () => {
    expect(
      settlementMoves("Proposed", { ...finance, canApprove: false, author: true }).ownDraft,
    ).toBe(false);
    expect(settlementMoves("Accepted", { ...finance, author: true })).toEqual({
      allowed: ["Paid"],
      ownDraft: false,
    });
  });

  it("has the sentence in both languages", () => {
    expect(enFinance.settlements.ownDraft).toMatch(/someone else submits/);
    expect(esFinance.settlements.ownDraft).toMatch(/otra persona/);
  });
});

describe("engagementOptions", () => {
  const ref = (id: string, extra: Partial<EngagementRef> = {}): EngagementRef => ({
    id,
    projectId: "p1",
    roleType: "Staff",
    state: "Active",
    currency: "USD",
    counterpartyId: null,
    personId: "crew",
    personName: "Demo Crew Member",
    startDate: "2026-11-03",
    ...extra,
  });
  const word = {
    projectKey: () => "NWS",
    party: (e: EngagementRef) => e.personName ?? "",
    role: (r: string) => r,
    state: (s: string) => s,
    day: (d: string) => `from ${d}`,
    numbered: (label: string, n: number) => `${label} (${n})`,
  };

  it("leaves out canceled engagements and names the start day and a state other than Active", () => {
    const options = engagementOptions(
      [
        ref("a"),
        ref("b", { state: "Canceled" }),
        ref("c", { state: "Complete", startDate: "2026-10-01" }),
      ],
      word,
    );
    expect(options).toEqual([
      { value: "a", label: "NWS · Demo Crew Member · Staff · from 2026-11-03" },
      { value: "c", label: "NWS · Demo Crew Member · Staff · from 2026-10-01 · Complete" },
    ]);
  });

  it("numbers options that still read the same, so no two are identical", () => {
    const options = engagementOptions([ref("a"), ref("b"), ref("c"), ref("d")], word);
    expect(new Set(options.map((o) => o.label)).size).toBe(4);
    expect(options[0]?.label).toBe("NWS · Demo Crew Member · Staff · from 2026-11-03 (1)");
  });

  it("words every engagement state and role type through catalog keys that exist", () => {
    for (const s of ["Onboarding", "Blocked", "Active", "Closing", "Complete", "Canceled"]) {
      expect(enOpportunities.engagementStates).toHaveProperty(enumKey(s));
    }
    for (const r of [
      "Client",
      "Vendor",
      "Contractor",
      "Crew",
      "Staff",
      "Artist",
      "Artist Representative",
      "Sponsor",
    ]) {
      expect(enOpportunities.roleTypes).toHaveProperty(enumKey(r));
    }
  });
});
