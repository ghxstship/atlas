/**
 * Assets operations beyond the frozen v1 catalog (additive only, Section 10.1), and corrections to
 * the frozen Assets resources (ADR 0023) so each shape matches its table: asset classes, units, lots,
 * identifiers, custody, maintenance and damage of A03's 0352, the lot ledger of 0450 and custody to
 * an engagement of 0975. The scan back end Compass calls is `assetUnits.scan` (resolve a code) and
 * `assetUnits.applyScan` (one idempotent custody move, app.apply_asset_scan).
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions } from "../correct.ts";
import { collectionAction } from "../define.ts";
import { Constants } from "@xos/data/database.types";

const SINCE = "1.0.0-draft.2";

const ASSET_STATES = Constants.app.Enums.asset_state;

const assetState = (description: string) =>
  z.enum(ASSET_STATES).meta({ description, example: "Available" });

/** One scan event from a device: the code, the move and the event id that makes it idempotent. */
const AssetScanEvent = z
  .object({
    event_id: z.uuid().meta({
      description:
        "UUID the device minted when the scan happened and keeps in its offline queue. It becomes the custody entry or lot movement id, so replaying the event at any later time changes nothing.",
      example: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e70",
    }),
    code: z.string().min(1).max(200).meta({
      description:
        "The scanned asset tag, external identifier (serial, GTIN) or lot label (LOT:<lot id>).",
      example: "NWL-RAD-014",
    }),
    action: z.enum(Constants.app.Enums.asset_scan_action).meta({
      description:
        "check-out hands the item to one custodian (the unit becomes Deployed); check-in returns it to a venue (the unit becomes Available); transfer passes a deployed unit to another custodian.",
      example: "check-out",
    }),
    custodian_membership_id: orNull(fields.ref("member who takes the item")).optional(),
    custodian_engagement_id: orNull(
      fields.ref("external engagement that takes the item; never together with a member"),
    ).optional(),
    venue_id: orNull(
      fields.ref("venue the item returns to; the unit's home venue by default"),
    ).optional(),
    project_id: orNull(fields.ref("project the item is out for")).optional(),
    note: z.string().max(1000).nullable().optional().meta({
      description: "Hand-over note.",
      example: "Stage left radio.",
    }),
    quantity: z.number().positive().nullable().optional().meta({
      description: "Lots only: how many move.",
      example: 12,
    }),
  })
  .meta({ id: "AssetScanEvent", description: "One custody move scanned on a device." });

const AssetScanResult = z
  .object({
    outcome: z.enum(["applied", "duplicate"]).meta({
      description: "applied for a new event; duplicate when the event id was already applied.",
      example: "applied",
    }),
    subject_kind: z
      .enum(["unit", "lot"])
      .meta({ description: "What the code named.", example: "unit" }),
    subject_id: fields.uuid("The asset unit or lot moved."),
    ledger_id: fields.uuid("The custody entry or lot movement, equal to the event id."),
    asset_state: assetState("Units: the state after the move.").nullable(),
    on_hand: z
      .number()
      .nullable()
      .meta({ description: "Lots: the quantity on hand after the move.", example: 72 }),
  })
  .meta({ id: "AssetScanResult", description: "The outcome of one scan event." });

export const additions = defineAdditions("Assets", {
  corrections: [
    {
      id: "asset-class-element",
      since: SINCE,
      resources: ["assetClasses"],
      change:
        "`element_id` becomes non-null and required on create; removes `urid`, which the canon element carries.",
      reason:
        "app.asset_classes (0352) binds each class to a NOT NULL canon element (one class per element per org) and stores no URID; the URID is xpms.elements.urid of that element.",
      apply: editShape({
        remove: ["urid"],
        add: {
          element_id: {
            schema: fields.code("Canon element the class is.", "5000.02.02-XPMS-003"),
            create: "required",
          },
        },
      }),
    },
    {
      id: "asset-unit-columns",
      since: SINCE,
      resources: ["assetUnits"],
      change:
        "Removes `serial_number` (serials are asset identifiers); adds `condition_enum_id` and `home_venue_id`, both nullable; `asset_tag` is fixed after create; `asset_state` lists the nine asset states. Adds `assetUnits.applyScan`.",
      reason:
        "app.asset_units (0352) keeps serials in app.asset_identifiers, stores a canon Asset Condition and a home venue, refuses a tag change (asset_tag_immutable), and runs the nine-value asset lifecycle. app.apply_asset_scan (0975) is the idempotent custody move Compass replays offline.",
      apply: all(
        editShape({
          remove: ["serial_number"],
          immutable: ["asset_tag"],
          add: {
            condition_enum_id: {
              schema: orNull(
                fields.code(
                  "Condition: a row of the canon Asset Condition enumeration.",
                  "ENM-017",
                ),
              ),
              create: "optional",
              update: true,
            },
            home_venue_id: {
              schema: orNull(fields.ref("venue the unit returns to")),
              create: "optional",
              update: true,
            },
            asset_state: { schema: assetState("Asset lifecycle state.") },
          },
        }),
        putActions(
          [
            collectionAction("applyScan", {
              segment: "scans",
              summary: "Apply a scan event",
              description:
                "Applies one scanned custody move in one transaction (app.apply_asset_scan): resolves the code to a unit or lot, writes the custody entry or lot movement under the device's event id, and moves the unit's state. Replaying an event id returns `duplicate` and changes nothing. A unit someone else moved meanwhile is refused (422, asset_scan_state_conflict); a code no item carries is refused with NO_ANSWER.",
              body: AssetScanEvent,
              response: AssetScanResult,
              rpc: "app.apply_asset_scan",
            }),
          ],
          { applyScan: "assets.custody.write" },
        ),
      ),
    },
    {
      id: "asset-lot-ledger",
      since: SINCE,
      resources: ["assetLots"],
      change:
        "`venue_id` becomes non-null and required on create; `quantity` is the opening count, fixed after create; adds `on_hand`, the quantity on hand.",
      reason:
        "app.asset_lots (0352) places every lot at a NOT NULL venue. Migration 0450 fixes the opening count (asset_lot_quantity_ledger) and moves quantities through the append-only app.asset_lot_movements; on hand is app.asset_lot_balances.",
      apply: editShape({
        immutable: ["quantity"],
        add: {
          venue_id: {
            schema: fields.ref("venue the lot sits at"),
            create: "required",
            update: true,
          },
          on_hand: {
            schema: z.number().meta({
              description: "Quantity on hand: the opening count plus the lot ledger.",
              example: 34,
            }),
          },
        },
      }),
    },
    {
      id: "asset-identifier-scheme",
      since: SINCE,
      resources: ["assetIdentifiers"],
      change:
        "Adds `scheme` (required on create); `identifier_class` is set by the server to identifier.",
      reason:
        "app.asset_identifiers (0352) records a scheme such as serial or gtin14 for each value, and its identifier class is always identifier (asset_identifiers_external).",
      apply: editShape({
        serverSet: ["identifier_class"],
        add: {
          scheme: {
            schema: fields.code("Scheme, such as serial, gtin14 or mpn.", "serial"),
            create: "required",
          },
        },
      }),
    },
    {
      id: "asset-custody-columns",
      since: SINCE,
      resources: ["assetCustodyEntries"],
      change:
        "The custodian is `custodian_membership_id` or `custodian_engagement_id` (never both); the place is `venue_id`; adds `project_id` and `note`; removes `custodian_person_id`, `custodian_organization_id`, `location_venue_id` and `recorded_at` (the entry's `created_at`).",
      reason:
        "app.asset_custody (0352, 0975) hands a unit to a member, an external engagement or a place (asset_custody_somewhere, asset_custody_one_custodian), optionally for a project, with a note; the ledger is append-only and its time is created_at.",
      apply: editShape({
        remove: [
          "custodian_person_id",
          "custodian_organization_id",
          "location_venue_id",
          "recorded_at",
        ],
        add: {
          custodian_membership_id: {
            schema: orNull(fields.ref("member who holds the unit")),
            create: "optional",
          },
          custodian_engagement_id: {
            schema: orNull(fields.ref("external engagement that holds the unit")),
            create: "optional",
          },
          venue_id: { schema: orNull(fields.ref("place the unit is kept")), create: "optional" },
          project_id: {
            schema: orNull(fields.ref("project the unit is out for")),
            create: "optional",
          },
          note: {
            schema: z
              .string()
              .max(1000)
              .nullable()
              .meta({ description: "Hand-over note.", example: "Issued for load-in." }),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "asset-maintenance-currency",
      since: SINCE,
      resources: ["assetMaintenanceEvents"],
      change:
        "`currency` becomes `currency_code`, nullable and optional on create; it is required only with a cost.",
      reason:
        "app.asset_maintenance (0352) stores a nullable currency_code that must be set when cost_minor is (asset_maintenance_cost_currency); an unknown cost leaves both NULL.",
      apply: editShape({
        rename: { currency: "currency_code" },
        nullable: ["currency_code"],
        optionalOnCreate: ["currency_code"],
      }),
    },
    {
      id: "asset-damage-columns",
      since: SINCE,
      resources: ["assetDamageReports"],
      change:
        "Removes `engagement_id`; adds `project_id` and `responsible_counterparty_id`, both nullable; `reported_at` is optional on create.",
      reason:
        "app.asset_damage (0352) records the project during which the damage happened and the counterparty responsible, and defaults reported_at to now.",
      apply: editShape({
        remove: ["engagement_id"],
        optionalOnCreate: ["reported_at"],
        add: {
          project_id: {
            schema: orNull(fields.ref("project during which the damage happened")),
            create: "optional",
            update: true,
          },
          responsible_counterparty_id: {
            schema: orNull(fields.ref("counterparty responsible")),
            create: "optional",
            update: true,
          },
        },
      }),
    },
  ],
});
