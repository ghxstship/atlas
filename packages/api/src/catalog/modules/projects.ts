/**
 * Projects operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Projects resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Projects resources follow ADR 0023.
 */
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, removeActions, removeVerbs } from "../correct.ts";
import { itemAction } from "../define.ts";
import { b7ProjectCapabilities, b7ProjectResources } from "./parts/b7.ts";
import { measurementCapabilities, measurementResources } from "./parts/measurements.ts";
import { projectsFieldHomes } from "./parts/playbook-field-homes.ts";
import {
  projectAuthorityCapabilities,
  projectAuthorityResources,
} from "./parts/playbook-field-exposure.ts";

const EVIDENCE_URI = fields.text(
  "Where the evidence lives: a document or record URI.",
  "urn:xpms:documents:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
  2000,
);

export const additions = defineAdditions("Projects", {
  resources: [...projectAuthorityResources, ...measurementResources, ...b7ProjectResources],
  capabilities: {
    ...projectAuthorityCapabilities,
    ...measurementCapabilities,
    ...b7ProjectCapabilities,
  },
  corrections: [
    {
      id: "project-create-key-and-time-zone",
      since: "1.0.0-draft.2",
      resources: ["projects"],
      change:
        "ProjectCreate takes `project_key` and `time_zone` (required) and `venue_id`; `currency` and `tier_code` become optional. The read shape adds `time_zone`, `venue_id`, `client_counterparty_id`, `production_state` and `archived_at`, and `tier_code` becomes nullable.",
      reason:
        "app.projects (0301, 0400) has NOT NULL `project_key` and `time_zone` with no default, and app.create_project takes both from the caller; the key is chosen by the caller, not issued by next_sequence. `currency` defaults from the organization (0950) and `tier_code` is nullable.",
      apply: editShape({
        nullable: ["tier_code"],
        optionalOnCreate: ["currency"],
        add: {
          project_key: {
            schema: fields.code(
              "Project key, chosen by the caller and unique in the organization; it addresses the project in Atlas URLs.",
              "NWL-24",
            ),
            create: "required",
          },
          time_zone: {
            schema: fields.timeZone(
              "IANA time zone of the project; local times are entered in it.",
            ),
            create: "required",
          },
          venue_id: {
            schema: orNull(fields.ref("primary venue of the project")),
            create: "optional",
          },
          client_counterparty_id: {
            schema: orNull(fields.ref("client counterparty the project is produced for")),
            update: true,
          },
          production_state: {
            schema: fields.stateLabel(
              "Production lifecycle state, which runs beside the project state; changes only through its transition RPC.",
              "Proposed",
            ),
          },
          archived_at: {
            schema: orNull(
              fields.instant(
                "When the project was archived; archived projects leave the default lists.",
              ),
            ),
          },
        },
      }),
    },
    {
      id: "project-archive-not-delete",
      since: "1.0.0-draft.2",
      resources: ["projects"],
      change:
        "Removes `projects.delete` and `projects.duplicate`. Adds `projects.archive` and `projects.unarchive`, which set and clear `archived_at`.",
      reason:
        "Projects are archived, never deleted: app.projects keeps `archived_at` and the capability for removal is projects.project.archive. Duplication is a template feature (Platform templates), not a project operation, and no schema or RPC supports copying a project.",
      apply: all(
        removeVerbs("delete"),
        removeActions("duplicate"),
        putActions(
          [
            itemAction("archive", {
              summary: "Archive a project",
              description:
                "Sets `archived_at`, so the project leaves the default lists and stays readable and restorable. Archiving an archived project leaves it unchanged.",
            }),
            itemAction("unarchive", {
              summary: "Restore an archived project",
              description: "Clears `archived_at`, so the project returns to the default lists.",
            }),
          ],
          { archive: "projects.project.archive", unarchive: "projects.project.archive" },
        ),
      ),
    },
    {
      id: "phase-transition-nullable-target",
      since: "1.0.0-draft.2",
      resources: ["projectPhaseTransitions"],
      change: "`to_phase_code` becomes nullable.",
      reason:
        "app.project_phase_transitions (0301) stores `to_phase_code` NULL when gate 9 closes the last phase: there is no phase after it.",
      apply: editShape({ nullable: ["to_phase_code"] }),
    },
    {
      id: "gate-evidence-uri",
      since: "1.0.0-draft.2",
      resources: ["gateEvidence"],
      change:
        "Replaces `evidence_document_id` with `evidence_uri` (required on create) and adds `note`. `attested_by` and `attested_at` become server-set and `attested_by` nullable. Removes `gateEvidence.update`: evidence is withdrawn (deleted), never edited.",
      reason:
        "The evidence spine app.gate_evidence (0301) stores an evidence URI and a note, has no document column, stamps `attested_by` and `attested_at` in its guard trigger, and refuses every edit except withdrawal (gate_evidence_immutable).",
      apply: all(
        editShape({
          remove: ["evidence_document_id"],
          nullable: ["attested_by"],
          serverSet: ["attested_by", "attested_at"],
          add: {
            evidence_uri: {
              schema: orNull(EVIDENCE_URI),
              writeSchema: EVIDENCE_URI,
              create: "required",
            },
            note: {
              schema: orNull(
                fields.text("Note on the evidence.", "Signed by the venue manager.", 2000),
              ),
              create: "optional",
            },
          },
        }),
        removeVerbs("update"),
      ),
    },
    ...projectsFieldHomes,
  ],
});
