import type { PoState, RfqState } from "@xos/data/procurement";
import type { VendorState } from "@xos/data/vendors";
import type { BulkConfig } from "@/components/bulk/types";

/**
 * Bulk edit (Section 11.7) of purchase orders, RFQs and vendors: the properties a person may change
 * across a selection, each offering only the choices the person's capabilities allow. The database
 * checks every row again (migration 2140), so a bulk approval still meets separation of duties, the
 * approval policy and spend authority, and refuses the whole change when one order does not.
 * Goods receipts have no state and keep their receiver, so they have nothing to change in bulk.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The capability each purchase order state a bulk change moves to needs (0331). */
const PO_TARGETS: readonly (readonly [PoState, string])[] = [
  ["Approved", "finance.po.approve"],
  ["Sent", "procurement.po.send"],
  ["Closed", "procurement.po.write"],
  ["Canceled", "procurement.po.write"],
];

/** The same for RFQs. Awarding picks a winner after comparing quotes, so it stays a single move. */
const RFQ_TARGETS: readonly (readonly [RfqState, string])[] = [
  ["Issued", "procurement.rfq.issue"],
  ["Closed", "procurement.bid.unseal"],
  ["Canceled", "procurement.rfq.write"],
];

/** Every state a vendor moves to; Prospect is only where a vendor starts. */
const VENDOR_TARGETS: readonly VendorState[] = ["Onboarded", "Active", "Blocked", "Canceled"];

/** Payment terms offered in bulk, beside any the org's vendors already have. */
export const STANDARD_TERMS_DAYS: readonly number[] = [15, 30, 45, 60, 90];

function stateField(
  key: string,
  targets: readonly (readonly [string, string])[],
  capabilities: ReadonlySet<string>,
  label: string,
  stateLabel: (state: string) => string,
) {
  const options = targets
    .filter(([, capability]) => capabilities.has(capability))
    .map(([state]) => ({ value: state, label: stateLabel(state) }));
  return options.length > 0 ? { key, label, reason: true, options } : null;
}

/** Approve, send, close or cancel a selection of purchase orders. `t` reads the procurement copy. */
export function purchaseOrderBulk(
  org: string,
  capabilities: ReadonlySet<string>,
  t: Translate,
): BulkConfig | null {
  const field = stateField("po_state", PO_TARGETS, capabilities, t("fields.state"), (s) =>
    t(`poStates.${s}`),
  );
  return field ? { org, resource: "purchase_orders", fields: [field] } : null;
}

/** Issue, close or cancel a selection of RFQs. `t` reads the procurement copy. */
export function rfqBulk(
  org: string,
  capabilities: ReadonlySet<string>,
  t: Translate,
): BulkConfig | null {
  const field = stateField("rfq_state", RFQ_TARGETS, capabilities, t("fields.state"), (s) =>
    t(`rfqStates.${s}`),
  );
  return field ? { org, resource: "rfqs", fields: [field] } : null;
}

/**
 * Move a selection of vendors along their lifecycle, or set their payment terms or default
 * currency. Needs vendors.vendor.write. `t` reads the vendors copy; `terms` are the payment terms
 * the org's vendors have now, offered with the standard ones.
 */
export function vendorBulk(
  org: string,
  capabilities: ReadonlySet<string>,
  t: Translate,
  choices: { readonly currencies: readonly string[]; readonly terms: readonly (number | null)[] },
): BulkConfig | null {
  if (!capabilities.has("vendors.vendor.write")) return null;
  const terms = [
    ...new Set([...STANDARD_TERMS_DAYS, ...choices.terms.filter((d) => d !== null)]),
  ].sort((a, b) => a - b);
  return {
    org,
    resource: "vendors",
    fields: [
      {
        key: "vendor_state",
        label: t("fields.state"),
        reason: true,
        options: VENDOR_TARGETS.map((s) => ({ value: s, label: t(`states.${s}`) })),
      },
      {
        key: "payment_terms_days",
        label: t("fields.paymentTerms"),
        options: [
          { value: null, label: t("directory.noTerms") },
          ...terms.map((days) => ({ value: days, label: t("directory.termsDays", { days }) })),
        ],
      },
      {
        key: "default_currency_code",
        label: t("fields.currency"),
        options: [
          { value: null, label: t("directory.noCurrency") },
          ...choices.currencies.map((code) => ({ value: code, label: code })),
        ],
      },
    ],
  };
}
