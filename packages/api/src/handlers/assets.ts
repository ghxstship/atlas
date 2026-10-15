/**
 * Assets handlers (A12, RRR-24): asset classes, units, lots, identifiers, the custody ledger,
 * maintenance and damage, the unit lifecycle, and the scan back end Compass calls. Every call runs
 * as the caller, so row level security and the guards of 0352, 0450 and 0975 decide; refusals come
 * back as 422 with their rule. Shapes follow the corrected catalog (catalog/modules/assets.ts,
 * ADR 0023).
 */
import { applyAssetScanEvent, resolveAssetScan, type ScanAction } from "@xos/data/assets";
import { refused } from "../problem.ts";
import { requireOrg } from "../runtime/context.ts";
import { defineHandlers, noContent, ok } from "../runtime/handler.ts";
import { from, handlersFor, rpc, run, tableResource, unwrap, type Row } from "./support/table.ts";

const classes = tableResource("assetClasses", { verbs: ["list", "get", "create", "update"] });

const units = tableResource("assetUnits", { fixed: ["asset_tag"] });

const lots = tableResource("assetLots", {
  derived: ["on_hand"],
  toContract: async (row, context) => {
    const balance = await run<{ on_hand: number | string } | null>(
      from(context.db, "asset_lot_balances")
        .select("on_hand")
        .eq("asset_lot_id", String(row["id"]))
        .maybeSingle(),
    );
    return { ...row, on_hand: Number(balance?.on_hand ?? row["quantity"]) };
  },
});

const identifiers = tableResource("assetIdentifiers");

const custody = tableResource("assetCustodyEntries");

const maintenance = tableResource("assetMaintenanceEvents");

const damage = tableResource("assetDamageReports");

export const handlers = defineHandlers("Assets", {
  ...handlersFor("Assets", classes),
  /** Archives a class that holds no live units or lots (asset_class_in_use otherwise). */
  "assetClasses.delete": async ({ params }, context) => {
    await classes.read(context, params.id, ["id"]);
    for (const table of ["asset_units", "asset_lots"]) {
      const live = await run<Row[]>(
        from(context.db, table)
          .select("id")
          .eq("asset_class_id", params.id)
          .is("deleted_at", null)
          .limit(1),
      );
      if (live.length > 0) {
        throw refused(
          "REFUSE",
          "An asset class with units or lots stays until they go.",
          "asset_class_in_use",
        );
      }
    }
    await run(
      from(context.db, "asset_classes")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", params.id)
        .is("deleted_at", null),
    );
    return noContent();
  },

  ...handlersFor("Assets", units),
  "assetUnits.transition": async ({ params, body }, context) => {
    await units.read(context, params.id, ["id"]);
    if (body.reason === undefined || body.reason.trim().length === 0) {
      throw refused("REFUSE", "Every state change carries a reason.", "transition_reason_required");
    }
    await run(
      rpc(context.db, "transition_asset", {
        p_asset_unit_id: params.id,
        p_expected: body.expected_state,
        p_next: body.to_state,
        p_reason: body.reason.trim(),
      }),
    );
    return ok((await units.read(context, params.id)) as never);
  },
  /**
   * Resolves a scanned code to its unit (app.resolve_asset_code). A code no unit carries, one two
   * units carry, or a lot label is refused with NO_ANSWER: this operation answers with a unit.
   */
  "assetUnits.scan": async ({ body }, context) => {
    const org = requireOrg(context);
    const found = await resolveAssetScan(context.db, { orgId: org.id, code: body.code });
    if (!found.ok) {
      if (found.error.kind === "refusal") {
        throw refused("NO_ANSWER", "No single asset unit carries this code.", found.error.rule);
      }
      unwrap(found);
      throw refused("NO_ANSWER", "No single asset unit carries this code.", "asset_code_unknown");
    }
    if (found.data.kind !== "unit") {
      throw refused("NO_ANSWER", "This code is a lot label, not an asset unit.", "asset_scan_lot");
    }
    return ok((await units.read(context, found.data.unit.id)) as never);
  },
  /** One idempotent custody move from a device (app.apply_asset_scan). */
  "assetUnits.applyScan": async ({ body }, context) => {
    const org = requireOrg(context);
    const result = unwrap(
      await applyAssetScanEvent(context.db, {
        eventId: body.event_id,
        orgId: org.id,
        code: body.code,
        action: body.action as ScanAction,
        membershipId: body.custodian_membership_id ?? null,
        engagementId: body.custodian_engagement_id ?? null,
        venueId: body.venue_id ?? null,
        projectId: body.project_id ?? null,
        note: body.note ?? null,
        quantity: body.quantity ?? null,
      }),
    );
    const response: Row = {
      outcome: result.outcome,
      subject_kind: result.kind,
      subject_id: result.subjectId,
      ledger_id: result.ledgerId,
      asset_state: result.state,
      on_hand: result.onHand,
    };
    return ok(response as never);
  },

  ...handlersFor("Assets", lots),
  ...handlersFor("Assets", identifiers),
  ...handlersFor("Assets", custody),
  ...handlersFor("Assets", maintenance),
  ...handlersFor("Assets", damage),
});
