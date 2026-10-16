import { listMembers } from "@xos/data";
import { listAttachments, type Attachment } from "@xos/data/attachments";
import { listThreads, type Thread } from "@xos/data/comments";
import {
  listAllowedTransitions,
  listCriterionStatus,
  listGateCriteria,
  listGateEvidence,
  listPhases,
  listPhaseTransitions,
  type CriterionStatus,
  type GateCriterion,
  type GateEvidence,
  type Phase,
  type PhaseTransition,
} from "@xos/data/projects";
import type { Result } from "@xos/data";
import type { ProjectContext } from "./context";

/** Unwraps a repository result for a page load; a failure surfaces in the page's error boundary. */
export function must<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`Cannot read ${what}: ${JSON.stringify(result.error)}`);
  return result.data;
}

/**
 * Unwraps a result for a part of a page the person may not be allowed to see, such as the activity
 * feed, which Section 4.5.9 hides from Field: not-found and refusal give null, so the page leaves
 * that part out instead of failing. Any other failure still surfaces in the error boundary.
 */
export function optional<T>(result: Result<T>, what: string): T | null {
  if (!result.ok && (result.error.kind === "not-found" || result.error.kind === "refusal")) {
    return null;
  }
  return must(result, what);
}

export interface GateData {
  readonly phases: Phase[];
  readonly criteria: GateCriterion[];
  readonly statuses: CriterionStatus[];
  readonly evidence: GateEvidence[];
  readonly transitions: PhaseTransition[];
  /** The gate the project must pass next; null once gate 9 is passed. */
  readonly currentGate: number | null;
}

/** Canon phases and criteria with the project's evidence and gate history. */
export async function loadGates(ctx: ProjectContext): Promise<GateData> {
  const db = ctx.org.viewer.db;
  const [phases, criteria, statuses, evidence, transitions] = await Promise.all([
    listPhases(db),
    listGateCriteria(db),
    listCriterionStatus(db, [ctx.project.id]),
    listGateEvidence(db, ctx.project.id),
    listPhaseTransitions(db, ctx.project.id),
  ]);
  const p = must(phases, "phases");
  const passed = new Set(must(transitions, "gate history").map((x) => x.gate));
  const phaseGate = p.find((x) => x.code === ctx.project.phaseCode)?.gate ?? null;
  return {
    phases: p,
    criteria: must(criteria, "gate criteria"),
    statuses: must(statuses, "gate readiness"),
    evidence: must(evidence, "gate evidence"),
    transitions: must(transitions, "gate history"),
    currentGate: phaseGate !== null && !passed.has(phaseGate) ? phaseGate : null,
  };
}

/** Allowed project and production moves from the current states (Section 3.12). */
export async function loadTransitions(ctx: ProjectContext) {
  const db = ctx.org.viewer.db;
  const [project, production] = await Promise.all([
    listAllowedTransitions(db, "project", ctx.project.projectState),
    listAllowedTransitions(db, "production", ctx.project.productionState),
  ]);
  return {
    project: must(project, "project transitions"),
    production: must(production, "production transitions"),
  };
}

export interface Collaboration {
  readonly threads: Thread[];
  readonly attachments: Attachment[];
  /** Person id to display name, for comment authors. */
  readonly names: Record<string, string>;
}

/** Comments, attachments and the names of the org's members for the project. */
export async function loadCollaboration(ctx: ProjectContext): Promise<Collaboration> {
  const db = ctx.org.viewer.db;
  const subject = { table: "app.projects", id: ctx.project.id };
  const [threads, attachments, members] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
    listMembers(db, ctx.org.org.id),
  ]);
  const names: Record<string, string> = {};
  for (const m of must(members, "members")) {
    if (m.fullName) names[m.personId] = m.fullName;
  }
  return {
    threads: must(threads, "comments"),
    attachments: must(attachments, "attachments"),
    names,
  };
}
