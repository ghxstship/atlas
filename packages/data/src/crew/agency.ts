import type { Database, XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";

/**
 * Agency staff on shifts (R12, migrations 2750 to 2754; ADR 0101 R12 amendment). A staffing agency wins one Staff
 * engagement; the production allocates shifts to it as agency slots (the shift names the engagement), and the agency's
 * lead, or a planner with crew.shift.write, places the people on its roster on them (app.assign_roster_shift), once
 * the production accepted their entry, they accepted it, and nothing is due in training. Atlas's shift editor and
 * Gateway's Positions tab share these functions; row level security and the RPCs decide every row.
 */

export type VerificationOutcome = Database["app"]["Enums"]["verification_outcome"];

/** A staffing agency's Staff company engagement on a project: shifts naming it are its agency slots. */
export interface AgencyEngagement {
  readonly engagementId: string;
  readonly accountName: string | null;
  readonly state: Database["app"]["Enums"]["engagement_state"] | null;
}

/** The Staff company engagements on a project that hold no person, so shifts can be allocated to them. */
export async function listAgencyEngagements(
  db: XosClient,
  projectId: string,
): Promise<Result<AgencyEngagement[]>> {
  const { data, error } = await db
    .from("engagement_board")
    .select("engagement_id, account_name, engagement_state")
    .eq("project_id", projectId)
    .eq("role_type", "Staff")
    .is("person_id", null)
    .not("account_id", "is", null)
    .order("account_name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data
      .filter((r): r is typeof r & { engagement_id: string } => r.engagement_id !== null)
      .map((r) => ({
        engagementId: r.engagement_id,
        accountName: r.account_name,
        state: r.engagement_state,
      })),
  );
}

/** Training still due on a roster entry, and how much of it waits only on the production's verification. */
export interface RosterTraining {
  readonly due: number;
  readonly awaitingVerification: number;
}

/** Training counts per roster entry the caller may read (app.roster_training_summary); unreadable entries are left out. */
export async function rosterTrainingSummary(
  db: XosClient,
  rosterEntryIds: readonly string[],
): Promise<Result<Map<string, RosterTraining>>> {
  if (rosterEntryIds.length === 0) return ok(new Map());
  const { data, error } = await db.rpc("roster_training_summary", {
    p_roster_entry_ids: [...new Set(rosterEntryIds)],
  });
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      (data ?? []).map((r) => [
        r.roster_entry_id,
        { due: r.due_count ?? 0, awaitingVerification: r.awaiting_verification ?? 0 },
      ]),
    ),
  );
}

/** A person on an agency's roster who may be placed on its slots, with what stands in the way. */
export interface AssignableRosterEntry {
  readonly rosterEntryId: string;
  readonly engagementId: string;
  readonly personId: string | null;
  readonly name: string | null;
  readonly accountName: string | null;
  readonly roleCode: string | null;
  readonly training: RosterTraining;
  /** True when the person already holds a live roster shift overlapping the window asked about. */
  readonly conflict: boolean;
}

export interface AssignableFilter {
  readonly engagementIds: readonly string[];
  /** The shift being filled: its own id is never a conflict, and only shifts overlapping its times are. */
  readonly window?: {
    readonly shiftId?: string;
    readonly startsAt: string;
    readonly endsAt: string;
  };
}

/**
 * The accepted, non-self roster entries of the given agency engagements, accepted by their people, each with its
 * training counts and, for a window, whether the person already holds an overlapping roster shift. The database
 * refuses each of these again on assignment (roster_training_incomplete, roster_shift_overlap); the list only warns.
 */
export async function listAssignableRosterEntries(
  db: XosClient,
  filter: AssignableFilter,
): Promise<Result<AssignableRosterEntry[]>> {
  if (filter.engagementIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("roster_entry_people")
    .select("id, engagement_id, person_id, full_name, party_name, role_code")
    .in("engagement_id", [...filter.engagementIds])
    .eq("entry_state", "Accepted")
    .eq("person_response", "Accepted")
    .eq("is_self", false)
    .order("full_name", { ascending: true });
  if (error) return fail(toDataError(error));
  const rows = data.filter(
    (r): r is typeof r & { id: string; engagement_id: string } =>
      r.id !== null && r.engagement_id !== null,
  );
  const training = await rosterTrainingSummary(
    db,
    rows.map((r) => r.id),
  );
  if (!training.ok) return training;
  const busy = new Set<string>();
  if (filter.window && rows.length > 0) {
    let query = db
      .from("shifts")
      .select("id, roster_entry_id")
      .in(
        "roster_entry_id",
        rows.map((r) => r.id),
      )
      .is("deleted_at", null)
      .neq("shift_state", "Canceled")
      .lt("starts_at", filter.window.endsAt)
      .gt("ends_at", filter.window.startsAt);
    if (filter.window.shiftId) query = query.neq("id", filter.window.shiftId);
    const shifts = await query;
    if (shifts.error) return fail(toDataError(shifts.error));
    const personOf = new Map(rows.map((r) => [r.id, r.person_id]));
    for (const s of shifts.data) {
      const person = s.roster_entry_id ? personOf.get(s.roster_entry_id) : null;
      if (person) busy.add(person);
    }
  }
  return ok(
    rows.map((r) => ({
      rosterEntryId: r.id,
      engagementId: r.engagement_id,
      personId: r.person_id,
      name: r.full_name,
      accountName: r.party_name,
      roleCode: r.role_code,
      training: training.data.get(r.id) ?? { due: 0, awaitingVerification: 0 },
      conflict: r.person_id !== null && busy.has(r.person_id),
    })),
  );
}

/** Places an agency staff member on a slot of their engagement, or moves a shift between its entries (app.assign_roster_shift). */
export async function assignRosterShift(
  db: XosClient,
  shiftId: string,
  rosterEntryId: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("assign_roster_shift", {
    p_shift_id: shiftId,
    p_roster_entry_id: rosterEntryId,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** A shift as Atlas's editor saves it when the agency's roster is involved (app.save_roster_shift). */
export interface RosterShiftSave {
  /** The shift to edit; absent to create one. */
  readonly shiftId?: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly roleCode: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  /** Exactly one worker: a member, the agency's slot, or a person of its roster on that slot. */
  readonly worker:
    | { readonly kind: "member"; readonly membershipId: string }
    | { readonly kind: "agency"; readonly engagementId: string }
    | { readonly kind: "staff"; readonly engagementId: string; readonly rosterEntryId: string }
    | { readonly kind: "open" };
  /** Why a person comes off the roster, when they do. */
  readonly reason?: string;
}

/**
 * Creates or edits a shift and places, moves or takes off an agency staff member in one transaction, so a refused
 * placement (roster_training_incomplete, roster_entry_not_accepted, roster_shift_overlap) leaves the shift as it was.
 */
export async function saveRosterShift(
  db: XosClient,
  input: RosterShiftSave,
): Promise<Result<{ id: string }>> {
  const w = input.worker;
  const { data, error } = await db.rpc("save_roster_shift", {
    p_shift_id: input.shiftId ?? (null as unknown as string),
    p_org_id: input.orgId,
    p_project_id: input.projectId,
    p_role_code: input.roleCode as string,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_time_zone: input.timeZone,
    p_membership_id: (w.kind === "member" ? w.membershipId : null) as string,
    p_engagement_id: (w.kind === "agency" || w.kind === "staff" ? w.engagementId : null) as string,
    p_roster_entry_id: (w.kind === "staff" ? w.rosterEntryId : null) as string,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Takes an agency staff member off a shift, which becomes the agency's slot again (app.unassign_roster_shift). */
export async function unassignRosterShift(
  db: XosClient,
  shiftId: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("unassign_roster_shift", {
    p_shift_id: shiftId,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** One training acknowledgment on a roster entry, as the production reviews it. */
export interface RosterTrainingRecord {
  readonly id: string;
  readonly requirementId: string;
  readonly requirementName: string | null;
  readonly verificationMethod: Database["app"]["Enums"]["verification_method"] | null;
  readonly acknowledgedAt: string;
  readonly outcome: VerificationOutcome | null;
  readonly verifiedAt: string | null;
}

/** The training an agency staff member acknowledged on their roster entry, newest first. */
export async function listRosterTrainingRecords(
  db: XosClient,
  rosterEntryId: string,
): Promise<Result<RosterTrainingRecord[]>> {
  const { data, error } = await db
    .from("roster_training_records")
    .select(
      "id, onboarding_requirement_id, acknowledged_at, verification_outcome, verified_at, requirement:onboarding_requirements!roster_training_records_onboarding_requirement_id_fkey(name, verification_method)",
    )
    .eq("roster_entry_id", rosterEntryId)
    .is("deleted_at", null)
    .order("acknowledged_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        onboarding_requirement_id: string;
        acknowledged_at: string;
        verification_outcome: VerificationOutcome | null;
        verified_at: string | null;
        requirement: {
          name: string;
          verification_method: Database["app"]["Enums"]["verification_method"];
        } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      requirementId: r.onboarding_requirement_id,
      requirementName: r.requirement?.name ?? null,
      verificationMethod: r.requirement?.verification_method ?? null,
      acknowledgedAt: r.acknowledged_at,
      outcome: r.verification_outcome,
      verifiedAt: r.verified_at,
    })),
  );
}

/** The production records whether an acknowledgment passed (app.verify_roster_training; never by the person). */
export async function verifyRosterTraining(
  db: XosClient,
  recordId: string,
  outcome: VerificationOutcome,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("verify_roster_training", {
    p_record_id: recordId,
    p_outcome: outcome,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}
