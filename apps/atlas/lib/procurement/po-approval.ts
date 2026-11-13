/**
 * What a Proposed purchase order's page says about its approval (crawl 4.9), from what the viewer
 * can read. The database decides every approval (app.approve_purchase_order,
 * private.approve_under_spend_authority); this only words the next step so Approve is never a dead
 * end:
 *   * the creator never approves their own order (sod_po_creator), so Approve is not offered to them;
 *   * while an Active purchase order policy applies (private.applicable_approval_policy) and no
 *     Approved approval covers the order's total in its currency, the order is submitted first, or
 *     is in review on Approvals;
 *   * when no spend authority in the org covers the total in the order's currency, nobody can give
 *     the final approval until an Owner or Admin sets a limit (an order passes no GL account or cost
 *     center, so a narrowed limit never applies to it).
 */

export interface PoApprovalPolicy {
  readonly id: string;
  readonly name: string;
  readonly documentType: string;
  readonly state: string;
  readonly currency: string | null;
  readonly appliesAboveMinor: number | null;
}

export interface PoApprovalInstance {
  readonly documentType: string;
  readonly documentId: string;
  readonly state: string;
  readonly currency: string;
  readonly amountMinor: number;
}

export interface PoSpendAuthority {
  readonly documentType: string;
  readonly currencyCode: string;
  readonly limitMinor: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly narrowed: boolean;
}

export type PoPolicyStep =
  | { readonly kind: "none" }
  | { readonly kind: "approved" }
  | { readonly kind: "submit"; readonly policyName: string }
  | { readonly kind: "inReview"; readonly policyName: string };

export interface PoApprovalState {
  /** The viewer created the order, so someone else approves it. */
  readonly creator: boolean;
  readonly policy: PoPolicyStep;
  /** No spend authority covers the priced total in the order's currency. */
  readonly uncovered: boolean;
}

const PO = "Purchase Order";

/** The Active purchase order policy that applies to this total and currency, as the database picks it. */
function applicablePolicy(
  policies: readonly PoApprovalPolicy[],
  totalMinor: number | null,
  currency: string,
): PoApprovalPolicy | null {
  return (
    policies.find(
      (p) =>
        p.documentType === PO &&
        p.state === "Active" &&
        (p.appliesAboveMinor === null ||
          p.currency !== currency ||
          totalMinor === null ||
          totalMinor > p.appliesAboveMinor),
    ) ?? null
  );
}

export function poApprovalState(input: {
  readonly order: {
    readonly id: string;
    readonly currencyCode: string;
    readonly createdBy: string | null;
  };
  readonly totalMinor: number | null;
  readonly viewerPersonId: string | null;
  readonly policies: readonly PoApprovalPolicy[];
  readonly approvals: readonly PoApprovalInstance[];
  readonly authorities: readonly PoSpendAuthority[];
  readonly now: Date;
}): PoApprovalState {
  const { order, totalMinor } = input;
  const creator = input.viewerPersonId !== null && input.viewerPersonId === order.createdBy;
  const own = input.approvals.filter((a) => a.documentType === PO && a.documentId === order.id);
  const covered = own.some(
    (a) =>
      a.state === "Approved" &&
      a.currency === order.currencyCode &&
      totalMinor !== null &&
      a.amountMinor >= totalMinor,
  );
  const policy = applicablePolicy(input.policies, totalMinor, order.currencyCode);
  const step: PoPolicyStep =
    policy === null
      ? { kind: "none" }
      : covered
        ? { kind: "approved" }
        : own.some((a) => a.state === "In Review")
          ? { kind: "inReview", policyName: policy.name }
          : { kind: "submit", policyName: policy.name };
  const now = input.now.getTime();
  const uncovered =
    totalMinor !== null &&
    !input.authorities.some(
      (a) =>
        a.documentType === PO &&
        a.currencyCode === order.currencyCode &&
        !a.narrowed &&
        Date.parse(a.validFrom) <= now &&
        (a.validTo === null || Date.parse(a.validTo) > now) &&
        a.limitMinor >= totalMinor,
    );
  return { creator, policy: step, uncovered };
}
