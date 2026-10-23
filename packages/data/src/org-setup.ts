import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Org setup chosen in Settings (A86, RRR-131, finding A65-004): the canon departments and disciplines an org
 * works in (Section 4.5.6 item 8, migration 1430) and what a new venue starts with (item 9, migration 1431).
 * Reads run as the caller, so every member reads their org's choices; writes go through the RPCs, which check
 * org.departments.write and org.locations.write.
 */

export interface DepartmentsInUse {
  /** Canon department codes, for example 5000. Empty means the org works in every department. */
  readonly departments: readonly string[];
  /** Canon discipline codes, for example 5000.01. */
  readonly disciplines: readonly string[];
}

export async function getDepartmentsInUse(
  db: XosClient,
  orgId: string,
): Promise<Result<DepartmentsInUse>> {
  const [departments, disciplines] = await Promise.all([
    db
      .from("org_departments_in_use")
      .select("dept_code")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("dept_code"),
    db
      .from("org_disciplines_in_use")
      .select("disc_code")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("disc_code"),
  ]);
  if (departments.error) return fail(toDataError(departments.error));
  if (disciplines.error) return fail(toDataError(disciplines.error));
  return ok({
    departments: departments.data.map((r) => r.dept_code),
    disciplines: disciplines.data.map((r) => r.disc_code),
  });
}

/** Replaces both lists; a discipline whose department is not in the list is refused. */
export async function setDepartmentsInUse(
  db: XosClient,
  orgId: string,
  choice: DepartmentsInUse,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_departments_in_use", {
    p_org_id: orgId,
    p_dept_codes: [...choice.departments],
    p_disc_codes: [...choice.disciplines],
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/**
 * The departments a picker offers: every department until the org chooses, then only those in use, plus any
 * the caller must keep showing (for example a department that already has records, so nothing disappears).
 */
export function departmentsInUse<T extends { readonly code: string }>(
  all: readonly T[],
  inUse: readonly string[],
  keep: Iterable<string> = [],
): T[] {
  if (inUse.length === 0) return [...all];
  const shown = new Set([...inUse, ...keep]);
  return all.filter((d) => shown.has(d.code));
}

export interface LocationDefaults {
  /** Canon jurisdiction a new venue starts in, or null. */
  readonly jurisdictionId: string | null;
  /** IANA time zone a new venue starts in, or null for the org's time zone. */
  readonly timeZone: string | null;
}

export const NO_LOCATION_DEFAULTS: LocationDefaults = { jurisdictionId: null, timeZone: null };

export async function getLocationDefaults(
  db: XosClient,
  orgId: string,
): Promise<Result<LocationDefaults>> {
  const { data, error } = await db
    .from("org_location_defaults")
    .select("jurisdiction_id, time_zone")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (data === null) return ok(NO_LOCATION_DEFAULTS);
  return ok({ jurisdictionId: data.jurisdiction_id, timeZone: data.time_zone });
}

/** Records the defaults; null clears one. */
export async function setLocationDefaults(
  db: XosClient,
  orgId: string,
  defaults: LocationDefaults,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_location_defaults", {
    p_org_id: orgId,
    p_jurisdiction_id: defaults.jurisdictionId ?? "",
    p_time_zone: defaults.timeZone ?? "",
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Workspace and team settings pages (ADR 0006 amendment of 2026-10-21) --------------------------------------

/** The memberships in a workspace (app.workspace_members). */
export async function listWorkspaceMembershipIds(
  db: XosClient,
  workspaceId: string,
): Promise<Result<string[]>> {
  const { data, error } = await db
    .from("workspace_members")
    .select("membership_id")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => r.membership_id));
}

export interface TeamSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly membershipIds: readonly string[];
}

/** One team of an org with its live memberships; not-found when it is not the org's or is gone. */
export async function getTeam(
  db: XosClient,
  orgId: string,
  teamId: string,
): Promise<Result<TeamSummary>> {
  const { data, error } = await db
    .from("teams")
    .select("id, name, description, team_members(membership_id, deleted_at)")
    .eq("org_id", orgId)
    .eq("id", teamId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (data === null) return fail({ kind: "not-found" });
  return ok({
    id: data.id,
    name: data.name,
    description: data.description,
    membershipIds: (data.team_members ?? [])
      .filter((m) => m.deleted_at === null)
      .map((m) => m.membership_id),
  });
}

/**
 * What a new venue's form starts with: the org's location defaults, else the first jurisdiction offered and the
 * zone the caller passes (the browser's, the form's behavior before defaults existed). A saved venue keeps its own.
 */
export function venueStartValues(
  defaults: LocationDefaults,
  firstJurisdiction: string | null,
  fallbackZone: string,
): { readonly jurisdictionId: string; readonly timeZone: string } {
  return {
    jurisdictionId: defaults.jurisdictionId ?? firstJurisdiction ?? "",
    timeZone: defaults.timeZone ?? fallbackZone,
  };
}
