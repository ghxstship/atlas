/**
 * Vendors handlers (A16): vendors with their lifecycle, classes and assignments,
 * prequalifications decided by someone other than the requester, insurance certificates,
 * scorecards and sponsor entitlements. Every read and write runs as the caller, so row level
 * security and A03's RPCs decide. Shapes follow catalog/modules/vendors.ts (ADR 0023).
 */
import {
  decidePrequalification,
  setEntitlementFulfilled,
  transitionVendor,
  type VendorState,
} from "@xos/data/vendors";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { fieldHistory } from "./parts/bulk-edit-and-history.ts";
import { mergeBy } from "./support/enrich.ts";
import { from, groupBy, handlersFor, keysOf, run, tableResource, unwrap } from "./support/table.ts";

const vendors = tableResource("vendors", {
  archivable: true,
  derived: ["counterparty_type", "bank_account_last4"],
  // The last four digits of the vendor's most recent bank account, through the masked view (A54-002).
  enrich: async (rows, { db }) =>
    mergeBy(
      rows,
      "id",
      await groupBy(
        from(db, "vendor_bank_accounts_masked")
          .select("id, vendor_id, account_last4")
          .in("vendor_id", keysOf(rows, "id"))
          .order("id", { ascending: false }),
        "vendor_id",
      ),
      ([latest]) => ({ bank_account_last4: latest?.["account_last4"] ?? null }),
    ),
  extraColumns: ["counterparty_id"],
  // The counterparty type lives on app.counterparties (0301).
  toContract: async (row, { db }) => {
    if (row["counterparty_id"] === undefined) return row;
    const counterparty = await run<{ counterparty_type: string | null } | null>(
      from(db, "counterparties")
        .select("counterparty_type")
        .eq("id", row["counterparty_id"])
        .maybeSingle(),
    );
    return { ...row, counterparty_type: counterparty?.counterparty_type ?? null };
  },
});
const prequalifications = tableResource("prequalifications");
const entitlements = tableResource("sponsorEntitlements");

export const handlers = defineHandlers("Vendors", {
  ...handlersFor("Vendors", vendors),
  ...handlersFor("Vendors", tableResource("vendorClasses")),
  ...handlersFor("Vendors", tableResource("vendorClassAssignments")),
  ...handlersFor("Vendors", prequalifications),
  ...handlersFor("Vendors", tableResource("insuranceCertificates")),
  ...handlersFor("Vendors", tableResource("insuranceCertificateInsureds")),
  ...handlersFor("Vendors", tableResource("requiredAdditionalInsureds")),
  ...handlersFor("Vendors", tableResource("vendorScorecards")),
  ...handlersFor("Vendors", entitlements),

  "vendors.transition": async ({ params, body }, context) => {
    await vendors.read(context, params.id, ["id"]);
    const b = body as { expected_state: string; to_state: string; reason?: string };
    unwrap(
      await transitionVendor(context.db, {
        id: params.id,
        expected: b.expected_state as VendorState,
        next: b.to_state as VendorState,
        reason: b.reason ?? "Changed through the API.",
      }),
    );
    return ok((await vendors.read(context, params.id)) as never);
  },

  "prequalifications.decide": async ({ params, body }, context) => {
    await prequalifications.read(context, params.id, ["id"]);
    const b = body as { decision: "Approved" | "Rejected"; valid_to?: string };
    unwrap(
      await decidePrequalification(context.db, {
        id: params.id,
        decision: b.decision,
        validTo: b.valid_to ?? null,
      }),
    );
    return ok((await prequalifications.read(context, params.id)) as never);
  },

  "sponsorEntitlements.fulfill": async ({ params }, context) => {
    await entitlements.read(context, params.id, ["id"]);
    unwrap(await setEntitlementFulfilled(context.db, params.id, true));
    return ok((await entitlements.read(context, params.id)) as never);
  },

  "sponsorEntitlements.reopen": async ({ params }, context) => {
    await entitlements.read(context, params.id, ["id"]);
    unwrap(await setEntitlementFulfilled(context.db, params.id, false));
    return ok((await entitlements.read(context, params.id)) as never);
  },

  // Field history (A106, migration 1452).
  "vendors.fieldHistory": async ({ params, query }, context) =>
    ok((await fieldHistory(context, "app.vendors", params.id, query.limit)) as never),
});
