import type { XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";

/**
 * Shared shapes of the Crew repository (Section 4.2 Crew, migrations 0340 and 0341). Every function
 * takes the caller's client, so row level security decides what each person reads and writes, and
 * Compass (A17) reuses the same functions to clock time against shifts.
 */

/** A membership with the person's display name; the name is null when the person row is hidden. */
export interface MemberRef {
  readonly membershipId: string;
  readonly personId: string | null;
  readonly name: string | null;
}

export interface ProjectRef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
  readonly jurisdictionId: string | null;
}

/** A canon wage-hour rule, inherited down the jurisdiction chain (Section 3.7). */
export interface WageHourRule {
  readonly jurisdictionId: string;
  readonly weeklyOvertimeAfterHours: number | null;
  readonly overtimeMultiplier: number | null;
}

/**
 * The nearest wage-hour rule up a jurisdiction's chain, or null when no level states one (no answer,
 * never a default forty hours). Payroll calculation applies the same rule in SQL (migration 0461).
 */
export async function getWageHourRule(
  db: XosClient,
  jurisdictionId: string | null,
): Promise<Result<WageHourRule | null>> {
  if (jurisdictionId === null) return ok(null);
  const x = db.schema("xpms");
  const [chain, rules] = await Promise.all([
    x.from("jurisdiction").select("jurisdiction_id, parent"),
    x.from("wage_hour_rule").select("jurisdiction_id, weekly_ot_after_hours, min_ot_multiplier"),
  ]);
  if (chain.error) return fail(toDataError(chain.error));
  if (rules.error) return fail(toDataError(rules.error));
  const parent = new Map(chain.data.map((j) => [j.jurisdiction_id, j.parent]));
  const byId = new Map(rules.data.map((r) => [r.jurisdiction_id, r]));
  let id: string | null = jurisdictionId;
  const seen = new Set<string>();
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const rule = byId.get(id);
    if (rule) {
      return ok({
        jurisdictionId: id,
        weeklyOvertimeAfterHours:
          rule.weekly_ot_after_hours === null ? null : Number(rule.weekly_ot_after_hours),
        overtimeMultiplier: rule.min_ot_multiplier === null ? null : Number(rule.min_ot_multiplier),
      });
    }
    id = parent.get(id) ?? null;
  }
  return ok(null);
}

/** A canon role from the Roles Library (xpms.role), listed in numeric code order. */
export interface CanonRole {
  readonly code: string;
  readonly title: string;
  readonly discipline: string;
  readonly rank: string;
}

/** One entry of a lifecycle transition ledger. */
export interface TransitionEntry {
  readonly id: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly reason: string;
  readonly at: string;
  readonly by: string | null;
}

export interface MembershipRow {
  readonly id: string;
  readonly person_id: string;
  readonly person: { readonly full_name: string | null } | null;
}

/** The PostgREST embed that reads a membership and its person's name. */
export const MEMBERSHIP_EMBED =
  "id, person_id, person:people!memberships_person_id_fkey(full_name)";

export function toMemberRef(row: MembershipRow | null, membershipId: string): MemberRef {
  return {
    membershipId,
    personId: row?.person_id ?? null,
    name: row?.person?.full_name ?? null,
  };
}

/**
 * A worker: an org member (membership) or external crew working through an engagement (migration
 * 0940). Externals never hold memberships (Section 4.4), so `membershipId` is empty for them.
 */
export interface WorkerRef extends MemberRef {
  readonly engagementId: string | null;
}

export interface EngagementRow {
  readonly id: string;
  readonly person_id: string | null;
  readonly person: { readonly full_name: string | null } | null;
}

/** The PostgREST embed that reads an engagement and its person's name. */
export const ENGAGEMENT_EMBED =
  "id, person_id, person:people!engagements_person_id_fkey(full_name)";

export function toWorker(
  membership: MembershipRow | null,
  membershipId: string | null,
  engagement: EngagementRow | null,
  engagementId: string | null,
): WorkerRef {
  if (membershipId !== null)
    return { ...toMemberRef(membership, membershipId), engagementId: null };
  return {
    membershipId: "",
    personId: engagement?.person_id ?? null,
    name: engagement?.person?.full_name ?? null,
    engagementId,
  };
}

/** Numeric code order (Section 3.6): URIDs and canon codes compare segment by segment. */
export function byCode(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/** The canon Roles Library, in code order. Readable by every signed-in person. */
export async function listCanonRoles(db: XosClient): Promise<Result<CanonRole[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("role")
    .select("role_code, job_title, discipline, rank");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((r) => ({
        code: r.role_code,
        title: r.job_title,
        discipline: r.discipline,
        rank: r.rank,
      }))
      .sort((a, b) => byCode(a.code, b.code)),
  );
}

/** Active projects of the org the caller may read, by key, for project pickers and filters. */
export async function listCrewProjects(
  db: XosClient,
  orgId: string,
): Promise<Result<ProjectRef[]>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name, time_zone, jurisdiction_id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("archived_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((p) => ({
        id: p.id,
        key: p.project_key,
        name: p.name,
        timeZone: p.time_zone,
        jurisdictionId: p.jurisdiction_id,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}

/** One project by key, or not-found when it does not exist or the caller may not read it. */
export async function getCrewProject(
  db: XosClient,
  orgId: string,
  projectKey: string,
): Promise<Result<ProjectRef>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name, time_zone, jurisdiction_id")
    .eq("org_id", orgId)
    .eq("project_key", projectKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({
    id: data.id,
    key: data.project_key,
    name: data.name,
    timeZone: data.time_zone,
    jurisdictionId: data.jurisdiction_id,
  });
}

/** Active members of the org the caller may see, by name, for assignment pickers. */
export async function listCrewMembers(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<MemberRef[]>> {
  const at = now.toISOString();
  const { data, error } = await db
    .from("memberships")
    .select(MEMBERSHIP_EMBED)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .lte("valid_from", at)
    .or(`valid_to.is.null,valid_to.gt.${at}`);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((m) => toMemberRef(m, m.id))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  );
}

interface TransitionRow {
  id: string;
  from_state: string | null;
  to_state: string;
  reason: string;
  created_at: string;
  created_by: string | null;
}

/** Maps transition ledger rows, oldest first. */
export function toTransitions(rows: readonly TransitionRow[]): TransitionEntry[] {
  return [...rows]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((r) => ({
      id: r.id,
      fromState: r.from_state,
      toState: r.to_state,
      reason: r.reason,
      at: r.created_at,
      by: r.created_by,
    }));
}

/** Names of people by id, for ledgers that record `created_by` or `approved_by` person ids. */
export async function personNames(
  db: XosClient,
  ids: readonly (string | null)[],
): Promise<Result<Map<string, string | null>>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return ok(new Map());
  const { data, error } = await db.from("people").select("id, full_name").in("id", unique);
  if (error) return fail(toDataError(error));
  return ok(new Map(data.map((p) => [p.id, p.full_name])));
}

/** Rows a write touched: one row means it landed, none means the caller may not see the row. */
export function landed(rows: readonly unknown[] | null): Result<null> {
  return rows && rows.length > 0 ? ok(null) : fail({ kind: "not-found" });
}
