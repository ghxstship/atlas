/**
 * Places operations beyond the frozen v1 catalog (additive only, Section 10.1), and corrections to
 * the frozen Places resources (ADR 0023) so each shape matches its table: app.venues and the Places
 * tables of 0301 and 0350, the venue location of 0420, capability statements and reconciliations of
 * 0351 and 0420, and geofences written through app.save_geofence (0422) and read from
 * app.geofence_shapes (0366).
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, setTable } from "../correct.ts";
import { placesFieldHomes } from "./parts/playbook-field-homes.ts";
import { Constants } from "@xos/data/database.types";

const SINCE = "1.0.0-draft.2";

const GeoJsonPolygon = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()])).min(1)).min(1),
  })
  .meta({
    id: "GeoJsonPolygon",
    description:
      "A GeoJSON Polygon in WGS 84 (RFC 7946): rings of [longitude, latitude] positions.",
    example: {
      type: "Polygon",
      coordinates: [
        [
          [-80.19, 25.77],
          [-80.18, 25.77],
          [-80.18, 25.78],
          [-80.19, 25.77],
        ],
      ],
    },
  });

export const additions = defineAdditions("Places", {
  corrections: [
    {
      id: "venue-address-and-location",
      since: SINCE,
      resources: ["venues"],
      change:
        "`address_line1` becomes `street_address`; removes `region` and `country` (the jurisdiction carries geography); `street_address`, `locality` and `postal_code` become nullable; `jurisdiction_id` becomes non-null and required on create. `latitude` and `longitude` stay nullable and are written together.",
      reason:
        "app.venues (0301) stores `street_address`, nullable `locality` and `postal_code`, a NOT NULL `jurisdiction_id` and no region or country; the location is one nullable geography point (0420) read through app.venue_latitude and app.venue_longitude.",
      apply: editShape({
        rename: { address_line1: "street_address" },
        remove: ["region", "country"],
        nullable: ["street_address", "locality", "postal_code"],
        add: {
          jurisdiction_id: { schema: canonCodes.JurisdictionId, create: "required" },
        },
      }),
    },
    {
      id: "space-urid",
      since: SINCE,
      resources: ["spaces"],
      change: "Adds `urid`, the canon category of the space type, nullable.",
      reason: "app.spaces (0350) keys each space to an optional URID category.",
      apply: editShape({
        add: { urid: { schema: orNull(canonCodes.Urid), create: "optional" } },
      }),
    },
    {
      id: "zone-venue-and-code",
      since: SINCE,
      resources: ["zones"],
      change:
        "Adds `venue_id` (required on create, immutable); `zone_code` becomes `code`; `space_id` becomes nullable and may change.",
      reason:
        "app.zones (0350) belongs to a venue, optionally within one of its spaces (0422 guards that the space is in the same venue), with a code unique per venue.",
      apply: all(
        editShape({
          rename: { zone_code: "code" },
          add: {
            venue_id: { schema: fields.ref("venue"), create: "required", update: false },
            space_id: {
              schema: orNull(fields.ref("space the zone sits in")),
              create: "optional",
              update: true,
            },
          },
        }),
      ),
    },
    {
      id: "capability-document-title-and-uri",
      since: SINCE,
      resources: ["capabilityDocuments"],
      change: "Replaces `document_id` with `title` and `document_uri` (both required on create).",
      reason:
        "app.capability_documents (0350) stores the document's title and where it lives, not a document row reference.",
      apply: editShape({
        remove: ["document_id"],
        add: {
          title: { schema: fields.text("Document title.", "Tech Pack 2027"), create: "required" },
          document_uri: {
            schema: fields.text(
              "Where the document is stored.",
              "https://docs.example.com/tech-pack.pdf",
              2000,
            ),
            create: "required",
          },
        },
      }),
    },
    {
      id: "site-plan-project-and-image",
      since: SINCE,
      resources: ["sitePlans"],
      change:
        "Adds `project_id` (required on create, immutable) and `image_uri` (required); replaces `document_id`; `venue_id` becomes nullable and may change.",
      reason:
        "app.site_plans (0350) belongs to a project, may name the venue it draws, and stores where the drawing lives.",
      apply: editShape({
        remove: ["document_id"],
        add: {
          project_id: { schema: fields.ref("project"), create: "required", update: false },
          venue_id: { schema: orNull(fields.ref("venue drawn")), create: "optional", update: true },
          image_uri: {
            schema: fields.text("Where the drawing is stored.", "plans/ground.png", 2000),
            create: "required",
          },
        },
      }),
    },
    {
      id: "site-plan-pin-targets",
      since: SINCE,
      resources: ["sitePlanPins"],
      change: "Adds `zone_id` and `record_id`, the zone or record a pin marks, both nullable.",
      reason: "app.site_plan_pins (0350) can mark a zone or a record.",
      apply: editShape({
        add: {
          zone_id: { schema: orNull(fields.ref("zone the pin marks")), create: "optional" },
          record_id: { schema: orNull(fields.ref("record the pin marks")), create: "optional" },
        },
      }),
    },
    {
      id: "geofence-polygon",
      since: SINCE,
      resources: ["geofences"],
      components: ["schemas/GeoJsonPolygon"],
      change:
        "Replaces the circle (`latitude`, `longitude`, `radius_m`) with `boundary`, a GeoJSON Polygon; adds `zone_id`; `venue_id` becomes non-null and required on create. The boundary reads back through app.geofence_shapes.",
      reason:
        "app.geofences (0350) stores a WGS 84 polygon boundary for a venue and optional zone; app.geofence_shapes (0366) reads it as GeoJSON and app.save_geofence (0422) writes it.",
      apply: all(
        editShape({
          remove: ["latitude", "longitude", "radius_m"],
          add: {
            venue_id: { schema: fields.ref("venue"), create: "required", update: false },
            zone_id: {
              schema: orNull(fields.ref("zone the geofence outlines")),
              create: "optional",
            },
            boundary: { schema: GeoJsonPolygon, create: "required" },
          },
        }),
      ),
    },
    {
      id: "requirement-capability-statements",
      since: SINCE,
      resources: ["requirements"],
      components: ["schemas/Direction"],
      change:
        "Reads app.capability_statements. `statement` becomes `description`, `unit` becomes `unit_basis`, `critical` becomes `is_critical`, and `assertion_rank` becomes `assertion_word` (a canon capability assertion word); `project_id` becomes non-null and required on create; `direction` takes the stored labels Require and Provide; `is_critical` is optional on create; adds `counterparty_id`.",
      reason:
        "Requirements and capabilities share app.capability_statements (0351) with a direction facet; each belongs to a project, names its provider (venue or counterparty) when it is a capability, and carries the canon capability assertion word (Bible tab 22), whose rank comes from canon.",
      apply: all(
        setTable("app.capability_statements"),
        editShape({
          rename: { statement: "description", unit: "unit_basis", critical: "is_critical" },
          remove: ["assertion_rank"],
          optionalOnCreate: ["is_critical"],
          add: {
            direction: {
              schema: z.enum(Constants.app.Enums.capability_direction).meta({
                description:
                  "Require for a requirement of the project, Provide for a capability a venue or counterparty offers.",
                example: "Require",
              }),
              create: "required",
              update: false,
            },
            project_id: { schema: fields.ref("project"), create: "required", update: false },
            counterparty_id: {
              schema: orNull(fields.ref("counterparty that provides a capability")),
              create: "optional",
            },
            assertion_word: {
              schema: z.enum(["CERTIFIED", "DOCUMENTED", "CLAIMED", "INFERRED", "UNKNOWN"]).meta({
                description:
                  "Canon capability assertion word (Bible tab 22); silence is UNKNOWN, which reconciles as Unknown.",
                example: "DOCUMENTED",
              }),
              create: "optional",
            },
          },
        }),
      ),
    },
    {
      id: "reconciliation-note",
      since: SINCE,
      resources: ["reconciliations"],
      change: "Removes `venue_id`; adds `note`. The counts are derived from the lines.",
      reason:
        "app.reconciliations (0351) is a run over a whole project with a note; app.reconcile_project (0420) writes it and its lines in one transaction.",
      apply: editShape({
        remove: ["venue_id"],
        add: {
          note: {
            schema: orNull(fields.longText("Notes on the run.", "Venue walk.")),
            create: "optional",
          },
        },
      }),
    },
    ...placesFieldHomes,
  ],
});
