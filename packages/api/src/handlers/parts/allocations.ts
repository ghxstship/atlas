/**
 * Advance allocations (R7, migrations 2690 to 2697; ADR 0103 and 0104). The producing org reads allocations through
 * app.advance_allocation_status and writes them only through the allocation RPCs, the same @xos/data functions Atlas
 * calls; refusals come back as 422 with the rule. An issue is one event: the handler mints the event id on the first
 * request and the runtime's Idempotency-Key ledger replays the stored response, so a retry never issues twice.
 */
import {
  assignAllocation,
  decideAllocation,
  getAssetClassAvailability,
  issueAllocation,
  listAllocationAllowances,
  rangeBounds,
  releaseReservation,
  requestAllocation,
  reserveAllocation,
  setAllocationRadioChannels,
  splitAllocation,
  unsplitAllocation,
  withdrawAllocation,
  type AllocationInput,
  type IssueItem,
  type ReservationSource,
} from "@xos/data/allocations";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { handlersFor, tableResource, unwrap, type Row } from "../support/table.ts";

const byOrg = <Q extends { eq(column: string, value: string): Q }>(
  q: Q,
  context: { org: { id: string } | null },
) => (context.org === null ? q : q.eq("org_id", context.org.id));

export const allocations = tableResource("advanceAllocations", {
  softDelete: false,
  key: "allocation_id",
  derived: ["needed_from", "needed_to"],
  extraColumns: ["needed_during"],
  toContract: (row) => {
    const window = rangeBounds(row["needed_during"] as string | null);
    const rest: Row = { ...row };
    delete rest["needed_during"];
    return { ...rest, needed_from: window.from, needed_to: window.to };
  },
  scope: byOrg,
});

const conflicts = tableResource("assetReservationConflicts", {
  softDelete: false,
  key: "reservation_id",
  scope: byOrg,
});

export const reservations = tableResource("assetReservations");

type SourceBody = {
  source: "Class Stock" | "Unit" | "Lot" | "Order Line";
  quantity: number;
  asset_unit_id?: string | undefined;
  asset_lot_id?: string | undefined;
  po_line_id?: string | undefined;
};

/** The contract's sources as the repository's; a source missing its id is passed through for the RPC to refuse. */
function toSources(list: readonly SourceBody[] | undefined): ReservationSource[] | null {
  if (!list || list.length === 0) return null;
  return list.map((s) => {
    switch (s.source) {
      case "Unit":
        return { source: "Unit", quantity: 1, assetUnitId: s.asset_unit_id ?? "" };
      case "Lot":
        return { source: "Lot", quantity: s.quantity, assetLotId: s.asset_lot_id ?? "" };
      case "Order Line":
        return { source: "Order Line", quantity: s.quantity, poLineId: s.po_line_id ?? "" };
      default:
        return { source: "Class Stock", quantity: s.quantity };
    }
  });
}

type RequestBody = {
  project_id: string;
  engagement_id?: string | undefined;
  roster_entry_id?: string | undefined;
  credential_category_id?: string | undefined;
  asset_class_id?: string | undefined;
  fulfillment_id?: string | undefined;
  accommodation_block_id?: string | undefined;
  service_kind?: "Travel" | "Per Diem" | undefined;
  quantity: number;
  needed_from: string;
  needed_to: string;
  time_zone: string;
  note?: string | undefined;
};

function toInput(body: RequestBody): AllocationInput {
  const target: AllocationInput["target"] = body.credential_category_id
    ? { kind: "credential", credentialCategoryId: body.credential_category_id }
    : body.asset_class_id
      ? { kind: "asset", assetClassId: body.asset_class_id }
      : body.fulfillment_id
        ? { kind: "catering", fulfillmentId: body.fulfillment_id }
        : body.accommodation_block_id
          ? { kind: "lodging", accommodationBlockId: body.accommodation_block_id }
          : { kind: "service", serviceKind: body.service_kind ?? ("" as "Travel") };
  return {
    projectId: body.project_id,
    // Both or neither are passed through: the RPC refuses allocation_holder_required.
    holder: (body.roster_entry_id
      ? { rosterEntryId: body.roster_entry_id, engagementId: body.engagement_id ?? null }
      : { engagementId: body.engagement_id ?? "" }) as AllocationInput["holder"],
    target,
    quantity: body.quantity,
    neededFrom: body.needed_from,
    neededTo: body.needed_to,
    timeZone: body.time_zone,
    note: body.note ?? null,
  };
}

/** One contract issue item as the repository's, by the allocation's kind. */
function toIssueItem(kind: string, item: Row): IssueItem {
  const s = (k: string) => (typeof item[k] === "string" ? (item[k] as string) : null);
  const n = (k: string) => (typeof item[k] === "number" ? (item[k] as number) : null);
  switch (kind) {
    case "Credential":
    case "Parking Pass":
      return {
        kind: "credential",
        validFrom: s("valid_from"),
        validTo: s("valid_to"),
        rosterVehicleId: s("roster_vehicle_id"),
      };
    case "Asset":
      return s("asset_lot_id")
        ? {
            kind: "lot",
            assetLotId: s("asset_lot_id") ?? "",
            quantity: n("quantity") ?? 0,
            reservationId: s("reservation_id"),
          }
        : { kind: "unit", assetTag: s("asset_tag") ?? "", reservationId: s("reservation_id") };
    case "Catering":
      return { kind: "catering", description: s("description"), quantity: n("quantity") };
    case "Lodging":
      return { kind: "lodging", checkInOn: s("check_in_on"), checkOutOn: s("check_out_on") };
    case "Travel":
      return {
        kind: "travel",
        travelMode: (s("travel_mode") ?? "Flight") as "Flight",
        departsFrom: s("departs_from") ?? "",
        departsAt: s("departs_at") ?? "",
        departsTimeZone: s("departs_time_zone") ?? "",
        arrivesAtPlace: s("arrives_at_place") ?? "",
        arrivesAt: s("arrives_at"),
        arrivesTimeZone: s("arrives_time_zone") ?? "",
        operatorName: s("operator_name"),
        serviceIdentifier: s("service_identifier"),
        confirmationIdentifier: s("confirmation_identifier"),
      };
    default:
      return {
        kind: "per_diem",
        day: s("day") ?? "",
        amountMinor: n("amount_minor") ?? 0,
        currencyCode: s("currency_code") ?? "",
      };
  }
}

export const allocationHandlers = {
  ...handlersFor("Advancing", allocations),
  ...handlersFor("Advancing", conflicts),

  "advanceAllocations.request": async ({ body }, context) => {
    const id = unwrap(await requestAllocation(context.db, toInput(body)));
    return created((await allocations.read(context, id)) as never);
  },

  "advanceAllocations.assign": async ({ body }, context) => {
    const id = unwrap(
      await assignAllocation(context.db, { ...toInput(body), sources: toSources(body.sources) }),
    );
    return created((await allocations.read(context, id)) as never);
  },

  "advanceAllocations.decide": async ({ params, body }, context) => {
    await allocations.read(context, params.allocation_id, ["allocation_id"]);
    unwrap(
      await decideAllocation(context.db, {
        allocationId: params.allocation_id,
        decision: body.decision,
        reason: body.reason ?? null,
        sources: toSources(body.sources),
      }),
    );
    return ok((await allocations.read(context, params.allocation_id)) as never);
  },

  "advanceAllocations.reserve": async ({ params, body }, context) => {
    await allocations.read(context, params.allocation_id, ["allocation_id"]);
    unwrap(
      await reserveAllocation(context.db, params.allocation_id, toSources(body.sources) ?? []),
    );
    return ok((await allocations.read(context, params.allocation_id)) as never);
  },

  "advanceAllocations.split": async ({ params, body }, context) => {
    await allocations.read(context, params.allocation_id, ["allocation_id"]);
    const ids = unwrap(
      await splitAllocation(
        context.db,
        params.allocation_id,
        body.parts.map((p) => ({
          rosterEntryId: p.roster_entry_id,
          quantity: p.quantity,
          assetUnitIds: p.asset_unit_ids ?? [],
        })),
      ),
    );
    return ok({ allocation_ids: ids });
  },

  "advanceAllocations.unsplit": async ({ params, body }, context) => {
    await allocations.read(context, params.allocation_id, ["allocation_id"]);
    return ok({
      quantity: unwrap(
        await unsplitAllocation(context.db, params.allocation_id, body.quantity ?? null),
      ),
    });
  },

  "advanceAllocations.withdraw": async ({ params, body }, context) => {
    await allocations.read(context, params.allocation_id, ["allocation_id"]);
    unwrap(await withdrawAllocation(context.db, params.allocation_id, body.reason ?? null));
    return ok((await allocations.read(context, params.allocation_id)) as never);
  },

  // The runtime replays a repeated Idempotency-Key from its ledger, so the event id is minted once.
  "advanceAllocations.issue": async ({ params, body }, context) => {
    const row = await allocations.read(context, params.allocation_id, ["allocation_id", "kind"]);
    const kind = String(row["kind"]);
    const result = unwrap(
      await issueAllocation(context.db, {
        eventId: crypto.randomUUID(),
        allocationId: params.allocation_id,
        items: body.items.map((i) => toIssueItem(kind, i as Row)),
      }),
    );
    return ok({
      outcome: result.outcome,
      possession: Object.fromEntries(
        Object.entries(result.possession).map(([t, ids]) => [t, [...ids]]),
      ),
    });
  },

  "advanceAllocations.allowances": async ({ query }, context) => {
    const rows = unwrap(await listAllocationAllowances(context.db, query.engagement_id));
    return ok({
      data: rows.map((r) => ({
        offering: r.offering,
        roster_entry_id: r.rosterEntryId,
        mode: r.mode,
        cap: r.cap,
        requested: r.requested,
        approved: r.approved,
        remaining: r.remaining,
        beyond: r.beyond,
      })),
      next_cursor: null,
    });
  },

  "advanceAllocations.setRadioChannels": async ({ params, body }, context) => {
    await allocations.read(context, params.allocation_id, ["allocation_id"]);
    unwrap(
      await setAllocationRadioChannels(context.db, params.allocation_id, body.radio_channel_ids),
    );
    return ok((await allocations.read(context, params.allocation_id)) as never);
  },
} satisfies HandlerSet<"Advancing">;

export const reservationHandlers = {
  ...handlersFor("Assets", reservations),

  "assetReservations.release": async ({ params, body }, context) => {
    await reservations.read(context, params.id, ["id"]);
    unwrap(await releaseReservation(context.db, params.id, body.reason ?? null));
    return ok((await reservations.read(context, params.id)) as never);
  },

  "assetClasses.availability": async ({ params, query }, context) => {
    const a = unwrap(
      await getAssetClassAvailability(context.db, {
        assetClassId: params.id,
        from: query.from,
        to: query.to,
      }),
    );
    return ok({
      serviceable_units: a.serviceableUnits,
      lot_quantity: a.lotQuantity,
      on_order_quantity: a.onOrderQuantity,
      total: a.total,
      peak_reserved: a.peakReserved,
      available: a.available,
      unit_basis: a.unitBasis,
    });
  },
} satisfies HandlerSet<"Assets">;
