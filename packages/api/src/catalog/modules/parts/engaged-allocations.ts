/**
 * Allocations from the engaged party's side in the public API (R8, RRR-188; migrations 2700 and 2701, ADR 0103 and
 * 0104). Additive only (v1 is frozen, Section 10.1):
 *
 *   * `engagedAllocations` reads api_external.advance_allocations: an engagement's pool and its people's shares for the
 *     party side (the supplying account's Owner or Admin, an Advancing Lead, an Advance representative, the engaged
 *     person of an Artist engagement), and a person's own rows on their roster entries. Writes are actions: request,
 *     split, unsplit and withdraw, through the RPCs of 2700.
 *   * `requestableItems` lists what the party side may ask for on each engagement it answers for (owner decision 7).
 *   * `myParkingPasses` lists the caller's own parking passes with zones and vehicle, never the plate.
 *
 * No price, order number, vendor or plate appears. catalog/modules/gateway.ts spreads these into the Gateway
 * additions; the database decides who may do each and refuses with a named rule.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import { orNull } from "../../correct.ts";
import { collectionAction, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";
import { DISPLAY_STATUSES } from "./allocations.ts";

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
const ITEM_KINDS = [
  "credential_category",
  "asset_class",
  "fulfillment",
  "accommodation_block",
  "service",
] as const;

const qty = (description: string, example: number) => z.number().meta({ description, example });
const text = (description: string, example: string) => z.string().meta({ description, example });
const note = (description: string, example: string) =>
  z.string().min(1).max(1000).optional().meta({ description, example });

const EngagedAllocation = defineResource({
  name: "EngagedAllocation",
  table: "api_external.advance_allocations",
  base: "view",
  key: "allocation_id",
  description:
    "What an engagement is allocated, as the engaged party reads it (R8, ADR 0104): the party's pool and each person's share on its roster for the party side, and a person's own rows on their roster entries. The status is computed by the database and Gateway never confirms possession. No price, order number, vendor or other people's asset tags.",
  fields: {
    allocation_id: fields.uuid("Identifier of the allocation."),
    engagement_id: fields.ref("engagement it is held under: the pool's own or the roster entry's"),
    roster_entry_id: orNull(
      fields.ref("roster entry of the person who holds it; null for the pool"),
    ),
    person_name: orNull(text("Name of the person who holds it; null for the pool.", "Kai Morgan")),
    kind: z.enum(KINDS).meta({ description: "What the allocation gives.", example: "Asset" }),
    item_name: orNull(
      text("Category, class, catering or block name; null for Travel and Per Diem.", "Radios"),
    ),
    quantity: qty("Quantity allocated; a pool goes down as it is shared out.", 6),
    allocation_state: z.enum(STATES).meta({ description: "Stored state.", example: "Approved" }),
    display_status: z
      .enum(DISPLAY_STATUSES)
      .meta({ description: "The computed status.", example: "Reserved" }),
    reserved_quantity: qty("Quantity held for it.", 6),
    issued_quantity: qty("Quantity handed over.", 0),
    returned_quantity: qty("Quantity handed back.", 0),
    parent_allocation_id: orNull(fields.ref("pool a share was split from")),
    needed_from: fields.instant("When it is first needed."),
    needed_to: fields.instant("When it is no longer needed."),
    needed_time_zone: fields.timeZone("IANA time zone of the window."),
    requested_by_me: fields.bool("True when the caller asked for it.", true),
    decline_reason: orNull(text("Why production declined it.", "Kai already has a badge.")),
  },
});

const RequestableItem = defineResource({
  name: "RequestableItem",
  table: "api_external.requestable_items",
  base: "view",
  description:
    "What the party side may ask for on an engagement it answers for (R8, owner decision 7): the project's Access badges, and its Parking passes, the org's radio and cart classes, Catering, accommodation blocks, Travel and Per Diem only while the offering is Provided, with the caps and what is already asked for.",
  fields: {
    engagement_id: fields.ref("engagement it may be asked for on"),
    item_kind: z
      .enum(ITEM_KINDS)
      .meta({ description: "The item_kind of the request action.", example: "asset_class" }),
    item_id: orNull(fields.ref("category, class, fulfillment or block; null for a service")),
    name: text("Its name; Travel or Per Diem for a service.", "Radios"),
    offering: orNull(
      z
        .enum(OFFERINGS)
        .meta({
          description: "Offering it draws on; null for an Access badge.",
          example: "Radios",
        }),
    ),
    cap_per_engagement: orNull(
      z.int().meta({ description: "Cap for the engagement.", example: 6 }),
    ),
    cap_per_person: orNull(z.int().meta({ description: "Cap for one person.", example: 2 })),
    requested_quantity: qty(
      "Already requested or approved under the engagement and its roster.",
      4,
    ),
  },
});

const ParkingPass = defineResource({
  name: "ParkingPass",
  table: "api_external.my_parking_passes",
  base: "view",
  key: "credential_id",
  description:
    "The caller's own parking passes (R8): credentials of a Parking category with the zones its access grid opens and the make, model and colour of the vehicle it was issued for. The plate never appears.",
  fields: {
    credential_id: fields.uuid("Identifier of the pass."),
    project_id: fields.ref("project"),
    credential_number: orNull(text("Number printed on the pass.", "P-0042")),
    category_name: text("Parking category.", "Crew Parking"),
    valid_from: orNull(fields.instant("Valid from.")),
    valid_to: orNull(fields.instant("Valid until.")),
    revoked_at: orNull(fields.instant("When it was revoked.")),
    zone_codes: z.array(z.string()).meta({ description: "Zone codes.", example: ["LOT-A"] }),
    zone_names: z
      .array(z.string())
      .meta({ description: "Zone names, in the order of zone_codes.", example: ["Lot A"] }),
    vehicle_make: orNull(text("Make of the vehicle.", "Ford")),
    vehicle_model: orNull(text("Model of the vehicle.", "Transit")),
    vehicle_color: orNull(text("Colour of the vehicle.", "White")),
    holder_person_id: fields.ref("the caller, the pass holder"),
  },
});

const Request = z
  .object({
    engagement_id: fields.ref("engagement the caller answers for"),
    roster_entry_id: fields.ref("roster entry of one person; left out for the pool").optional(),
    item_kind: z
      .enum(ITEM_KINDS)
      .meta({ description: "What is asked for.", example: "asset_class" }),
    item_id: fields.ref("category, class, fulfillment or block; left out for a service").optional(),
    service_kind: z
      .enum(["Travel", "Per Diem"])
      .optional()
      .meta({ description: "Travel or Per Diem, for a service.", example: "Travel" }),
    quantity: z.number().positive().meta({ description: "Quantity.", example: 6 }),
    needed_from: fields.instant("When it is first needed."),
    needed_to: fields.instant("When it is no longer needed."),
    time_zone: fields.timeZone("IANA time zone of the window."),
    note: note("What it is for.", "For the audio crew."),
  })
  .meta({ id: "EngagedAllocationRequest", description: "One request: one holder and one item." });

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
              .meta({ description: "Quantity for the person.", example: 1 }),
          })
          .meta({ id: "EngagedAllocationSplitPart", description: "One person's share." }),
      )
      .min(1),
  })
  .meta({
    id: "EngagedAllocationSplit",
    description: "Shares of an approved pool for its people.",
  });

const SplitResult = z
  .object({
    allocation_ids: z
      .array(z.uuid())
      .meta({ description: "The shares, in the order given.", example: [fields.EXAMPLE_UUID] }),
  })
  .meta({ id: "EngagedAllocationSplitResult", description: "The shares written." });

const Unsplit = z
  .object({
    quantity: z
      .number()
      .positive()
      .optional()
      .meta({ description: "How much goes back; all of it when left out.", example: 1 }),
  })
  .meta({ id: "EngagedAllocationUnsplit", description: "A share given back to its pool." });

const UnsplitResult = z
  .object({ quantity: qty("Quantity given back to the pool.", 1) })
  .meta({ id: "EngagedAllocationUnsplitResult", description: "What went back." });

const Withdraw = z
  .object({ reason: note("Why it is withdrawn.", "No longer needed.") })
  .meta({ id: "EngagedAllocationWithdraw", description: "Withdrawing a request or a share." });

const REFUSALS =
  "Refusals answer 422 with the rule, among them allocation_not_your_engagement, allocation_entry_not_on_engagement, allocation_not_requestable, offering_not_offered, allocation_cap_engagement, allocation_cap_person and allocation_engagement_closed";

export const engagedAllocationResources: readonly ResourceSpec[] = [
  resource("Gateway", "/engaged-allocations", EngagedAllocation, {
    verbs: ["list", "get"],
    order: { by: ["allocation_id"], numeric: false, descending: true },
    actions: [
      collectionAction("request", {
        summary: "Request an item for the pool or one person",
        description: `The party side asks for an item for its pool or one person on its roster through \`app.request_engaged_allocation\`; it starts Requested for the producing org to decide. A credential need is a request: Gateway never issues. ${REFUSALS}.`,
        body: Request,
        status: 201,
        rpc: "app.request_engaged_allocation",
      }),
      itemAction("split", {
        summary: "Share an approved pool to people on the roster",
        description:
          "Gives shares of an approved pool to people accepted on the roster through `app.split_engaged_allocation`, moving holds with them (422 allocation_not_pool, allocation_split_exceeds, allocation_cap_person, allocation_entry_not_accepted). Each person is sent allocation.assigned.",
        body: Split,
        response: SplitResult,
        rpc: "app.split_engaged_allocation",
      }),
      itemAction("unsplit", {
        summary: "Give a share back to its pool",
        description:
          "Gives part or all of a person's share back to its pool through `app.unsplit_engaged_allocation`, never what was issued (422 allocation_issued). A share given back whole is Withdrawn.",
        body: Unsplit,
        response: UnsplitResult,
        rpc: "app.unsplit_engaged_allocation",
      }),
      itemAction("withdraw", {
        summary: "Withdraw a request or a share",
        description:
          "Withdraws a Requested allocation, or an Approved one nothing of which was issued (422 allocation_issued), through `app.withdraw_engaged_allocation`: by the party side, or by the person on the roster for a request they made.",
        body: Withdraw,
        rpc: "app.withdraw_engaged_allocation",
      }),
    ],
  }),
  resource("Gateway", "/requestable-items", RequestableItem, {
    verbs: ["list"],
    label: "requestable item",
    order: { by: ["engagement_id", "item_kind", "name"], numeric: false },
  }),
  resource("Gateway", "/my-parking-passes", ParkingPass, {
    verbs: ["list"],
    label: "parking pass",
    order: { by: ["credential_id"], numeric: false },
  }),
];

export const engagedAllocationCapabilities: Readonly<Record<string, CapabilityRule>> = {
  engagedAllocations: {
    read: "advancing.packet.read",
    actions: {
      request: "advancing.packet.write",
      split: "advancing.packet.write",
      unsplit: "advancing.packet.write",
      withdraw: "advancing.packet.write",
    },
  },
  requestableItems: { read: "advancing.packet.read" },
  myParkingPasses: { read: "opportunities.engagement.read" },
};
