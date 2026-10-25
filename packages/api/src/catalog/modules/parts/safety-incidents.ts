/**
 * Corrections to the frozen Safety incident resources (ADR 0023), owned by A14 (RRR-26) and spread
 * into the Safety module file, which A09 shares for permits and inspections. Against migrations
 * 0353, 0363 (A03F), 0470 and 0471.
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import type { CorrectionInput } from "../../corrections.ts";
import {
  all,
  editShape,
  orNull,
  putActions,
  removeVerbs,
  setOrder,
  setTable,
} from "../../correct.ts";
import { itemAction, transition } from "../../define.ts";

const SINCE = "1.0.0-draft.2";

const incidentState = z
  .enum(["Reported", "Dispatched", "Contained", "Closed"])
  .meta({ description: "Incident state.", example: "Reported" });
const movableState = z.enum(["Reported", "Dispatched", "Contained"]);

export const incidentCorrections: readonly CorrectionInput[] = [
  {
    id: "incident-canon-severity-and-lifecycle",
    since: SINCE,
    resources: ["incidents"],
    components: ["schemas/IncidentTransitionRequest", "schemas/IncidentCloseRequest"],
    change:
      "`severity` becomes the canon `severity_enum_id` (required); `incident_number` is an integer; `incident_state` is Reported, Dispatched, Contained or Closed; adds `reported_by` and `closed_signed_off_by` (set by the database) and the offline fields `accuracy_m` and `device_reported_at`; removes `emergency_code_id`. The transition moves between Reported, Dispatched and Contained; `close` takes a required sign-off note.",
    reason:
      "app.incidents (0353, 0470) stores severity as a row of the canon Incident Severity enumeration, numbers incidents from the project display key sequence (bigint), runs the incident lifecycle Reported, Dispatched, Contained, Closed, sets the reporter from the session and records sign-off only through app.close_incident, whose note is the ledger reason (invariant 22). Location accuracy and device time come from Compass (0470). Incidents carry no emergency code: crisis alerts do.",
    apply: all(
      editShape({
        remove: ["severity", "emergency_code_id", "incident_number", "incident_state"],
        add: {
          severity_enum_id: {
            schema: fields.code(
              "Severity: a row of the canon Incident Severity enumeration.",
              "ENM-097",
            ),
            create: "required",
            update: true,
          },
          incident_number: {
            schema: z.int().min(1).meta({
              description: "Number from the project's display key sequence.",
              example: 142,
            }),
          },
          incident_state: { schema: incidentState },
          reported_by: { schema: orNull(fields.ref("reporter, from the session")) },
          closed_signed_off_by: { schema: orNull(fields.ref("person who signed off the closure")) },
          accuracy_m: {
            schema: orNull(fields.quantity("Horizontal accuracy of the location in meters.", 8)),
            create: "optional",
          },
          device_reported_at: {
            schema: orNull(
              fields.instant(
                "When the reporter filed it on the device, for a report queued offline.",
              ),
            ),
            create: "optional",
          },
        },
      }),
      putActions([
        transition("Incident", ["Reported", "Dispatched"], movableState),
        itemAction("close", {
          summary: "Close an incident",
          description:
            "Closes a contained incident with sign-off through app.close_incident; the caller is recorded as the person signing off. The reporter of a critical incident cannot sign off its closure (422).",
          body: z
            .object({
              note: z
                .string()
                .min(1)
                .max(500)
                .meta({ description: "Sign-off note.", example: "Area inspected and safe." }),
            })
            .meta({
              id: "IncidentCloseRequest",
              description: "Request to close an incident with sign-off.",
            }),
        }),
      ]),
    ),
  },
  {
    id: "incident-party-description",
    since: SINCE,
    resources: ["incidentParties"],
    change: "Replaces `involvement` and `name_if_unknown` with a required `description`.",
    reason:
      "app.incident_parties (0353) stores one NOT NULL description: the role of a known person, or a description of an unknown one.",
    apply: editShape({
      remove: ["involvement", "name_if_unknown"],
      add: {
        description: {
          schema: fields.text(
            "Role in the incident, or a description of an unknown person.",
            "Witness",
          ),
          create: "required",
          update: true,
        },
      },
    }),
  },
  {
    id: "incident-media-uri",
    since: SINCE,
    resources: ["incidentMediaItems"],
    change:
      "Replaces `document_id` with a required `media_uri`; adds `captured_at` and `project_id`, copied from the incident.",
    reason:
      "app.incident_media (0353, 0470) stores where the file is stored and when it was captured, not a document id, and copies the incident's project for Compass sync.",
    apply: editShape({
      remove: ["document_id"],
      add: {
        media_uri: {
          schema: fields.text(
            "Where the photo or video is stored.",
            "org/incidents/gate.jpg",
            1000,
          ),
          create: "required",
        },
        captured_at: {
          schema: orNull(fields.instant("When it was captured.")),
          create: "optional",
        },
        project_id: { schema: fields.ref("project of the incident, copied from it") },
      },
    }),
  },
  {
    id: "dispatch-membership",
    since: SINCE,
    resources: ["dispatchAssignments"],
    change:
      "The responder is `membership_id` (required, immutable); `dispatched_at` is set by the database; removes `responder_id` and `cleared_at`.",
    reason:
      "app.dispatch_assignments (0353) names the responder by membership and has no cleared time: a responder is withdrawn by soft delete. dispatched_at defaults to now.",
    apply: editShape({
      remove: ["responder_id", "cleared_at"],
      add: { membership_id: { schema: fields.ref("responder's membership"), create: "required" } },
      serverSet: ["dispatched_at"],
      immutable: ["membership_id"],
    }),
  },
  {
    id: "medical-encounter-restricted-notes",
    since: SINCE,
    resources: ["medicalEncounters"],
    change:
      "Adds a required `patient_description`; `notes` becomes the Restricted `treatment_notes`, masked unless the caller holds data.restricted.read.medical; `disposition` is free text and nullable; removes `treated_by`.",
    reason:
      "app.medical_encounters (0353, 0363) stores a NOT NULL patient description, Restricted treatment notes encrypted by app.record_medical_encounter and read only through app.medical_encounters_masked, and a nullable disposition. It does not record the treating medic (created_by is the recorder).",
    apply: all(
      editShape({
        remove: ["treated_by", "disposition", "notes"],
        add: {
          patient_description: {
            schema: fields.text(
              "Who was treated, without identifying medical detail.",
              "Guest, adult",
            ),
            create: "required",
            update: true,
          },
          treatment_notes: {
            schema: orNull(
              fields.longText(
                "Treatment given. Restricted.",
                "Abrasion to the left knee, cleaned and dressed.",
              ),
            ),
            create: "optional",
            update: true,
          },
          disposition: {
            schema: orNull(fields.text("Outcome, such as released or transported.", "Released")),
            create: "optional",
            update: true,
          },
        },
      }),
      (spec) => ({ ...spec, def: { ...spec.def, restricted: ["treatment_notes"] } }),
    ),
  },
  {
    id: "crisis-alert-code-and-end",
    since: SINCE,
    resources: ["crisisAlerts"],
    change:
      "`emergency_code_id` becomes `emergency_code` (a global canon code, required); `cleared_at` becomes `ended_at`; `issued_at` is set by the database.",
    reason:
      "app.crisis_alerts (0353) references the global xpms.emergency_code by its code (decision D15), records the all-clear in ended_at and defaults issued_at to now.",
    apply: editShape({
      remove: ["emergency_code_id"],
      rename: { cleared_at: "ended_at" },
      add: {
        emergency_code: {
          schema: fields.code("Canon emergency code announced.", "CODE_RED"),
          create: "required",
        },
      },
      serverSet: ["issued_at"],
    }),
  },
  {
    id: "emergency-codes-global-canon",
    since: SINCE,
    resources: ["emergencyCodes"],
    change:
      "Emergency codes are read-only global canon keyed by `code`, served from xpms.emergency_code with `label`, `emergency`, `swatch` and `sort_order`; removes create, update and delete, the tenant base fields, `name` and `response`. Listed in canon order.",
    reason:
      "Decision D15 and migration 0353: the emergency code words are one global Standard Library shared by every organization and project, and this resource serves them as canon states them. An org's editable copy of the codes (its labels, emergencies and order) is app.emergency_codes (migration 1612, finding A65-027), which this resource does not serve. Protocols per operational domain are xpms.emergency_protocol.",
    apply: all(
      editShape({
        remove: [
          "id",
          "org_id",
          "created_at",
          "created_by",
          "updated_at",
          "updated_by",
          "name",
          "response",
          "code",
        ],
        add: {
          code: { schema: fields.code("Code token.", "CODE_RED") },
          label: { schema: fields.text("Code word.", "Code Red") },
          emergency: { schema: fields.text("The emergency the code announces.", "Fire Emergency") },
          swatch: { schema: fields.code("Design token of the swatch.", "ecode-red") },
          sort_order: { schema: z.int().min(1).meta({ description: "Canon order.", example: 1 }) },
        },
        key: "code",
      }),
      removeVerbs("create", "update", "delete"),
      setTable("xpms.emergency_code"),
      setOrder({
        by: ["sort_order"],
        numeric: true,
        examples: [{ sort_order: 1 }, { sort_order: 2 }],
      }),
    ),
  },
  {
    id: "radio-channel-number-and-project",
    since: SINCE,
    resources: ["radioChannels"],
    change:
      "`channel` becomes `channel_number`; `project_id` is required and immutable; adds `zone_id`; removes `frequency_mhz`.",
    reason:
      "app.radio_channels (0353) is the radio plan of one project (NOT NULL), unique by channel number per project, optionally covering a zone, and stores no frequency.",
    apply: editShape({
      remove: ["frequency_mhz", "project_id"],
      rename: { channel: "channel_number" },
      add: {
        project_id: { schema: fields.ref("project"), create: "required" },
        zone_id: {
          schema: orNull(fields.ref("zone the channel covers")),
          create: "optional",
          update: true,
        },
      },
      immutable: ["project_id"],
    }),
  },
];
