import { SETTLEMENT_ORG_NEXT, type SettlementState } from "@xos/data/settlements";

/**
 * The moves a settlement's peek offers the viewer, and whether to say why Submit is missing (crawl
 * 4.9). Submitting is an approval: it needs finance.invoice.approve and never comes from the person
 * who drafted the settlement (separation of duties), so its author sees a sentence instead of a
 * missing button, as the expense peek does.
 */
export function settlementMoves(
  state: SettlementState,
  viewer: {
    readonly canWrite: boolean;
    readonly canApprove: boolean;
    readonly canPay: boolean;
    /** The viewer drafted the settlement. */
    readonly author: boolean;
  },
): { readonly allowed: SettlementState[]; readonly ownDraft: boolean } {
  const next = SETTLEMENT_ORG_NEXT[state];
  const allowed = next.filter((n) =>
    n === "Submitted"
      ? viewer.canApprove && !viewer.author
      : n === "Paid"
        ? viewer.canPay
        : viewer.canWrite,
  );
  return {
    allowed,
    ownDraft: next.includes("Submitted") && viewer.canApprove && viewer.author,
  };
}
