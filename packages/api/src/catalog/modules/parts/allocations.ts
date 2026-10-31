/**
 * Advance allocations in the public API (R7, RRR-187; migrations 2690 to 2697, ADR 0103 and 0104). Additive only (v1
 * is frozen, Section 10.1):
 *
 *   * `advanceAllocations` reads app.advance_allocation_status, the computed status of each allocation, and carries
 *     the writes as actions: request, assign, decide, reserve, split, unsplit, withdraw and issue (one issue event per
 *     request: the handler mints the event id once and the Idempotency-Key ledger replays the response), with the
 *     parity reads and writes `allowances` (G-174) and `setRadioChannels` (G-91).
 *   * `assetReservationConflicts` lists the holds that no longer fit what can supply them (G-93).
 *   * `assetReservations` reads the holds, with `release`, and `assetClasses.availability` says how many of a class
 *     are free over a window (G-93).
 *
 * The parking category kind and the asset class offering enter the frozen `credentialCategories` and `assetClasses`
 * through correction entries in their module files.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { orNull } from "../../correct.ts";
import {
  collectionAction,
  collectionQuery,
  itemAction,
  itemQuery,
  resource,
} from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const KINDS = [
  "Credential",
  "Parking Pass",
  "Asset",
  "Catering",
  "Lodging",
  "Travel",
  "Per Diem",
] as const;
const STATES = ["Requested", "Approved", "Declined", "Withdrawn"] as const;
const ORIGINS = ["Requested", "Assigned", "Split"] as const;
const OFFERINGS = [
  "Travel",
  "Lodging",
  "Catering",
  "Parking",
  "Uniforms",
  "Per Diem",
  "Radios",
  "Carts",
  "Guest List",
] as const;
export const DISPLAY_STATUSES = [
  "Requested",
  "Approved",
  "Reserved",
  "Awaiting Order",
  "On Order",
  "Confirmed",
  "Received",
  "Partly Issued",
  "Issued",
  "Returned",
  "Revoked",
  "Declined",
  "Withdrawn",
] as const;
export const CONFLICTS = [
  "Unit Unavailable",
  "Class Over Reserved",
  "Lot Over Reserved",
  "Order Short",
] as const;
const RELEASE_REASONS = [
  "Withdrawn",
  "Entry Removed",
  "Engagement Ended",
  "Split",
  "Released By Reviewer",
] as const;
const SOURCES = ["Class Stock", "Unit", "Lot", "Order Line"] as const;

const qty = (description: string, example: number) => z.number().meta({ description, example });
const text = (description: string, example: string) => z.string().meta({ description, example });
const reason = (description: string, example: string) =>
  z.string().min(1).max(1000).optional().meta({ description, example });

// Reads ----------------------------------------------------------------------------------------------------------

const AdvanceAllocation = defineResource({
  name: "AdvanceAllocation",
  table: "app.advance_allocation_status",
  base: "view",
  key: "allocation_id",
  description:
    "What a production allocates to a party's pool or to one person on its roster (R7, ADR 0104): one badge category, parking pass, asset class, catering, accommodation block, trip or per diem, for a window. Requested, Approved, Declined and Withdrawn are stored; held, ordered, confirmed, received, issued, returned and revoked are computed from the rows that own them, and display_status reads them in order. No prices. Read with advancing.packet.read on the project.",
  fields: {
    allocation_id: fields.uuid("Identifier of the allocation."),
    org_id: fields.ref("producing org"),
    project_id: fields.ref("project"),
    holder_engagement_id: orNull(
      fields.ref("party pool's engagement; null when a person holds it"),
    ),
    roster_entry_id: orNull(fields.ref("roster entry of the person who holds it; null for a pool")),
    parent_allocation_id: orNull(fields.ref("pool a share was split from")),
    kind: z.enum(KINDS).meta({ description: "What the allocation gives.", example: "Asset" }),
    offering: orNull(
      z.enum(OFFERINGS).meta({
        description: "Offering it draws on; null for a badge or a site asset.",
        example: "Radios",
      }),
    ),
    item_name: orNull(
      text(
        "Category, class, catering or block name; null for Travel and Per Diem.",
        "Two-way radios",
      ),
    ),
    quantity: qty("Quantity allocated.", 6),
    allocation_state: z.enum(STATES).meta({ description: "Stored state.", example: "Approved" }),
    origin: z
      .enum(ORIGINS)
      .meta({ description: "How the allocation came to be.", example: "Requested" }),
    needed_from: fields.instant("When it is first needed."),
    needed_to: fields.instant("When it is no longer needed."),
    needed_time_zone: fields.timeZone("IANA time zone of the window."),
    requested_by: orNull(fields.ref("person who requested or assigned it")),
    decided_at: orNull(fields.instant("When it was approved or declined.")),
    decided_by: orNull(fields.ref("person who approved or declined it")),
    decline_reason: orNull(text("Why it was declined.", "Kai already has a badge.")),
    reserved_quantity: qty("Quantity of live holds.", 6),
    on_order_quantity: qty("Order-line holds on Approved or Sent orders not yet received.", 2),
    confirmed: fields.bool("Every ordering order behind its holds was acknowledged.", false),
    awaiting_order: fields.bool("An order behind its holds is still Proposed.", false),
    received_quantity: qty("Received on the order lines behind its holds.", 0),
    issued_quantity: qty("Issued from the possession rows.", 2),
    returned_quantity: qty("Issued and checked in since.", 0),
    lost_quantity: qty("Issued units that went Lost.", 0),
    revoked_quantity: qty("Issued credentials since revoked.", 0),
    display_status: z
      .enum(DISPLAY_STATUSES)
      .meta({ description: "The computed status.", example: "Partly Issued" }),
  },
});

const AssetReservationConflict = defineResource({
  name: "AssetReservationConflict",
  table: "app.asset_reservation_conflicts",
  base: "view",
  key: "reservation_id",
  description:
    "A live hold that no longer fits what can supply it (G-93), one row per conflict: the pinned unit is Damaged, In Maintenance, Lost, Retired or Returned; the class or lot is over reserved; or the order behind it is Canceled or short. Computed, never stored.",
  fields: {
    reservation_id: fields.ref("hold"),
    allocation_id: fields.ref("allocation the hold serves"),
    org_id: fields.ref("org"),
    project_id: fields.ref("project"),
    asset_class_id: fields.ref("class held"),
    asset_unit_id: orNull(fields.ref("pinned unit")),
    asset_lot_id: orNull(fields.ref("lot")),
    po_line_id: orNull(fields.ref("order line")),
    quantity: qty("Quantity held.", 1),
    conflict: z
      .enum(CONFLICTS)
      .meta({ description: "What no longer fits.", example: "Unit Unavailable" }),
  },
});

const AssetReservation = defineResource({
  name: "AssetReservation",
  table: "app.asset_reservations",
  description:
    "A hold of an approved asset allocation (R7, ADR 0104): a quantity held from class stock, a pinned unit, a lot or the order line the item arrives on, until it is released. Class, window and holder are the allocation's. Written by the allocation actions.",
  fields: {
    project_id: fields.ref("project of the allocation"),
    advance_allocation_id: fields.ref("allocation the hold serves"),
    asset_unit_id: orNull(fields.ref("pinned unit")),
    asset_lot_id: orNull(fields.ref("lot held from")),
    po_line_id: orNull(fields.ref("order line held on")),
    quantity: qty("Quantity held.", 1),
    released_at: orNull(fields.instant("When the hold was released.")),
    release_reason: orNull(
      z.enum(RELEASE_REASONS).meta({ description: "Why it was released.", example: "Split" }),
    ),
  },
  serverSet: [
    "project_id",
    "advance_allocation_id",
    "asset_unit_id",
    "asset_lot_id",
    "po_line_id",
    "quantity",
    "released_at",
    "release_reason",
  ],
});

// Writes ---------------------------------------------------------------------------------------------------------

const Source = z
  .object({
    source: z
      .enum(SOURCES)
      .meta({ description: "Where the stock comes from.", example: "Class Stock" }),
    quantity: z.number().positive().meta({ description: "Quantity held from it.", example: 4 }),
    asset_unit_id: fields.ref("unit, for a Unit source").optional(),
    asset_lot_id: fields.ref("lot, for a Lot source").optional(),
    po_line_id: fields.ref("order line, for an Order Line source").optional(),
  })
  .meta({
    id: "AllocationSource",
    description: "One hold source; mixed supply is one source each.",
  });

const sources = z.array(Source).min(1).optional().meta({
  description:
    "Holds for an asset allocation, summing to its quantity. Left out, class stock holds it when the class has units, else its only lot.",
});

const AllocationRequest = z
  .object({
    project_id: fields.ref("project"),
    engagement_id: fields.ref("party pool's engagement; give this or roster_entry_id").optional(),
    roster_entry_id: fields
      .ref("roster entry of one person; give this or engagement_id")
      .optional(),
    credential_category_id: fields.ref("badge or parking category").optional(),
    asset_class_id: fields.ref("asset class, such as the org's radios").optional(),
    fulfillment_id: fields.ref("catering fulfillment").optional(),
    accommodation_block_id: fields.ref("accommodation block").optional(),
    service_kind: z
      .enum(["Travel", "Per Diem"])
      .optional()
      .meta({ description: "Travel or Per Diem.", example: "Travel" }),
    quantity: z.number().positive().meta({ description: "Quantity.", example: 6 }),
    needed_from: fields.instant("When it is first needed."),
    needed_to: fields.instant("When it is no longer needed."),
    time_zone: fields.timeZone("IANA time zone of the window."),
    note: reason(
      "Note; above the allowance with overflow at review, the reason for an assignment.",
      "For the audio crew.",
    ),
  })
  .meta({
    id: "AdvanceAllocationRequest",
    description: "One allocation: one holder and one target.",
  });

const AllocationAssign = AllocationRequest.extend({ sources }).meta({
  id: "AdvanceAllocationAssign",
  description: "One allocation assigned directly, with its holds for an asset.",
});

const Decision = z
  .object({
    decision: z
      .enum(["Approved", "Rejected"])
      .meta({ description: "Approve, or reject (decline).", example: "Approved" }),
    reason: reason(
      "Required to decline, and to approve above the allowance with overflow at review.",
      "Spare for monitors.",
    ),
    sources,
  })
  .meta({ id: "AdvanceAllocationDecision", description: "A decision on a Requested allocation." });

const Reserve = z
  .object({ sources: z.array(Source).min(1).meta({ description: "The new holds." }) })
  .meta({
    id: "AdvanceAllocationReserve",
    description: "Holds that replace an approved asset allocation's holds.",
  });

const Split = z
  .object({
    parts: z
      .array(
        z
          .object({
            roster_entry_id: fields.ref("roster entry on the pool's engagement"),
            quantity: z
              .number()
              .positive()
              .meta({ description: "Quantity for the person.", example: 2 }),
            asset_unit_ids: z
              .array(z.uuid())
              .optional()
              .meta({ description: "Units pinned to the person.", example: [fields.EXAMPLE_UUID] }),
          })
          .meta({ id: "AdvanceAllocationSplitPart", description: "One person's share." }),
      )
      .min(1),
  })
  .meta({
    id: "AdvanceAllocationSplit",
    description: "Shares of an approved party pool for its people.",
  });

const SplitResult = z
  .object({
    allocation_ids: z
      .array(z.uuid())
      .meta({ description: "The shares, in the order given.", example: [fields.EXAMPLE_UUID] }),
  })
  .meta({ id: "AdvanceAllocationSplitResult", description: "The shares written." });

const Unsplit = z
  .object({
    quantity: z
      .number()
      .positive()
      .optional()
      .meta({ description: "How much goes back; all of it when left out.", example: 1 }),
  })
  .meta({ id: "AdvanceAllocationUnsplit", description: "A share returned to its pool." });

const UnsplitResult = z
  .object({ quantity: qty("Quantity returned to the pool.", 1) })
  .meta({ id: "AdvanceAllocationUnsplitResult", description: "What went back." });

const Withdraw = z
  .object({ reason: reason("Why it is withdrawn.", "No longer needed.") })
  .meta({ id: "AdvanceAllocationWithdraw", description: "Withdrawing an allocation." });

const IssueItem = z
  .object({
    valid_from: fields
      .instant("Badge or pass: valid from; the window start by default.")
      .optional(),
    valid_to: fields.instant("Badge or pass: valid until; the window end by default.").optional(),
    roster_vehicle_id: fields.ref("parking pass: the holder's roster vehicle").optional(),
    asset_unit_id: fields.ref("unit issued").optional(),
    asset_tag: text("Unit issued, by tag.", "NWL-RAD-001").optional(),
    asset_lot_id: fields.ref("lot a quantity is issued from").optional(),
    reservation_id: fields.ref("hold the item is issued against; picked when left out").optional(),
    quantity: z
      .number()
      .positive()
      .optional()
      .meta({ description: "Lot or catering quantity.", example: 1 }),
    description: text("Catering: what is provided.", "Crew lunch").optional(),
    check_in_on: fields.date("Lodging: first night.").optional(),
    check_out_on: fields.date("Lodging: departure date.").optional(),
    travel_mode: z
      .enum(["Flight", "Ground"])
      .optional()
      .meta({ description: "Travel: mode.", example: "Flight" }),
    operator_name: text("Travel: airline or operator.", "Delta").optional(),
    service_identifier: text("Travel: flight or service number.", "DL 1220").optional(),
    confirmation_identifier: text("Travel: booking confirmation.", "QX7P2L").optional(),
    departs_from: text("Travel: departure place.", "BOS").optional(),
    departs_at: fields.instant("Travel: departure time.").optional(),
    departs_time_zone: fields.timeZone("Travel: zone of the departure.").optional(),
    arrives_at_place: text("Travel: arrival place.", "MIA").optional(),
    arrives_at: fields.instant("Travel: arrival time.").optional(),
    arrives_time_zone: fields.timeZone("Travel: zone of the arrival.").optional(),
    day: fields.date("Per diem: the day, inside the window.").optional(),
    amount_minor: orNull(
      z.int().meta({ description: "Per diem: amount in minor units.", example: 5000 }),
    ).optional(),
    currency_code: z
      .string()
      .length(3)
      .optional()
      .meta({ description: "Per diem: ISO 4217 currency.", example: "USD" }),
  })
  .meta({
    id: "AdvanceAllocationIssueItem",
    description: "One item handed over; the keys depend on the kind.",
  });

const Issue = z
  .object({ items: z.array(IssueItem).min(1).meta({ description: "Items handed over." }) })
  .meta({ id: "AdvanceAllocationIssue", description: "One issue event." });

const IssueResult = z
  .object({
    outcome: z
      .enum(["applied", "duplicate"])
      .meta({ description: "applied, or duplicate for a replay.", example: "applied" }),
    possession: z.record(z.string(), z.array(z.uuid())).meta({
      description: "Ids of the possession rows written, by table.",
      example: { asset_custody: [fields.EXAMPLE_UUID] },
    }),
  })
  .meta({ id: "AdvanceAllocationIssueResult", description: "What one issue event wrote." });

const Allowance = z
  .object({
    offering: z.enum(OFFERINGS).meta({ description: "Offering.", example: "Radios" }),
    roster_entry_id: orNull(fields.ref("roster entry; null for the pool row")),
    mode: text("How the offering reaches the engagement.", "Provided"),
    cap: orNull(qty("Cap; null for none.", 6)),
    requested: qty("Live Requested quantity under it.", 0),
    approved: qty("Live Approved quantity under it.", 4),
    remaining: orNull(qty("Cap less requested and approved, never below 0.", 2)),
    beyond: orNull(qty("How far requested and approved go beyond the cap.", 0)),
  })
  .meta({
    id: "AllocationAllowance",
    description: "What remains of an offering's cap for a pool or a person (G-174).",
  });

const RadioChannels = z
  .object({
    radio_channel_ids: z
      .array(z.uuid())
      .max(16)
      .meta({ description: "The project's channels, 0 to 16.", example: [fields.EXAMPLE_UUID] }),
  })
  .meta({
    id: "AllocationRadioChannels",
    description: "The radio channels a radio allocation is programmed with, as a whole.",
  });

const Availability = z
  .object({
    serviceable_units: qty("Serviceable owned units.", 4),
    lot_quantity: qty("Owned lot quantity.", 0),
    on_order_quantity: qty("Quantity on order that covers the window.", 2),
    total: qty("All the class can supply over the window.", 6),
    peak_reserved: qty("Most held at once over the window.", 2),
    available: qty("Total less the peak, never below 0.", 4),
    unit_basis: text("Unit of the class element.", "each"),
  })
  .meta({
    id: "AssetClassAvailability",
    description: "How many of an asset class are free over a window (G-93).",
  });

const ALLOCATION_REFUSALS =
  "Refusals answer 422 with the rule, among them offering_not_offered, offering_not_provided, allocation_cap_engagement, allocation_cap_person, allocation_over_allowance_reason, allocation_engagement_closed and allocation_entry_not_accepted";

export const allocationResources: readonly ResourceSpec[] = [
  resource("Advancing", "/advance-allocations", AdvanceAllocation, {
    verbs: ["list", "get"],
    order: { by: ["allocation_id"], numeric: false, descending: true },
    actions: [
      collectionAction("request", {
        summary: "Request an allocation",
        description: `Production requests an allocation for a party's pool or one person on a roster through \`app.request_allocation\`; it starts Requested for a reviewer. Needs advancing.packet.write on the project. ${ALLOCATION_REFUSALS}.`,
        body: AllocationRequest,
        status: 201,
        rpc: "app.request_allocation",
      }),
      collectionAction("assign", {
        summary: "Assign an allocation",
        description: `A reviewer assigns an allocation directly through \`app.assign_allocation\`: Approved at once and, for an asset, held from the sources. Needs advancing.submission.review on the project. ${ALLOCATION_REFUSALS}, reservation_over_capacity and allocation_sources_required.`,
        body: AllocationAssign,
        status: 201,
        rpc: "app.assign_allocation",
      }),
      itemAction("decide", {
        summary: "Approve or decline an allocation",
        description:
          "Decides a Requested allocation through `app.decide_allocation`, never by its requester (422 sod_allocation_requester). Declining needs a reason (allocation_reason_required); approving holds an asset's stock (allocation_sources_required, reservation_over_capacity) and, above the allowance with overflow at review, needs a reason that goes in the ledger (allocation_over_allowance_reason).",
        body: Decision,
        rpc: "app.decide_allocation",
      }),
      itemAction("reserve", {
        summary: "Replace an allocation's holds",
        description:
          "Replaces the holds of an Approved asset allocation before anything of it is issued, through `app.reserve_allocation` (422 allocation_issued). Needs advancing.submission.review.",
        body: Reserve,
        rpc: "app.reserve_allocation",
      }),
      itemAction("split", {
        summary: "Split a party pool to its people",
        description:
          "Gives shares of an approved party pool to accepted people on its roster through `app.split_allocation`, moving holds with them (422 allocation_not_pool, allocation_split_exceeds, allocation_cap_person). Needs advancing.packet.write.",
        body: Split,
        response: SplitResult,
        rpc: "app.split_allocation",
      }),
      itemAction("unsplit", {
        summary: "Return a share to its pool",
        description:
          "Returns part or all of a share to its pool through `app.unsplit_allocation`, never what was issued (422 allocation_issued). A share returned whole is Withdrawn.",
        body: Unsplit,
        response: UnsplitResult,
        rpc: "app.unsplit_allocation",
      }),
      itemAction("withdraw", {
        summary: "Withdraw an allocation",
        description:
          "Withdraws a Requested allocation, or an Approved one with nothing of it out (422 allocation_issued), through `app.withdraw_allocation`, by its requester or a holder of advancing.packet.write; holds are released.",
        body: Withdraw,
        rpc: "app.withdraw_allocation",
      }),
      itemAction("issue", {
        summary: "Issue an allocation",
        description:
          "Hands over part or all of an Approved allocation in one transaction through `app.issue_allocation`: badges and passes, units by tag, lot quantities, catering lines, rooms, trips or per diem days. Needs the kind's capability on the project (credentials.credential.issue, assets.custody.write, hospitality.fulfillment.write, hospitality.accommodation.write or crew.time_entry.write). The issuer is never the person (422 allocation_self_issue), kinds other than equipment go to one person (allocation_needs_person) and nothing goes beyond the quantity (allocation_issue_exceeds). A replay with the same Idempotency-Key returns the original response.",
        body: Issue,
        response: IssueResult,
        rpc: "app.issue_allocation",
      }),
      collectionQuery("allowances", {
        summary: "Read an engagement's remaining allowances",
        description:
          "Per offering, the cap, what is requested and approved under it, what remains and what goes beyond, for the engagement's pool and each person on its roster, through `app.allocation_allowances` (G-174). A person on the roster reads only their own rows; 404 without standing.",
        query: z.object({ engagement_id: fields.ref("engagement") }),
        paged: true,
        response: Allowance,
        rpc: "app.allocation_allowances",
      }),
      itemAction("setRadioChannels", {
        summary: "Set a radio allocation's channels",
        description:
          "Sets the channels of a radio allocation as a whole through `app.set_allocation_radio_channels` (G-91): 0 to 16 channels of its project (422 allocation_channel_count, allocation_channel_project, allocation_channel_not_asset, allocation_channel_not_radio, allocation_channel_state). Needs advancing.packet.write or safety.radio_channel.write.",
        body: RadioChannels,
        rpc: "app.set_allocation_radio_channels",
      }),
    ],
  }),
  resource("Advancing", "/asset-reservation-conflicts", AssetReservationConflict, {
    verbs: ["list"],
    label: "reservation conflict",
    order: { by: ["reservation_id"], numeric: false },
  }),
];

export const assetReservationResources: readonly ResourceSpec[] = [
  resource("Assets", "/asset-reservations", AssetReservation, {
    verbs: ["list", "get"],
    actions: [
      itemAction("release", {
        summary: "Release a hold",
        description:
          "Releases one hold through `app.release_reservation`, Released By Reviewer, with the reason in the audit ledger. Refuses a hold already released (422 reservation_released) or with something issued against it still out (reservation_in_use). Needs advancing.submission.review.",
        body: z
          .object({ reason: reason("Why the hold is released.", "Ordering more instead.") })
          .meta({ id: "AssetReservationRelease", description: "Releasing a hold." }),
        rpc: "app.release_reservation",
      }),
    ],
  }),
];

export const assetClassAvailabilityQuery = itemQuery("availability", {
  summary: "Read an asset class's availability",
  description:
    "How many of the class are free over [from, to) through `app.asset_class_availability` (G-93): serviceable owned units, owned lot quantity, quantity on order that covers the window, the most held at once and what is left, in the unit of the class element. A window that runs backwards or beyond 400 days is refused (422 availability_window). Needs assets.asset.read in the org or advancing.packet.read on one of its projects.",
  query: z.object({ from: fields.instant("Window start."), to: fields.instant("Window end.") }),
  response: Availability,
  rpc: "app.asset_class_availability",
});

export const allocationCapabilities: Readonly<Record<string, CapabilityRule>> = {
  advanceAllocations: {
    read: "advancing.packet.read",
    actions: {
      request: "advancing.packet.write",
      assign: "advancing.submission.review",
      decide: "advancing.submission.review",
      reserve: "advancing.submission.review",
      split: "advancing.packet.write",
      unsplit: "advancing.packet.write",
      withdraw: "advancing.packet.read",
      issue: "advancing.packet.read",
      allowances: "advancing.packet.read",
      setRadioChannels: "advancing.packet.read",
    },
  },
  assetReservationConflicts: { read: "advancing.packet.read" },
};

export const assetReservationCapabilities: Readonly<Record<string, CapabilityRule>> = {
  assetReservations: {
    read: "assets.asset.read",
    actions: { release: "advancing.submission.review" },
  },
};
