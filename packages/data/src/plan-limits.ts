import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { bool, num, numOrNull, rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * Objects over the plan's limits (A107, migrations 1720 and 1721; Section 16, ADR 0060). A downgrade or the end of a
 * trial deletes nothing: the projects past active_projects and the seats past seats or field_members turn read-only,
 * and the database refuses a person's writes to them with plan_limit_read_only. Owners' seats rank first and are never
 * read-only; then come the objects the Owner chose to keep writable, then the oldest. Archiving, ending a membership
 * or upgrading lifts the guard at once, because the database recomputes the read-only set on every such change.
 * Reads run with the caller's row level security; the choice goes through app.choose_plan_limit_keeps.
 */

/** The limits that count standing objects, so the objects past them turn read-only. */
export const OBJECT_LIMITS = ["active_projects", "seats", "field_members"] as const;
export type ObjectLimit = (typeof OBJECT_LIMITS)[number];

const isObjectLimit = (v: unknown): v is ObjectLimit =>
  typeof v === "string" && (OBJECT_LIMITS as readonly string[]).includes(v);

export interface PlanLimitUsage {
  readonly limit: ObjectLimit;
  /** Plan in force. */
  readonly planCode: string;
  /** The limit, or null when the plan has none. */
  readonly limitValue: number | null;
  /** Objects the limit counts, read-only ones included. */
  readonly inUse: number;
  /** Objects past the limit, read-only now. */
  readonly readOnly: number;
}

/** For each object limit: the plan, the limit, how many objects it counts and how many are read-only (members). */
export function getPlanLimitUsage(
  db: XosClient,
  orgId: string,
): Promise<Result<readonly PlanLimitUsage[]>> {
  return rpc(db, "plan_limit_usage", { p_org_id: orgId }, (data) =>
    ((data as Raw[] | null) ?? []).flatMap((r) =>
      isObjectLimit(r["limit_code"])
        ? [
            {
              limit: r["limit_code"],
              planCode: str(r["plan_code"]),
              limitValue: numOrNull(r["limit_value"]),
              inUse: num(r["in_use"]),
              readOnly: num(r["read_only"]),
            },
          ]
        : [],
    ),
  );
}

export interface PlanLimitCandidate {
  /** The project's id for active_projects, the membership's id for seats and field_members. */
  readonly id: string;
  /** The project's or the member's name; null for a person with no name yet. */
  readonly label: string | null;
  readonly projectKey: string | null;
  /** The member's best role: a system role's code, or a custom role's name. */
  readonly roleCode: string | null;
  readonly roleName: string | null;
  readonly createdAt: string;
  readonly chosen: boolean;
  /** An Owner's seat: always writable, never chosen. */
  readonly locked: boolean;
  readonly readOnly: boolean;
}

export function toCandidate(r: Raw): PlanLimitCandidate {
  return {
    id: str(r["project_id"] ?? r["membership_id"]),
    label: strOrNull(r["label"]),
    projectKey: strOrNull(r["project_key"]),
    roleCode: strOrNull(r["role_code"]),
    roleName: strOrNull(r["role_name"]),
    createdAt: str(r["created_at"]),
    chosen: bool(r["chosen"]),
    locked: bool(r["locked"]),
    readOnly: bool(r["read_only"]),
  };
}

/** The objects one limit counts, in the order of the selection rule (billing readers). */
export function listPlanLimitCandidates(
  db: XosClient,
  orgId: string,
  limit: ObjectLimit,
): Promise<Result<readonly PlanLimitCandidate[]>> {
  return rpc(db, "plan_limit_candidates", { p_org_id: orgId, p_limit: limit }, (data) =>
    ((data as Raw[] | null) ?? []).map(toCandidate),
  );
}

/**
 * The Owner keeps these objects writable for one limit, replacing the earlier choice; returns how many objects of the
 * limit are read-only afterwards. Refusals: plan_limit_choice_too_many, plan_limit_choice_unknown.
 */
export function choosePlanLimitKeeps(
  db: XosClient,
  orgId: string,
  limit: ObjectLimit,
  keep: readonly string[],
): Promise<Result<number>> {
  return rpc(
    db,
    "choose_plan_limit_keeps",
    { p_org_id: orgId, p_limit: limit, p_keep: [...keep] },
    (data) => num(data),
  );
}

export interface ProjectOverLimit {
  /** Plan whose active_projects limit the project is past. */
  readonly planCode: string;
  /** When the project turned read-only. */
  readonly since: string;
}

/** Whether a project is read-only because the org is over active_projects, or null when it is writable. */
export async function getProjectOverLimit(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectOverLimit | null>> {
  const { data, error } = await untyped(db)
    .from("over_limit_objects")
    .select("plan_code, created_at")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  const row = data as Raw | null;
  return ok(row ? { planCode: str(row["plan_code"]), since: str(row["created_at"]) } : null);
}
