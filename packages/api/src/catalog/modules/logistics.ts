/**
 * Logistics operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Logistics resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Logistics resources follow ADR 0023 (A50).
 *
 * Shipments, their lines, dock slots, the gate queue and the marshalling log are A03's tables of
 * migration 0351 with A11's display numbers and dock check-in (0440). Every yard row belongs to a
 * project (the site), not to a venue, and a dock is a zone of the project.
 */
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, removeActions, setOrder } from "../correct.ts";
import { logisticsFieldHomes } from "./parts/playbook-field-homes.ts";

const SINCE = "1.0.0-draft.2";

const project = (what: string) => ({
  schema: fields.ref(`project whose site ${what}`),
  create: "required" as const,
  update: false,
});
const shipment = (what: string) => ({
  schema: orNull(fields.ref(what)),
  create: "optional" as const,
});

export const additions = defineAdditions("Logistics", {
  corrections: [
    {
      id: "shipment-carrier-and-window",
      since: SINCE,
      resources: ["shipments"],
      change:
        "The carrier is `carrier_counterparty_id` (nullable), `tracking_number` becomes `tracking_identifier`, and `expected_at` gives way to the nullable `ships_at` and `arrives_at`; adds `freight_type_enum_id` and the server-set `shipment_number`. Removes `shipment_state` and `shipments.transition`, and lists order by `ships_at`.",
      reason:
        "app.shipments (0351) names the carrier as a counterparty, the tracking reference `tracking_identifier`, the canon freight type, and an optional ship and arrival window; 0440 adds the display number. The table has no lifecycle: a shipment's progress is its dock check-in, gate release and marshalling log entries (journey 20), so there is no state to move. Decided in ADR 0032.",
      apply: all(
        editShape({
          rename: { tracking_number: "tracking_identifier", expected_at: "ships_at" },
          remove: ["carrier", "shipment_state"],
          nullable: ["ships_at"],
          add: {
            carrier_counterparty_id: {
              schema: orNull(fields.ref("carrier, as a counterparty of the org")),
              create: "optional",
            },
            freight_type_enum_id: {
              schema: orNull(
                fields.code("Canon freight type, from xpms.std_enumeration.", "ENM-041"),
              ),
              create: "optional",
            },
            arrives_at: {
              schema: orNull(fields.instant("When the shipment is due to arrive.")),
              create: "optional",
            },
            shipment_number: {
              schema: fields.int(
                "Number within the project; the display key is {project_key}-{shipment_number}.",
                7,
                1,
              ),
            },
          },
        }),
        removeActions("transition"),
        setOrder({ by: ["ships_at"], numeric: false }),
      ),
    },
    {
      id: "shipment-line-element",
      since: SINCE,
      resources: ["shipmentLines"],
      change:
        "Removes `unit` and `asset_class_id`; adds the canon `element_id` (nullable); `quantity` defaults to 1 on create.",
      reason:
        "app.shipment_lines (0351) describes what a shipment carries with an optional canon element and a quantity that defaults to 1; it has no unit or asset class column.",
      apply: editShape({
        remove: ["unit", "asset_class_id"],
        optionalOnCreate: ["quantity"],
        add: {
          element_id: {
            schema: orNull(fields.code("Canon element carried.", "4000.01.01-XPMS-001")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "dock-slot-project-zone",
      since: SINCE,
      resources: ["dockSlots"],
      change:
        "A slot belongs to a `project_id` (required, fixed) at a dock `zone_id` (required): `venue_id` and `dock` are removed. Adds the server-set `checked_in_by`.",
      reason:
        "app.dock_slots (0351) books a window at a loading dock zone of a project (both NOT NULL) and has no venue or free-text dock column; 0440 stamps `checked_in_at` and `checked_in_by` once at check-in.",
      apply: editShape({
        remove: ["venue_id", "dock"],
        add: {
          project_id: project("the dock is at"),
          zone_id: {
            schema: fields.ref("loading dock zone of the project"),
            create: "required",
          },
          checked_in_by: { schema: orNull(fields.ref("person who checked the shipment in")) },
        },
      }),
    },
    {
      id: "gate-queue-project-vehicle",
      since: SINCE,
      resources: ["gateQueueEntries"],
      change:
        "An entry belongs to a `project_id` (required, fixed) and names a `shipment_id` instead of `venue_id` and `dock_slot_id`; `vehicle_plate` becomes `vehicle_identifier`, free text up to 100 characters; `arrived_at` defaults to now on create; `released_at` is set only by `gateQueueEntries.release`, and adds the server-set `released_by`.",
      reason:
        "app.gate_queue (0351) holds vehicles at a project's site gate with the shipment they carry, names the plate or trailer `vehicle_identifier`, defaults `arrived_at` to now, and stamps `released_at` and `released_by` once when someone with logistics.release.approve releases it (guard_gate_release).",
      apply: editShape({
        rename: { vehicle_plate: "vehicle_identifier" },
        remove: ["venue_id", "dock_slot_id"],
        serverSet: ["released_at"],
        optionalOnCreate: ["arrived_at"],
        add: {
          vehicle_identifier: {
            schema: fields.text("Plate or trailer number as written.", "FL TRK-2231", 100),
            create: "required",
          },
          project_id: project("the gate is at"),
          shipment_id: shipment("shipment the vehicle carries"),
          released_by: { schema: orNull(fields.ref("person who released the vehicle")) },
        },
      }),
    },
    {
      id: "marshalling-log-entry",
      since: SINCE,
      resources: ["marshallingLogEntries"],
      change:
        "An entry belongs to a `project_id` (required) with optional `shipment_id` and `zone_id`; `event` becomes `entry`, free text up to 1,000 characters; `vehicle_plate`, `venue_id` and `notes` are removed; `logged_at` defaults to now on create.",
      reason:
        "app.marshalling_log (0351) is an append-only log of a project's yard: what happened (`entry`), optionally for a shipment and a yard zone, at `logged_at` (default now). It has no venue, vehicle or notes column.",
      apply: editShape({
        rename: { event: "entry" },
        remove: ["venue_id", "vehicle_plate", "notes"],
        optionalOnCreate: ["logged_at"],
        add: {
          entry: {
            schema: fields.text("What happened in the yard.", "Staged in lane 2.", 1000),
            create: "required",
          },
          project_id: {
            schema: fields.ref("project whose yard the entry records"),
            create: "required",
          },
          shipment_id: shipment("shipment concerned"),
          zone_id: { schema: orNull(fields.ref("yard zone concerned")), create: "optional" },
        },
      }),
    },
    ...logisticsFieldHomes,
  ],
});
