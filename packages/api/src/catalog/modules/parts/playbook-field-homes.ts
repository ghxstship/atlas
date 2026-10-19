/**
 * Corrections that expose the Playbook field homes of migration 1180 (A51, RRR-96) through the resources that read
 * their tables (ADR 0023), owned by A54 (RRR-99). Section 18 gate 14 asks that every Playbook `field` target exists
 * in the OpenAPI document; `canon/import/test/field-targets-openapi.test.ts` checks it. Each module spreads its own
 * list into its module file. Every added column is nullable. On resources served by the generic table handlers each
 * field is optional on create and accepted on update; on projects, records and work orders, whose handlers build
 * their inserts, it is read and accepted on update, and the handler column lists name it.
 */
import { canonCodes, fields } from "@xos/schemas";
import type { CorrectionInput } from "../../corrections.ts";
import { editShape, orNull } from "../../correct.ts";

const SINCE = "1.0.0-draft.2";
const REASON =
  "Migration 1180 (A51, finding A47-001) adds the nullable column as the home of a Playbook field target.";

const optional = (schema: Parameters<typeof orNull>[0]) => ({
  schema: orNull(schema),
  create: "optional" as const,
});
/** URID category (dimension 2), checked against xpms.dim_category by the column's foreign key. */
const urid = () => optional(canonCodes.Urid);
const text = (description: string, example: string, max: number) =>
  optional(fields.text(description, example, max));
const count = (description: string, example: number) =>
  optional(fields.int(description, example, 0));
const feet = (description: string, example: number) =>
  optional(fields.quantity(description, example));

export const logisticsFieldHomes: readonly CorrectionInput[] = [
  {
    id: "shipment-playbook-field-homes",
    since: SINCE,
    resources: ["shipments"],
    change:
      "Adds the optional `urid`, `description`, `origin`, `sender_counterparty_id`, `pallet_count`, `piece_count`, `length_ft`, `width_ft`, `height_ft`, `weight_lb`, `trailer_license`, `seal_identifier` and `bill_of_lading_identifier`.",
    reason: `app.shipments: ${REASON} The Shipping Manifest sheet holds these facts per shipment.`,
    apply: editShape({
      add: {
        urid: urid(),
        description: text(
          "What the shipment carries, in a sentence.",
          "Two pallets of truss and motors.",
          2000,
        ),
        origin: text("Where the freight ships from, as a locality.", "Orlando, FL", 200),
        sender_counterparty_id: optional(
          fields.ref("vendor sending the freight; the carrier is carrier_counterparty_id"),
        ),
        pallet_count: count("Number of pallets.", 2),
        piece_count: count("Number of pieces.", 14),
        length_ft: feet("Length of the load in feet.", 48),
        width_ft: feet("Width of the load in feet.", 8.5),
        height_ft: feet("Height of the load in feet.", 9),
        weight_lb: feet("Weight of the load in pounds.", 12000),
        trailer_license: text("License plate of the trailer.", "FL TRL-4410", 100),
        seal_identifier: text("Number of the seal applied to the trailer.", "SL-778120", 100),
        bill_of_lading_identifier: text(
          "Bill of lading number issued by the carrier.",
          "BOL-2027-0611",
          100,
        ),
      },
    }),
  },
  {
    id: "gate-queue-playbook-field-homes",
    since: SINCE,
    resources: ["gateQueueEntries"],
    change: "Adds the optional `vehicle_type` and `driver_name`.",
    reason: `app.gate_queue: ${REASON} The gate check-in records the kind of vehicle and its driver.`,
    apply: editShape({
      add: {
        vehicle_type: text("Kind of vehicle at the gate.", "53ft Tractor-Trailer", 100),
        driver_name: text("Driver of the vehicle, as given at check-in.", "Luis Ortega", 200),
      },
    }),
  },
  {
    id: "marshalling-log-playbook-field-homes",
    since: SINCE,
    resources: ["marshallingLogEntries"],
    change: "Adds the optional `urid`.",
    reason: `app.marshalling_log: ${REASON} The Marshalling Yard Log names the URID the movement serves.`,
    apply: editShape({ add: { urid: urid() } }),
  },
];

export const placesFieldHomes: readonly CorrectionInput[] = [
  {
    id: "space-playbook-field-homes",
    since: SINCE,
    resources: ["spaces"],
    change: "Adds the optional `description`.",
    reason: `app.spaces: ${REASON} The Locations sheet describes what each space is used for.`,
    apply: editShape({
      add: {
        description: text("What the space is used for.", "Backstage green room for talent.", 2000),
      },
    }),
  },
];

export const procurementFieldHomes: readonly CorrectionInput[] = [
  {
    id: "purchase-order-playbook-field-homes",
    since: SINCE,
    resources: ["purchaseOrders"],
    change:
      "Adds the optional `delivery_due_on`, `payment_terms_days`, `tax_minor` and `shipping_minor`.",
    reason: `app.purchase_orders: ${REASON} The PO Tracker sheet holds the delivery date, terms, tax and shipping of each order.`,
    apply: editShape({
      add: {
        delivery_due_on: optional(fields.date("Date the order is due to be delivered.")),
        payment_terms_days: optional(
          fields.int("Days after invoice the order is payable (Net 30 is 30).", 30, 0),
        ),
        tax_minor: { schema: fields.money("Tax on the order.", 4200), create: "optional" },
        shipping_minor: {
          schema: fields.money("Shipping charged on the order.", 15000),
          create: "optional",
        },
      },
    }),
  },
];

export const vendorFieldHomes: readonly CorrectionInput[] = [
  {
    id: "vendor-playbook-field-homes",
    since: SINCE,
    resources: ["vendors"],
    change: "Adds the optional `default_account_code` and `default_cost_center_id`.",
    reason: `app.vendors: ${REASON} The Vendor Directory names the GL account and cost center a vendor's costs post to.`,
    apply: editShape({
      add: {
        default_account_code: optional(canonCodes.GlAccountCode),
        default_cost_center_id: optional(
          fields.ref(
            "cost center (dimension 1) the vendor's costs post to unless a line says otherwise",
          ),
        ),
      },
    }),
  },
];

export const financeFieldHomes: readonly CorrectionInput[] = [
  {
    id: "budget-line-playbook-field-homes",
    since: SINCE,
    resources: ["budgetLines"],
    change: "Adds the optional `phase_code` and `tier_code`.",
    reason: `app.budget_lines: ${REASON} The Budget Expenses sheet names the phase a line is spent in and the tier it serves.`,
    apply: editShape({
      add: {
        phase_code: optional(canonCodes.PhaseCode),
        tier_code: optional(canonCodes.TierCode),
      },
    }),
  },
  {
    id: "change-order-playbook-field-homes",
    since: SINCE,
    resources: ["changeOrders"],
    change: "Adds the optional `schedule_impact_days` and `client_impact`.",
    reason: `app.change_orders: ${REASON} The Change Orders sheet states the schedule and client impact of each change.`,
    apply: editShape({
      add: {
        schedule_impact_days: optional(
          fields.int(
            "Days the change moves the schedule; negative when it pulls it in, zero for none.",
            2,
            -3650,
          ),
        ),
        client_impact: text(
          "Effect of the change on the client, as stated.",
          "Adds a second stage to the run of show.",
          500,
        ),
      },
    }),
  },
];

export const showFieldHomes: readonly CorrectionInput[] = [
  {
    id: "cue-playbook-field-homes",
    since: SINCE,
    resources: ["cues"],
    change: "Adds the optional `segment`, `description` and `space_id`.",
    reason: `app.cues: ${REASON} The Run of Show sheet holds each cue's segment, what happens and where.`,
    apply: editShape({
      add: {
        segment: text(
          "Show segment the cue belongs to.",
          "Act II, Official Opening and Remarks",
          200,
        ),
        description: text(
          "What happens on the cue.",
          "House lights to half; walk-in music fades.",
          2000,
        ),
        space_id: optional(fields.ref("space the cue happens in")),
      },
    }),
  },
  {
    id: "run-of-show-playbook-field-homes",
    since: SINCE,
    resources: ["runsOfShow"],
    change: "Adds the optional `record_id`.",
    reason: `app.run_of_show: ${REASON} A running order belongs to a schedule record, usually the Event.`,
    apply: editShape({
      add: {
        record_id: optional(
          fields.ref("schedule record the running order belongs to, in the same project"),
        ),
      },
    }),
  },
];

export const crewFieldHomes: readonly CorrectionInput[] = [
  {
    id: "shift-playbook-field-homes",
    since: SINCE,
    resources: ["shifts"],
    change: "Adds the optional `scheduled_break_minutes`.",
    reason: `app.shifts: ${REASON} The Crew Shifts sheet schedules a meal break within each shift.`,
    apply: editShape({
      add: {
        scheduled_break_minutes: optional(
          fields.int("Meal break scheduled within the shift, in minutes.", 30, 0),
        ),
      },
    }),
  },
];

export const safetyFieldHomes: readonly CorrectionInput[] = [
  {
    id: "inspection-playbook-field-homes",
    since: SINCE,
    resources: ["inspections"],
    change: "Adds the optional `urid`.",
    reason: `app.inspections: ${REASON} The Inspection Compliance sheet names the URID category each inspection covers.`,
    apply: editShape({ add: { urid: urid() } }),
  },
];

/** A column the update body accepts and the read shape returns; the create body stays as frozen. */
const updatable = (schema: Parameters<typeof orNull>[0]) => ({
  schema: orNull(schema),
  update: true,
});

export const projectsFieldHomes: readonly CorrectionInput[] = [
  {
    id: "project-playbook-field-homes",
    since: SINCE,
    resources: ["projects"],
    change: "Adds `anchor_on` and `budget_envelope_minor`, nullable, read and accepted on update.",
    reason: `app.projects: ${REASON} The Projects sheet holds the anchor date template offsets count from and the approved budget envelope.`,
    apply: editShape({
      add: {
        anchor_on: updatable(
          fields.date("Anchor date (usually the show day) that template day offsets count from."),
        ),
        budget_envelope_minor: {
          schema: fields.money("Budget envelope approved for the project.", 25000000),
          update: true,
        },
      },
    }),
  },
];

export const workFieldHomes: readonly CorrectionInput[] = [
  {
    id: "record-playbook-field-homes",
    since: SINCE,
    resources: ["records"],
    change:
      "Adds the server-set `project_id`, and `parent_record_id`, `wbs_code`, `description`, `sop_id` and `team_code`, nullable, read and accepted on update.",
    reason: `app.records: ${REASON} The Production Schedule and Production Tasks sheets hold the work breakdown, description, governing SOP and canon team of each record. project_id (0310) is derived from the scope node on create and never changes.`,
    apply: editShape({
      add: {
        project_id: {
          schema: fields.ref(
            "project the record belongs to, derived from its scope node and never changed",
          ),
        },
        parent_record_id: updatable(
          fields.ref("summary record this record rolls up to, in the same project"),
        ),
        wbs_code: updatable(
          fields
            .text("Work breakdown structure code, dot separated.", "1.2.1", 50)
            .regex(/^[0-9]+(\.[0-9]+)*$/),
        ),
        description: updatable(
          fields.text(
            "What the record involves, in sentence case.",
            "Rig the downstage truss.",
            4000,
          ),
        ),
        sop_id: updatable(fields.ref("standard operating procedure that governs the work")),
        team_code: updatable(canonCodes.TeamId),
      },
    }),
  },
  {
    id: "work-order-playbook-field-homes",
    since: SINCE,
    resources: ["workOrders"],
    change:
      "Adds the server-set `work_order_number`, and `location_text`, `scope_of_work`, `scheduled_starts_at` and `estimated_hours`, nullable, read and accepted on update.",
    reason: `app.work_orders (0411): the Work Orders sheet holds the number, location, scope, planned start and estimated hours of each order, which the table stores and the frozen shape left out. \`due_at\` already reads scheduled_ends_at.`,
    apply: editShape({
      add: {
        work_order_number: {
          schema: fields.int(
            "Sequence number within the project; the display key is {project_key}-WO-{number}.",
            12,
            1,
          ),
        },
        location_text: updatable(
          fields.text(
            "Where the work happens, in words, when no zone says it.",
            "Main stage, stage left wing.",
            300,
          ),
        ),
        scope_of_work: updatable(
          fields.longText(
            "The scope bidders price, in sentence case.",
            "Supply and hang 24 moving lights.",
          ),
        ),
        scheduled_starts_at: updatable(fields.instant("Planned start.")),
        estimated_hours: updatable(
          fields.quantity("Estimated labor hours; null when unestimated.", 16),
        ),
      },
    }),
  },
];
