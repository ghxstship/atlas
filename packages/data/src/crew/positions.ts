import type { XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import { landed } from "./shared.ts";

/**
 * Project positions (B9, migration 2984, ADR 0148 decision 3): a seat on a project filled later by exactly one member or
 * one person of an agency's roster. Shifts and records are planned against the position before anyone holds it, and
 * filling it resolves them to the holder. Distinct from app.opportunity_positions and from Gateway's agency slots.
 */

export interface PositionHolder {
  readonly membershipId: string | null;
  readonly rosterEntryId: string | null;
  /** Null when the caller may not know them by name. */
  readonly name: string | null;
}

export interface ProjectPosition {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly title: string;
  readonly roleCode: string | null;
  /** The agency's engagement for an agency position; null for a member position. */
  readonly engagementId: string | null;
  readonly agencyName: string | null;
  readonly holder: PositionHolder | null;
  readonly filledAt: string | null;
  /** Live, not canceled shifts held for it. */
  readonly shiftCount: number;
  /** Live records assigned to it. */
  readonly recordCount: number;
}

export interface PositionFilter {
  readonly orgId: string;
  readonly projectId?: string;
}

const POSITION_SELECT =
  "id, project_id, title, role_code, engagement_id, membership_id, roster_entry_id, filled_at, project:projects!project_positions_project_id_fkey(project_key, name)";

interface PositionRow {
  id: string;
  project_id: string;
  title: string;
  role_code: string | null;
  engagement_id: string | null;
  membership_id: string | null;
  roster_entry_id: string | null;
  filled_at: string | null;
  project: { project_key: string; name: string } | null;
}

/** The positions the caller may read with their holders' names, agencies and counts, by project and title. */
export async function listPositions(
  db: XosClient,
  filter: PositionFilter,
): Promise<Result<ProjectPosition[]>> {
  let query = db
    .from("project_positions")
    .select(POSITION_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("title")
    .limit(500);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const rows = data as unknown as PositionRow[];
  if (rows.length === 0) return ok([]);
  const ids = rows.map((r) => r.id);
  const memberships = unique(rows.map((r) => r.membership_id));
  const entries = unique(rows.map((r) => r.roster_entry_id));
  const engagements = unique(rows.map((r) => r.engagement_id));
  const [shifts, records, people, roster, agencies] = await Promise.all([
    db
      .from("shifts")
      .select("project_position_id")
      .in("project_position_id", ids)
      .is("deleted_at", null)
      .neq("shift_state", "Canceled"),
    db
      .from("record_position_assignments")
      .select("project_position_id")
      .in("project_position_id", ids)
      .is("deleted_at", null),
    memberNames(db, memberships),
    entries.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from("roster_entry_people").select("id, full_name").in("id", entries),
    engagements.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("engagement_board")
          .select("engagement_id, account_name")
          .in("engagement_id", engagements),
  ]);
  if (shifts.error) return fail(toDataError(shifts.error));
  if (records.error) return fail(toDataError(records.error));
  if (!people.ok) return people;
  if (roster.error) return fail(toDataError(roster.error));
  if (agencies.error) return fail(toDataError(agencies.error));
  const shiftCounts = countBy(shifts.data.map((r) => r.project_position_id));
  const recordCounts = countBy(records.data.map((r) => r.project_position_id));
  const rosterNames = new Map(
    (roster.data as { id: string | null; full_name: string | null }[]).map((r) => [
      r.id,
      r.full_name,
    ]),
  );
  const agencyNames = new Map(
    (agencies.data as { engagement_id: string | null; account_name: string | null }[]).map((r) => [
      r.engagement_id,
      r.account_name,
    ]),
  );
  return ok(
    rows
      .map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectKey: r.project?.project_key ?? "",
        projectName: r.project?.name ?? "",
        title: r.title,
        roleCode: r.role_code,
        engagementId: r.engagement_id,
        agencyName: r.engagement_id ? (agencyNames.get(r.engagement_id) ?? null) : null,
        holder:
          r.membership_id || r.roster_entry_id
            ? {
                membershipId: r.membership_id,
                rosterEntryId: r.roster_entry_id,
                name: r.membership_id
                  ? (people.data.get(r.membership_id) ?? null)
                  : (rosterNames.get(r.roster_entry_id) ?? null),
              }
            : null,
        filledAt: r.filled_at,
        shiftCount: shiftCounts.get(r.id) ?? 0,
        recordCount: recordCounts.get(r.id) ?? 0,
      }))
      .sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.title.localeCompare(b.title)),
  );
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.flatMap((v) => (v ? [v] : [])))];
}

function countBy(values: readonly (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** Display names of members through app.person_names, which also covers people app.people hides from a plain read. */
async function memberNames(
  db: XosClient,
  membershipIds: readonly string[],
): Promise<Result<Map<string, string | null>>> {
  if (membershipIds.length === 0) return ok(new Map());
  const { data, error } = await db
    .from("memberships")
    .select("id, person_id")
    .in("id", [...membershipIds]);
  if (error) return fail(toDataError(error));
  const { data: names, error: namesError } = await db.rpc("person_names", {
    p_person_ids: data.map((m) => m.person_id),
  });
  if (namesError) return fail(toDataError(namesError));
  const byPerson = new Map((names ?? []).map((n) => [n.person_id, n.full_name]));
  return ok(new Map(data.map((m) => [m.id, byPerson.get(m.person_id) ?? null])));
}

export interface PositionInput {
  readonly projectId: string;
  readonly title: string;
  readonly roleCode: string | null;
  /** An agency's Staff engagement, for an agency position; null for a member position. */
  readonly engagementId: string | null;
}

/** Creates a position, or updates one when `id` is given; the database decides what may change. */
export async function savePosition(
  db: XosClient,
  orgId: string,
  input: PositionInput & { readonly id?: string },
): Promise<Result<{ id: string }>> {
  const row = {
    title: input.title.trim(),
    role_code: input.roleCode,
    engagement_id: input.engagementId,
  };
  if (input.id) {
    const { data, error } = await db
      .from("project_positions")
      .update(row)
      .eq("id", input.id)
      .is("deleted_at", null)
      .select("id");
    if (error) return fail(toDataError(error));
    const updated = landed(data);
    return updated.ok ? ok({ id: input.id }) : updated;
  }
  const { data, error } = await db
    .from("project_positions")
    .insert({ org_id: orgId, project_id: input.projectId, ...row })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Moves a position to Trash; refused while it holds anyone, a not-ended shift or a record (position_in_use). */
export async function retirePosition(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("project_positions")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** What filling a position did: every part is reported, since a warning or a skipped shift never refuses it. */
export interface FillResult {
  readonly shiftsFilled: number;
  readonly shiftsSkipped: readonly { readonly shiftId: string; readonly code: string }[];
  readonly recordsResolved: number;
  readonly policyWarnings: readonly { readonly shiftId: string; readonly code: string }[];
}

function codedShifts(value: unknown): { shiftId: string; code: string }[] {
  return (Array.isArray(value) ? (value as { shift_id?: unknown; code?: unknown }[]) : []).map(
    (r) => ({ shiftId: String(r.shift_id ?? ""), code: String(r.code ?? "") }),
  );
}

/** Fills a position with exactly one member or roster entry (app.fill_position). */
export async function fillPosition(
  db: XosClient,
  id: string,
  holder: { readonly membershipId?: string; readonly rosterEntryId?: string },
): Promise<Result<FillResult>> {
  const { data, error } = await db.rpc("fill_position", {
    p_position_id: id,
    ...(holder.membershipId ? { p_membership_id: holder.membershipId } : {}),
    ...(holder.rosterEntryId ? { p_roster_entry_id: holder.rosterEntryId } : {}),
  });
  if (error) return fail(toDataError(error));
  const result = (data ?? {}) as Record<string, unknown>;
  return ok({
    shiftsFilled: Number(result["shifts_filled"] ?? 0),
    shiftsSkipped: codedShifts(result["shifts_skipped"]),
    recordsResolved: Number(result["records_resolved"] ?? 0),
    policyWarnings: codedShifts(result["policy_warnings"]),
  });
}

/** Vacates a position (app.vacate_position): shifts not yet started return to it, and only the assignments filling made go. */
export async function vacatePosition(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ shiftsReturned: number; recordsUnassigned: number }>> {
  const { data, error } = await db.rpc("vacate_position", { p_position_id: id, p_reason: reason });
  if (error) return fail(toDataError(error));
  const result = (data ?? {}) as Record<string, unknown>;
  return ok({
    shiftsReturned: Number(result["shifts_returned"] ?? 0),
    recordsUnassigned: Number(result["records_unassigned"] ?? 0),
  });
}

/** A position a record is assigned to. */
export interface RecordPosition {
  readonly assignmentId: string;
  readonly positionId: string;
  readonly title: string;
}

/** The positions assigned to a record. */
export async function listRecordPositions(
  db: XosClient,
  recordId: string,
): Promise<Result<RecordPosition[]>> {
  const { data, error } = await db
    .from("record_position_assignments")
    .select(
      "id, project_position_id, position:project_positions!record_position_assignments_project_position_id_fkey(title)",
    )
    .eq("record_id", recordId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        project_position_id: string;
        position: { title: string } | null;
      }[]
    ).map((r) => ({
      assignmentId: r.id,
      positionId: r.project_position_id,
      title: r.position?.title ?? "",
    })),
  );
}

/** Assigns a record to a position; a member holder gets the record assignment at once (2984). */
export async function assignRecordToPosition(
  db: XosClient,
  orgId: string,
  recordId: string,
  positionId: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("record_position_assignments")
    .insert({ org_id: orgId, record_id: recordId, project_position_id: positionId })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Takes a record off a position; the assignment it resolved to goes with it, and only that. */
export async function unassignRecordFromPosition(
  db: XosClient,
  assignmentId: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("record_position_assignments")
    .update({ deleted_at: at.toISOString() })
    .eq("id", assignmentId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}
