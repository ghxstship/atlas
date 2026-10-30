import type { XosClient } from "@xos/data";
import {
  listPermitRulePlaceFacts,
  listProjectOptions,
  listProjectPlaceFacts,
  type PermitFactGroup,
  type ProjectOption,
  type ProjectPlaceFacts,
} from "@xos/data/places";
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
  /** The venue fact groups a reviewer reads beside this rule (B1, app.permit_rule_place_facts); display only. */
  readonly factGroups: readonly PermitFactGroup[];
  /** The project venue's recorded facts; null when the project has no venue. */
  readonly facts: ProjectPlaceFacts | null;
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
  const [requirements, rules, projects, states, transitions, readiness, factMap] =
    await Promise.all([
      listPermitRequirements(db, { orgId, ...(projectId ? { projectId } : {}) }),
      listPermitRules(db),
      listProjectOptions(db, orgId),
      listRecordStates(db),
      listRecordTransitions(db),
      projectId ? getPermitReadiness(db, projectId) : Promise.resolve(null),
      listPermitRulePlaceFacts(db),
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
  const groups = factMap.ok ? factMap.data : new Map<string, readonly PermitFactGroup[]>();
  const facts = await listProjectPlaceFacts(db, [
    ...new Set(requirements.data.map((r) => r.projectId)),
  ]);
  const factsBy = new Map((facts.ok ? facts.data : []).map((f) => [f.projectId, f]));
  const rows = requirements.data
    .map((r) => ({
      ...r,
      canon: ruleBy.get(r.rule) ?? null,
      project: projectBy.get(r.projectId) ?? null,
      factGroups: groups.get(r.rule) ?? [],
      facts: factsBy.get(r.projectId) ?? null,
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
