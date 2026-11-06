/**
 * Supply chain follow-ons in the public API (B11, RRR-235; migrations 3001 to 3006, ADR 0150), additively (v1 is frozen,
 * Section 10.1):
 *
 *   * `procurementNeeds` and `procurementNeeds.consolidate`: what an event will get, and requests consolidated onto it.
 *     `procurementNeedStatus` reads the computed status; no field of a need holds it.
 *   * `rfqLines`: what an RFQ asks for. `rfqs.createSubHire` drafts one from a shortage, and `assetShortages` reads those.
 *   * `assetMaintenancePlans` and `assetMaintenanceDue`: maintenance schedules, computed on the org's calendar.
 *   * `deliveryWindows`, `deliveryWindows.generate`, `deliveryWindows.book` and `dockSlots.cancelBooking`: a gate open for
 *     a number of vehicles, and a vendor's place in it.
 *
 * Fields on frozen resources (`poLines`, `rfqResponseLines`, `assetMaintenanceEvents`, `dockSlots`, `gateQueueEntries`)
 * enter through optional, read-side correction entries in the module files.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import { orNull } from "../../correct.ts";
import { collectionAction, collectionQuery, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";
import { acquisitionKind } from "./supply-bridge.ts";

const NEED_STATUSES = ["Needs Ordered", "Short", "On Order", "Excess"] as const;
const DUE_STATUSES = ["Pending", "Overdue", "Completed"] as const;
const INTERVAL_UNITS = ["Day", "Week", "Month", "Year"] as const;

const unitBasis = (what: string) => orNull(fields.shortText(`Unit of ${what}.`, "each"));

// Needs ---------------------------------------------------------------------------------------------------------------

const ProcurementNeed = defineResource({
  name: "ProcurementNeed",
  table: "app.procurement_needs",
  description:
    "What a project will actually get. The quantity is set here and linking requests never changes it; its status is computed from order lines (procurementNeedStatus). At most one of the asset class and the element.",
  fields: {
    project_id: fields.ref("project buying"),
    need_number: fields.int("Number from the project's display key sequence, issued on insert.", 1, 1),
    description: fields.longText("What is needed.", "Truss Sections"),
    quantity: fields.quantity("How much the event will get.", 15),
    unit_basis: unitBasis("the quantity"),
    asset_class_id: orNull(fields.ref("asset class the need is for")),
    element_id: orNull(fields.code("Catalog element the need is for.", "3000.05.01-GHXST-014")),
    needed_from: orNull(fields.instant("When it is needed from; both or neither.")),
    needed_to: orNull(fields.instant("When it is needed until; both or neither.")),
    note: orNull(fields.longText("What the buyer noted.", "Black, not silver.")),
  },
});

const NeedStatusRow = defineResource({
  name: "ProcurementNeedStatus",
  table: "app.procurement_need_status",
  base: "view",
  description:
    "Each live need with what was asked for and what is ordered: computed, never stored. Ordered counts lines on Approved, Sent or Closed orders, less returns other than Off Hire and Over Delivery; Proposed lines show only as drafted.",
  fields: {
    need_id: fields.ref("need"),
    project_id: fields.ref("project"),
    description: fields.longText("What is needed.", "Truss Sections"),
    quantity: fields.quantity("How much the event will get.", 15),
    requested_quantity: fields.quantity("Live requests linked, with their Split children.", 15),
    drafted_quantity: fields.quantity("On lines of Proposed orders: shown, never counted.", 0),
    ordered_quantity: fields.quantity("On lines of Approved, Sent or Closed orders, less returns.", 5),
    received_quantity: fields.quantity("Received on those lines.", 0),
    need_status: z
      .enum(NEED_STATUSES)
      .meta({ description: "Computed from ordered against quantity.", example: "Short" }),
  },
});

export const needConsolidateAction = collectionAction("consolidate", {
  summary: "Consolidate requests onto needs",
  description:
    "Links allocations onto a need when `need_id` is given, leaving its quantity alone; otherwise adds one need per asset class with the sum of the selection. Needs procurement.po.write and advancing.packet.read on the project. Requested may be linked as well as Approved.",
  body: z
    .object({
      allocation_ids: z.array(z.uuid()).min(1).max(200).meta({
        description: "Allocations of one project.",
        example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"],
      }),
      need_id: orNull(fields.ref("need to link them to")).optional(),
    })
    .meta({ id: "ProcurementNeedConsolidateRequest", description: "Requests to consolidate." }),
  response: z
    .object({
      data: z.array(z.uuid()).meta({
        description: "The needs linked or added.",
        example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"],
      }),
    })
    .meta({ id: "ProcurementNeedConsolidateResult", description: "The needs linked or added." }),
  rpc: "app.consolidate_allocations",
});

// RFQ lines and sub-hire ---------------------------------------------------------------------------------------------------

const RfqLine = defineResource({
  name: "RfqLine",
  table: "app.rfq_lines",
  description:
    "What an RFQ asks for. Lines change only while the RFQ is Proposed. Readable with the RFQ: no prices, and nothing of a sealed response.",
  fields: {
    rfq_id: fields.ref("RFQ the line belongs to"),
    line_number: fields.int("Order of the line within the RFQ, assigned on create.", 1, 1),
    description: fields.longText("What is asked for.", "Truss Sections"),
    element_id: orNull(fields.code("Catalog element asked for.", "3000.05.01-GHXST-014")),
    quantity: fields.quantity("Quantity asked for.", 5),
    unit_basis: unitBasis("the quantity"),
    acquisition_kind: acquisitionKind("Purchase, or Rental for a hire."),
    hire_starts_at: orNull(fields.instant("Rental lines only: when the hire starts.")),
    hire_ends_at: orNull(fields.instant("Rental lines only: when the hire ends.")),
    procurement_need_id: orNull(fields.ref("need of the same project the line sources")),
  },
});

const AssetShortage = z
  .object({
    project_id: fields.ref("project"),
    asset_class_id: fields.ref("asset class"),
    class_name: fields.shortText("Name of the class.", "Truss Sections"),
    element_id: fields.code("Catalog element of the class.", "3000.05.01-GHXST-014"),
    unit_basis: unitBasis("the quantity"),
    short_quantity: fields.quantity("How many more the open allocations want than can supply them.", 5),
    window_from: fields.instant("When the allocations that are short begin."),
    window_to: fields.instant("When the allocations that are short end."),
    open_need_id: orNull(fields.ref("live need of the class overlapping the window")),
    open_rfq_id: orNull(fields.ref("RFQ in Proposed or Issued sourcing that need")),
  })
  .meta({ id: "AssetShortage", description: "A class short against own stock on a project." });

export const assetShortagesQuery = collectionQuery("shortages", {
  summary: "What is short against own stock",
  description:
    "One row per project and asset class whose open allocations want more than can supply them: serviceable units, lot quantity and quantity on order that covers the window. Needs advancing.packet.read or procurement.po.read on the project; other projects are omitted. No prices or names.",
  query: z.object({ project_id: fields.ref("project to narrow to").optional() }),
  response: z
    .object({ data: z.array(AssetShortage).meta({ description: "Shortages." }) })
    .meta({ id: "AssetShortages", description: "What is short against own stock." }),
  rpc: "app.asset_shortages",
});

export const rfqCreateSubHireAction = collectionAction("createSubHire", {
  segment: "sub-hire",
  summary: "Draft a sub-hire RFQ",
  description:
    "Drafts a Proposed RFQ with one Rental line per short class, reusing a live need whose window overlaps or adding one of the short quantity. Vendors are invited as on any RFQ. Each request's `Idempotency-Key` replays the stored response.",
  body: z
    .object({
      project_id: fields.ref("project short of them"),
      asset_class_ids: z.array(z.uuid()).min(1).max(50).meta({
        description: "Classes that are short.",
        example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"],
      }),
      title: fields.shortText("What is being sourced.", "Sub-hire truss"),
    })
    .meta({ id: "RfqCreateSubHireRequest", description: "A sub-hire draft." }),
  response: z
    .object({ id: fields.uuid("The RFQ drafted.") })
    .meta({ id: "RfqCreateSubHireResult", description: "The RFQ drafted." }),
  rpc: "app.create_sub_hire_rfq",
});

// Maintenance ----------------------------------------------------------------------------------------------------------------

const AssetMaintenancePlan = defineResource({
  name: "AssetMaintenancePlan",
  table: "app.asset_maintenance_plans",
  description:
    "Maintenance to do, on one unit or on every serviceable unit of a class: first due on a day, then every interval after it was last done, or once when the interval is null.",
  fields: {
    asset_unit_id: orNull(fields.ref("unit the plan applies to; exactly one of unit and class")),
    asset_class_id: orNull(fields.ref("class whose units the plan applies to")),
    title: fields.shortText("What is to be done.", "Inspect welds"),
    instructions: orNull(fields.longText("How to do it.", "Replace any cracked section.")),
    first_due_on: fields.date("Day the work is first due."),
    every_count: orNull(fields.int("How many intervals between doing it.", 3, 1, 999)),
    every_unit: orNull(
      z.enum(INTERVAL_UNITS).meta({ description: "Unit of the interval.", example: "Month" }),
    ),
  },
});

const AssetMaintenanceDue = defineResource({
  name: "AssetMaintenanceDue",
  table: "app.asset_maintenance_due",
  base: "view",
  description:
    "Maintenance due, one row per plan and unit: computed on the org's calendar, never stored. A recurring plan never reads Completed: done work is the log.",
  fields: {
    plan_id: fields.ref("plan"),
    asset_unit_id: fields.ref("unit"),
    title: fields.shortText("What is to be done.", "Inspect welds"),
    last_performed_on: orNull(fields.date("Latest log entry of this plan on this unit.")),
    due_on: orNull(fields.date("When it is next due; null when work done once is done.")),
    due_status: z
      .enum(DUE_STATUSES)
      .meta({ description: "Computed on the org's calendar.", example: "Pending" }),
  },
});

// Delivery windows ---------------------------------------------------------------------------------------------------------------

const DeliveryWindow = defineResource({
  name: "DeliveryWindow",
  table: "app.delivery_windows",
  description:
    "A gate open for a time for up to a number of vehicles (ADR 0150). Vendors book a place in it, and each booking is a dock slot. It overlaps no other live window or direct slot at its zone.",
  fields: {
    project_id: fields.ref("project"),
    zone_id: fields.ref("gate: a live zone of the org"),
    starts_at: fields.instant("When the window opens."),
    ends_at: fields.instant("When the window closes."),
    vehicle_limit: fields.int("How many vehicles it takes.", 5, 1, 500),
    is_open: fields.bool("False stops new bookings; bookings already made stay.", true),
  },
});

export const deliveryWindowGenerateAction = collectionAction("generate", {
  summary: "Add a schedule of delivery windows",
  description:
    "Adds windows at a gate for each day, from a local start to a local end in slots of a length, on the project's calendar. A local time the clocks skip gets no window. At most 500 windows.",
  body: z
    .object({
      project_id: fields.ref("project"),
      zone_id: fields.ref("gate"),
      first_day: fields.date("First day."),
      last_day: fields.date("Last day."),
      from_time: fields.shortText("Local start time.", "08:00"),
      to_time: fields.shortText("Local end time.", "18:00"),
      slot_minutes: fields.int("Length of each window in minutes.", 60, 5, 1440),
      vehicle_limit: fields.int("How many vehicles each takes.", 5, 1, 500),
    })
    .meta({ id: "DeliveryWindowGenerateRequest", description: "A schedule of windows." }),
  response: z
    .object({
      data: z.array(z.uuid()).meta({
        description: "The windows added.",
        example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"],
      }),
    })
    .meta({ id: "DeliveryWindowGenerateResult", description: "The windows added." }),
  rpc: "app.create_delivery_windows",
});

export const deliveryWindowBookAction = itemAction("book", {
  summary: "Book a place in a delivery window",
  description:
    "Books a place for a vehicle: for a dock writer on the project, or for a Vendor engagement of the project the caller reaches in the operational area. Returns the dock slot with its reference code. Each request's `Idempotency-Key` replays the stored response.",
  body: z
    .object({
      engagement_id: orNull(fields.ref("Vendor engagement the booking is for")).optional(),
      vehicle_identifier: orNull(fields.shortText("Plate or trailer number.", "FL ABC 123")).optional(),
      shipment_id: orNull(fields.ref("shipment the vendor carries")).optional(),
    })
    .meta({ id: "DeliveryWindowBookRequest", description: "A place in a window." }),
  response: z
    .object({
      dock_slot_id: fields.uuid("The booking."),
      reference_code: fields.shortText("Label to quote at the gate.", "K7M2QX"),
    })
    .meta({ id: "DeliveryWindowBookResult", description: "The booking." }),
  rpc: "app.book_delivery_window",
});

export const dockSlotCancelBookingAction = itemAction("cancelBooking", {
  summary: "Cancel a delivery booking",
  description:
    "Cancels a booking and frees its place, before check-in and before the window starts: for its engagement or a dock writer. Its approval is canceled with it.",
  response: z
    .object({ id: fields.uuid("The booking.") })
    .meta({ id: "DockSlotCancelBookingResult", description: "The booking canceled." }),
  rpc: "app.cancel_delivery_booking",
});

export const procurementFollowOnResources: readonly ResourceSpec[] = [
  resource("Procurement", "/procurement-needs", ProcurementNeed, {
    order: { by: ["need_number"], numeric: true },
  }),
  resource("Procurement", "/procurement-need-status", NeedStatusRow, {
    verbs: ["list"],
    op: "procurementNeedStatus",
    label: "need status",
    order: { by: ["need_id"], numeric: false },
  }),
  resource("Procurement", "/rfq-lines", RfqLine, {
    order: { by: ["line_number"], numeric: true },
  }),
];

export const assetFollowOnResources: readonly ResourceSpec[] = [
  resource("Assets", "/asset-maintenance-plans", AssetMaintenancePlan),
  resource("Assets", "/asset-maintenance-due", AssetMaintenanceDue, {
    verbs: ["list"],
    op: "assetMaintenanceDue",
    label: "maintenance due",
    order: { by: ["due_on"], numeric: false },
  }),
];

export const logisticsFollowOnResources: readonly ResourceSpec[] = [
  resource("Logistics", "/delivery-windows", DeliveryWindow, {
    order: { by: ["starts_at"], numeric: false },
  }),
];
