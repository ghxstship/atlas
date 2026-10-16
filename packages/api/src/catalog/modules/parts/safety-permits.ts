/**
 * The permit engine and inspections part of the Safety module (A09): corrections to the frozen
 * resources (ADR 0023) so each shape matches its table in 0353, 0420 and 0421, and the actions added
 * to them. catalog/modules/safety.ts spreads these beside A14's incident corrections.
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import type { ActionSpec } from "../../types.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { itemAction } from "../../define.ts";
import { editShape, orNull } from "../../correct.ts";

const SINCE = "1.0.0-draft.2";

export const permitCorrections: readonly CorrectionInput[] = [
  {
    id: "inspection-template-no-tag",
    since: SINCE,
    resources: ["inspectionTemplates"],
    change: "Removes `tag_id`; a template carries no tag.",
    reason: "app.inspection_templates (0353) has no tag column.",
    apply: editShape({ remove: ["tag_id"] }),
  },
  {
    id: "inspection-item-critical",
    since: SINCE,
    resources: ["inspectionItems"],
    change: "Replaces `requires_photo` with `is_critical` (optional on create, default false).",
    reason:
      "app.inspection_items (0353) flags an item whose failure stops use; it has no photo requirement column.",
    apply: editShape({
      remove: ["requires_photo"],
      add: {
        is_critical: {
          schema: fields.bool("Whether a failure of this item stops use.", true),
          create: "optional",
        },
      },
    }),
  },
  {
    id: "inspection-inspector-from-session",
    since: SINCE,
    resources: ["inspections"],
    change:
      "`inspector_id` becomes `inspector_person_id`, set by the server from the session and nullable; removes `zone_id` and `inspection_state` (progress is derived from the results); adds `record_id` (the Inspection record that tracks it, which may be linked later) and `inspected_at` (optional on create, default now).",
    reason:
      "app.inspections (0353) stamps the inspector from the session, links an optional Inspection record, stores when it took place, and has no zone or state column; app.start_inspection (0421) creates it.",
    apply: editShape({
      rename: { inspector_id: "inspector_person_id" },
      remove: ["zone_id", "inspection_state"],
      serverSet: ["inspector_person_id"],
      add: {
        inspector_person_id: { schema: orNull(fields.ref("inspector, from the session")) },
        record_id: {
          schema: orNull(fields.ref("Inspection record of the same project")),
          create: "optional",
          update: true,
        },
        inspected_at: {
          schema: fields.instant("When the inspection took place."),
          create: "optional",
          update: false,
        },
      },
    }),
  },
  {
    id: "inspection-result-canon-enumeration",
    since: SINCE,
    resources: ["inspectionResults"],
    change:
      "Replaces `passed` with `result_enum_id`, a row of the canon Inspection Result enumeration (required on create); `notes` becomes `note` and `photo_document_id` becomes `photo_uri` (a field-media object name); adds `project_id`, set by the server from the inspection.",
    reason:
      "app.inspection_results (0353, 0368, 0420) stores a canon Inspection Result row (Passed, Passed with Conditions, Failed, Re-inspection Required, Pending), a note, the field-media photo object name, and the inspection's project; app.record_inspection_result (0421) writes it and opens the punch item for a failure.",
    apply: editShape({
      rename: { notes: "note" },
      remove: ["passed", "photo_document_id"],
      add: {
        result_enum_id: {
          schema: canonCodes.StdCode.meta({
            description:
              "Row of the canon Inspection Result enumeration, for example ENM-084 (Failed).",
            example: "ENM-084",
          }),
          create: "required",
        },
        photo_uri: {
          schema: orNull(
            fields.text(
              "Object name of the finding's photo in the field-media bucket.",
              "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f/inspections/0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f/rail.jpg",
              500,
            ),
          ),
          create: "optional",
        },
        project_id: { schema: fields.ref("project, from the inspection") },
      },
      serverSet: ["project_id"],
    }),
  },
  {
    id: "permit-requirement-canon-and-record",
    since: SINCE,
    resources: ["permitRequirements"],
    change:
      "Replaces `due_on` with `lead_time`, the lead time exactly as canon states it; `permit_state` (the tracking Permit record's state) becomes nullable; adds `record_id` and `trigger_type`.",
    reason:
      "app.permit_requirements (0353) stores the canon rule and the Permit record that tracks it. The permit, authority, jurisdiction, trigger and lead time are read from xpms.dim_permit_rule and never stored or computed: canon states lead times as text (for example 4-6 wks), so a due date would be invented. A requirement has no state until a Permit record tracks it.",
    apply: editShape({
      remove: ["due_on"],
      nullable: ["permit_state"],
      add: {
        lead_time: {
          schema: fields.text("Lead time as canon states it.", "4-6 wks"),
        },
        trigger_type: {
          schema: fields.code(
            "What triggers the canon rule: threshold, project, element or condition.",
            "project",
          ),
        },
        record_id: { schema: orNull(fields.ref("Permit record tracking the requirement")) },
      },
      serverSet: ["lead_time", "trigger_type", "record_id"],
    }),
  },
];

/** Actions added to the permit and inspection resources (additive, Section 10.1). */
export const permitActions: Readonly<Record<string, readonly ActionSpec[]>> = {
  permitRequirements: [
    itemAction("track", {
      summary: "Track a permit requirement",
      description:
        "Opens the Permit record that tracks the requirement (app.track_permit_requirement), titled with the canon permit, in one transaction. A requirement already tracked returns a 422 `permit_requirement_tracked` refusal.",
      body: z
        .object({
          title: z.string().min(1).max(200).optional().meta({
            description: "Record title; defaults to the canon permit text.",
            example: "Special Events Permit",
          }),
        })
        .meta({ id: "PermitTrackRequest" }),
    }),
  ],
};

/** Capabilities of the added actions. */
export const permitCapabilities: Readonly<Record<string, CapabilityRule>> = {
  permitRequirements: { actions: { track: "safety.permit.write" } },
};
