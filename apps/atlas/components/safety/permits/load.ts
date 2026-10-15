import type { XosClient } from "@xos/data";
import { listProjectOptions, type ProjectOption } from "@xos/data/places";
import {
  getPermitReadiness,
  listPermitRequirements,
  listPermitRules,
  listRecordStates,
  listRecordTransitions,
  type PermitReadiness,
  type PermitRequirement,
  type PermitRule,
} from "@xos/data/safety-permits";

/** A permit requirement joined to the canon rule that requires it (Bible tab 15, never retyped). */
export interface PermitRow extends PermitRequirement {
  readonly canon: PermitRule | null;
  readonly project: ProjectOption | null;
}

export interface PermitData {
  readonly rows: readonly PermitRow[];
  readonly projects: readonly ProjectOption[];
  readonly states: readonly string[];
  readonly transitions: ReadonlyMap<string, readonly string[]>;
  /** Readiness of the project in focus, when one is chosen. */
  readonly readiness: PermitReadiness | null;
}

/** Loads the permit requirements of the org (or one project) with canon rules, states and moves. */
export async function loadPermits(
  db: XosClient,
  orgId: string,
  projectId: string | undefined,
): Promise<PermitData> {
  const [requirements, rules, projects, states, transitions, readiness] = await Promise.all([
    listPermitRequirements(db, { orgId, ...(projectId ? { projectId } : {}) }),
    listPermitRules(db),
    listProjectOptions(db, orgId),
    listRecordStates(db),
    listRecordTransitions(db),
    projectId ? getPermitReadiness(db, projectId) : Promise.resolve(null),
  ]);
  for (const r of [requirements, rules, projects, states, transitions]) {
    if (!r.ok) throw new Error(`Cannot load permits: ${JSON.stringify(r.error)}`);
  }
  if (readiness && !readiness.ok && readiness.error.kind !== "not-found") {
    throw new Error(`Cannot read permit readiness: ${JSON.stringify(readiness.error)}`);
  }
  if (!requirements.ok || !rules.ok || !projects.ok || !states.ok || !transitions.ok) {
    return { rows: [], projects: [], states: [], transitions: new Map(), readiness: null };
  }
  const ruleBy = new Map(rules.data.map((r) => [r.rule, r]));
  const projectBy = new Map(projects.data.map((p) => [p.id, p]));
  const rows = requirements.data
    .map((r) => ({
      ...r,
      canon: ruleBy.get(r.rule) ?? null,
      project: projectBy.get(r.projectId) ?? null,
    }))
    .sort(
      (a, b) =>
        (a.project?.key ?? "").localeCompare(b.project?.key ?? "") ||
        (a.canon?.ordinal ?? 0) - (b.canon?.ordinal ?? 0),
    );
  return {
    rows,
    projects: projects.data,
    states: states.data,
    transitions: transitions.data,
    readiness: readiness && readiness.ok ? readiness.data : null,
  };
}
