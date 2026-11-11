import { describe, expect, it } from "vitest";
import { poApprovalState, type PoApprovalPolicy } from "@/lib/procurement/po-approval";

/**
 * Crawl 4.9: a PO's Approve was offered to its creator and refused with sod_po_creator; while a
 * policy was pending it refused with approval_policy_pending and the page had no submit action; and a
 * $65,000 order cleared its policy with nobody holding a limit that covers it.
 */
const now = new Date("2026-11-10T12:00:00Z");
const order = { id: "po1", currencyCode: "USD", createdBy: "producer" };
const policy: PoApprovalPolicy = {
  id: "pol",
  name: "Orders over $1,000",
  documentType: "Purchase Order",
  state: "Active",
  currency: "USD",
  appliesAboveMinor: 100_000,
};
const authority = (
  limitMinor: number,
  extra: Partial<{ narrowed: boolean; validTo: string | null; currencyCode: string }> = {},
) => ({
  documentType: "Purchase Order",
  currencyCode: "USD",
  limitMinor,
  validFrom: "2026-01-01T00:00:00Z",
  validTo: null,
  narrowed: false,
  ...extra,
});
const base = {
  order,
  totalMinor: 450_000,
  viewerPersonId: "finance",
  policies: [policy],
  approvals: [],
  authorities: [authority(5_000_000)],
  now,
};

describe("poApprovalState", () => {
  it("marks the creator, who never approves their own order", () => {
    expect(poApprovalState({ ...base, viewerPersonId: "producer" }).creator).toBe(true);
    expect(poApprovalState(base).creator).toBe(false);
    expect(poApprovalState({ ...base, viewerPersonId: null }).creator).toBe(false);
  });

  it("asks to submit while an Active policy applies and nothing covers the total", () => {
    expect(poApprovalState(base).policy).toEqual({ kind: "submit", policyName: policy.name });
  });

  it("says in review while the order's approval waits on a step", () => {
    const approvals = [
      {
        documentType: "Purchase Order",
        documentId: "po1",
        state: "In Review",
        currency: "USD",
        amountMinor: 450_000,
      },
    ];
    expect(poApprovalState({ ...base, approvals }).policy).toEqual({
      kind: "inReview",
      policyName: policy.name,
    });
  });

  it("clears the policy once an Approved approval covers the total in its currency", () => {
    const approved = (amountMinor: number, currency = "USD") => [
      {
        documentType: "Purchase Order",
        documentId: "po1",
        state: "Approved",
        currency,
        amountMinor,
      },
    ];
    expect(poApprovalState({ ...base, approvals: approved(450_000) }).policy.kind).toBe("approved");
    // An approval for less than the order now totals, or in another currency, does not cover it.
    expect(poApprovalState({ ...base, approvals: approved(400_000) }).policy.kind).toBe("submit");
    expect(poApprovalState({ ...base, approvals: approved(450_000, "EUR") }).policy.kind).toBe(
      "submit",
    );
  });

  it("follows the policy threshold the way the database applies it", () => {
    expect(poApprovalState({ ...base, totalMinor: 100_000 }).policy.kind).toBe("none");
    expect(poApprovalState({ ...base, totalMinor: null }).policy.kind).toBe("submit");
    expect(poApprovalState({ ...base, order: { ...order, currencyCode: "EUR" } }).policy.kind).toBe(
      "submit",
    );
    expect(
      poApprovalState({ ...base, policies: [{ ...policy, state: "Retired" }] }).policy.kind,
    ).toBe("none");
    expect(
      poApprovalState({ ...base, policies: [{ ...policy, documentType: "Expense" }] }).policy.kind,
    ).toBe("none");
  });

  it("flags a total no spend authority covers, the $65,000 order of the crawl", () => {
    const big = { ...base, totalMinor: 6_500_000, authorities: [authority(5_000_000)] };
    expect(poApprovalState(big).uncovered).toBe(true);
    expect(poApprovalState({ ...big, authorities: [authority(10_000_000)] }).uncovered).toBe(false);
    // A narrowed, expired or other-currency limit never applies to an order.
    for (const extra of [
      { narrowed: true },
      { validTo: "2026-06-01T00:00:00Z" },
      { currencyCode: "EUR" },
    ]) {
      expect(
        poApprovalState({ ...big, authorities: [authority(10_000_000, extra)] }).uncovered,
      ).toBe(true);
    }
    // An unpriced order is refused as unpriced first, so it is not flagged.
    expect(poApprovalState({ ...big, totalMinor: null }).uncovered).toBe(false);
  });
});
