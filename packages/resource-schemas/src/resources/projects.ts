/**
 * Projects, scope, gates and activity (Section 4.2 Projects, Home, Activity; Section 7.4 Scope).
 */
import { z } from "zod";
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import { MoneyTotal } from "../common/envelope.ts";
import { defineResource } from "../common/resource.ts";

export const Project = defineResource({
  name: "Project",
  table: "app.projects",
  description: "A production project. Jurisdiction is resolved at gate 1.",
  serverSet: ["current_phase_code", "project_state", "project_key"],
  fields: {
    project_key: f.code("Display key issued by `next_sequence`.", "NWL-24"),
    name: f.text("Project name, Title Case.", "Harborfront Summer Series"),
    description: f
      .longText("Project description.", "Six weekend shows on the harbor lawn.")
      .nullable(),
    workspace_id: f.ref("workspace").nullable(),
    jurisdiction_id: c.JurisdictionId.nullable(),
    region_code: c.RegionCode.nullable(),
    tier_code: c.TierCode,
    current_phase_code: c.PhaseCode,
    project_state: f.stateLabel("Project lifecycle state.", "Active"),
    currency: f.currency("Base currency of the project."),
    starts_on: f.date("First show day.").nullable(),
    ends_on: f.date("Last show day.").nullable(),
  },
});

export const ScopeNode = defineResource({
  name: "ScopeNode",
  table: "app.scope_nodes",
  description: "A node of the project scope tree: engagement root, standing venue or show.",
  immutable: ["project_id", "parent_id"],
  fields: {
    project_id: f.ref("project"),
    parent_id: f.ref("parent scope node").nullable(),
    scope_code: f.code("Scope code, unique in the project.", "E01"),
    name: f.text("Scope node name.", "Opening Weekend"),
    node_kind: f.stateLabel("Kind of node.", "Show"),
    path: f.code("Materialized ltree path, derived.", "root.e01"),
  },
  serverSet: ["path"],
});

export const ProjectPhaseTransition = defineResource({
  name: "ProjectPhaseTransition",
  table: "app.project_phase_transitions",
  description: "An append-only gate transition of a project.",
  serverSet: [
    "project_id",
    "from_phase_code",
    "to_phase_code",
    "transitioned_at",
    "transitioned_by",
  ],
  fields: {
    project_id: f.ref("project"),
    from_phase_code: c.PhaseCode,
    to_phase_code: c.PhaseCode,
    transitioned_at: f.instant("When the gate was passed."),
    transitioned_by: f.ref("person who passed the gate"),
  },
});

export const GateEvidence = defineResource({
  name: "GateEvidence",
  table: "app.gate_evidence",
  description: "Evidence for a gate criterion. One evidence spine serves every criterion.",
  immutable: ["project_id", "criterion_id"],
  fields: {
    project_id: f.ref("project"),
    criterion_id: c.CriterionId,
    record_id: f.ref("record that evidences the criterion").nullable(),
    evidence_document_id: f.ref("evidence document").nullable(),
    attested_by: f.ref("person who attested the evidence"),
    attested_at: f.instant("When the evidence was attested."),
    assertion_rank: f.int("Assertion rank of the evidence, 0 to 4.", 4),
  },
});

export const GateReadiness = defineResource({
  name: "GateReadiness",
  table: "app.mv_gate_readiness",
  description: "Readiness of one gate criterion for a project. Derived, never stored by hand.",
  base: "view",
  fields: {
    project_id: f.ref("project"),
    gate: f.int("Gate ordinal.", 3, 1),
    criterion_id: c.CriterionId,
    blocking: f.bool("Whether the criterion blocks the gate.", true),
    satisfied: f.bool("Whether evidence satisfies the criterion.", false),
  },
});

export const GateTransitionRequest = z
  .object({
    expected_phase_code: c.PhaseCode.meta({
      description: "The phase the caller believes the project is in (compare-and-set).",
    }),
    to_phase_code: c.PhaseCode,
  })
  .meta({ id: "GateTransitionRequest", description: "Request to pass the current gate." });

export const ActivityEvent = defineResource({
  name: "ActivityEvent",
  table: "app.activity_events",
  description: "A user-facing activity feed entry, separate from the compliance audit ledger.",
  base: "tenant",
  serverSet: ["actor_id", "verb", "subject_urn", "project_id", "occurred_at", "summary"],
  fields: {
    actor_id: f.ref("person who acted"),
    verb: f.code("What happened.", "record.state_changed"),
    subject_urn: f.text(
      "URN of the subject.",
      "urn:xpms:record:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    project_id: f.ref("project").nullable(),
    occurred_at: f.instant("When it happened."),
    summary: f.text("Rendered summary key arguments.", "Moved to Scheduled"),
  },
});

export const HomeSummary = defineResource({
  name: "HomeSummary",
  table: "app.v_home_summary",
  description: "The org dashboard: my work, gate readiness and alerts for the caller.",
  base: "view",
  fields: {
    open_work_count: f.int("Records assigned to the caller that are not Complete or Canceled.", 7),
    blocked_work_count: f.int("Assigned records that are Blocked.", 1),
    projects_at_risk_count: f.int(
      "Projects with an unsatisfied blocking criterion at the next gate.",
      2,
    ),
    alert_count: f.int("Unread alerts.", 3),
    committed_spend: MoneyTotal,
  },
});
