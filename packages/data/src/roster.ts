import { bulkUpdate, sameValueRows, type BulkOutcome } from "./bulk.ts";
import type { Database, XosClient } from "./client.ts";
import { Constants, type Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import {
  parseSharedWorkDetails,
  type SharedWorkDetails,
  type WorkDetailCategory,
} from "./work-details.ts";

/**
 * The crew roster (R4, migrations 2630 to 2642, ADR 0101), imported as `@xos/data/roster`. A party
 * puts its people on an engagement (roster entries with a role and an arrival window), the producing
 * org reviews each entry, and each person accepts their own entry before anything about them flows.
 * An account's Owner and Admin confirm members, invite addresses and assign members to engagements
 * (an Account Member reaches only the engagements assigned to them, owner decision 6).
 *
 * Gateway reads through the api_external views (Section 8.7); Atlas reads app.roster_entry_people.
 * Every write is an RPC; refusals come back as typed errors with the rule the database named.
 */

type Enums = Database["app"]["Enums"];
export type RosterEntryState = Enums["roster_entry_state"];
export type RosterPersonResponse = Enums["roster_person_response"];
export type AccountEngagementDuty = Enums["account_engagement_duty"];
export type AccountRole = Enums["account_role"];
export type ExternalRoleType = Enums["external_role_type"];

export const ROSTER_ENTRY_STATES: readonly RosterEntryState[] =
  Constants.app.Enums.roster_entry_state;
export const ROSTER_PERSON_RESPONSES: readonly RosterPersonResponse[] =
  Constants.app.Enums.roster_person_response;
export const ACCOUNT_ENGAGEMENT_DUTIES: readonly AccountEngagementDuty[] =
  Constants.app.Enums.account_engagement_duty;

/** One roster entry with its person, as a roster manager, the person or the producing org reads it. */
export interface RosterEntry {
  readonly id: string;
  readonly projectId: string | null;
  readonly engagementId: string;
  readonly partyName: string | null;
  readonly roleType: ExternalRoleType | null;
  readonly isSelf: boolean;
  /** Null for an invitation nobody has claimed. */
  readonly personId: string | null;
  readonly fullName: string | null;
  /** The pending invitation's address; only roster managers see it. */
  readonly invitedEmail: string | null;
  readonly invitationExpiresAt: string | null;
  readonly roleCode: string | null;
  readonly jobTitle: string | null;
  readonly arrivalStartsAt: string | null;
  readonly arrivalEndsAt: string | null;
  readonly arrivalTimeZone: string | null;
  readonly entryState: RosterEntryState;
  readonly personResponse: RosterPersonResponse;
  readonly respondedAt: string | null;
  /** What the reviewer asked to change, while Returned. */
  readonly returnReason: string | null;
  readonly replacesEntryId: string | null;
  /** Categories the person shares on this entry; empty when none. */
  readonly shareCategories: readonly WorkDetailCategory[];
}

const ENTRY_COLUMNS =
  "id, project_id, engagement_id, party_name, role_type, is_self, person_id, full_name, invited_email, invitation_expires_at, role_code, job_title, arrival_starts_at, arrival_ends_at, arrival_time_zone, entry_state, person_response, responded_at, return_reason, replaces_entry_id, share_categories";

type EntryRow = {
  id: string | null;
  project_id: string | null;
  engagement_id: string | null;
  party_name: string | null;
  role_type: ExternalRoleType | null;
  is_self: boolean | null;
  person_id: string | null;
  full_name: string | null;
  invited_email: string | null;
  invitation_expires_at: string | null;
  role_code: string | null;
  job_title: string | null;
  arrival_starts_at: string | null;
  arrival_ends_at: string | null;
  arrival_time_zone: string | null;
  entry_state: RosterEntryState | null;
  person_response: RosterPersonResponse | null;
  responded_at: string | null;
  return_reason: string | null;
  replaces_entry_id: string | null;
  share_categories: WorkDetailCategory[] | null;
};

/** A view row in camel case; a row without its keys (never in practice) is dropped. */
export function toRosterEntry(r: EntryRow): RosterEntry | null {
  if (r.id === null || r.engagement_id === null || r.entry_state === null) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    engagementId: r.engagement_id,
    partyName: r.party_name,
    roleType: r.role_type,
    isSelf: r.is_self === true,
    personId: r.person_id,
    fullName: r.full_name,
    invitedEmail: r.invited_email,
    invitationExpiresAt: r.invitation_expires_at,
    roleCode: r.role_code,
    jobTitle: r.job_title,
    arrivalStartsAt: r.arrival_starts_at,
    arrivalEndsAt: r.arrival_ends_at,
    arrivalTimeZone: r.arrival_time_zone,
    entryState: r.entry_state,
    personResponse: r.person_response ?? "Pending",
    respondedAt: r.responded_at,
    returnReason: r.return_reason,
    replacesEntryId: r.replaces_entry_id,
    shareCategories: r.share_categories ?? [],
  };
}

const entries = (rows: readonly EntryRow[] | null): RosterEntry[] =>
  (rows ?? []).flatMap((r) => {
    const e = toRosterEntry(r);
    return e ? [e] : [];
  });

/** The roster of one engagement, as the caller reaches it: every entry for a manager, their own otherwise. */
export async function listEngagementRoster(
  db: XosClient,
  engagementId: string,
): Promise<Result<RosterEntry[]>> {
  const { data, error } = await db
    .schema("api_external")
    .from("engagement_roster")
    .select(ENTRY_COLUMNS)
    .eq("engagement_id", engagementId)
    .order("is_self", { ascending: false })
    .order("full_name", { ascending: true, nullsFirst: false });
  if (error) return fail(toDataError(error));
  return ok(entries(data as EntryRow[] | null));
}

/** The producing org's read of a project's roster (app.roster_entry_people, advancing.packet.read). */
export async function listProjectRoster(
  db: XosClient,
  scope: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<RosterEntry[]>> {
  let query = db.from("roster_entry_people").select(ENTRY_COLUMNS).eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  const { data, error } = await query
    .order("party_name", { ascending: true })
    .order("full_name", { ascending: true, nullsFirst: false });
  if (error) return fail(toDataError(error));
  return ok(entries(data as EntryRow[] | null));
}

/** One of the caller's own roster entries, for Gateway Home and Compass. */
export interface MyRosterEntry {
  readonly id: string;
  readonly engagementId: string;
  readonly projectId: string | null;
  readonly orgName: string | null;
  readonly projectName: string | null;
  readonly partyName: string | null;
  readonly roleType: ExternalRoleType | null;
  readonly jobTitle: string | null;
  readonly arrivalStartsAt: string | null;
  readonly arrivalEndsAt: string | null;
  readonly arrivalTimeZone: string | null;
  readonly entryState: RosterEntryState;
  readonly personResponse: RosterPersonResponse;
  readonly isSelf: boolean;
  readonly shareCategories: readonly WorkDetailCategory[];
}

export async function listMyRosterEntries(db: XosClient): Promise<Result<MyRosterEntry[]>> {
  const { data, error } = await db
    .schema("api_external")
    .from("my_roster_entries")
    .select(
      "id, engagement_id, project_id, org_name, project_name, party_name, role_type, job_title, arrival_starts_at, arrival_ends_at, arrival_time_zone, entry_state, person_response, is_self, share_categories",
    )
    .order("arrival_starts_at", { ascending: true, nullsFirst: false });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      r.id === null || r.engagement_id === null || r.entry_state === null
        ? []
        : [
            {
              id: r.id,
              engagementId: r.engagement_id,
              projectId: r.project_id,
              orgName: r.org_name,
              projectName: r.project_name,
              partyName: r.party_name,
              roleType: r.role_type,
              jobTitle: r.job_title,
              arrivalStartsAt: r.arrival_starts_at,
              arrivalEndsAt: r.arrival_ends_at,
              arrivalTimeZone: r.arrival_time_zone,
              entryState: r.entry_state,
              personResponse: r.person_response ?? "Pending",
              isSelf: r.is_self === true,
              shareCategories: r.share_categories ?? [],
            },
          ],
    ),
  );
}

/** Entries waiting for the person's own answer: not their self entry, not withdrawn. */
export function pendingRosterAnswers(rows: readonly MyRosterEntry[]): MyRosterEntry[] {
  return rows.filter(
    (r) => !r.isSelf && r.personResponse === "Pending" && r.entryState !== "Withdrawn",
  );
}

/** Someone the caller may roster (ADR 0101 decision 6). */
export interface TalentMember {
  readonly accountId: string;
  readonly personId: string;
  readonly fullName: string;
  readonly source: "Account Member" | "Represented Artist";
}

export async function listAccountTalent(
  db: XosClient,
  accountId?: string | null,
): Promise<Result<TalentMember[]>> {
  let query = db
    .schema("api_external")
    .from("my_account_talent")
    .select("account_id, person_id, full_name, source");
  if (accountId) query = query.eq("account_id", accountId);
  const { data, error } = await query.order("full_name", { ascending: true });
  if (error) return fail(toDataError(error));
  const seen = new Set<string>();
  return ok(
    (data ?? []).flatMap((r) => {
      if (r.account_id === null || r.person_id === null || seen.has(r.person_id)) return [];
      seen.add(r.person_id);
      return [
        {
          accountId: r.account_id,
          personId: r.person_id,
          fullName: r.full_name ?? "",
          source: r.source === "Represented Artist" ? "Represented Artist" : "Account Member",
        },
      ];
    }),
  );
}

// Building the roster ------------------------------------------------------------------------------

/** Role and arrival of an entry; the window and zone come together or not at all. */
export interface RosterEntryFields {
  readonly roleCode: string | null;
  readonly arrivalStartsAt: string | null;
  readonly arrivalEndsAt: string | null;
  readonly arrivalTimeZone: string | null;
}

export async function addRosterEntry(
  db: XosClient,
  input: RosterEntryFields & {
    readonly engagementId: string;
    readonly personId: string;
    readonly replacesEntryId?: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("add_roster_entry", {
    p_engagement_id: input.engagementId,
    p_person_id: input.personId,
    ...(input.roleCode ? { p_role_code: input.roleCode } : {}),
    ...(input.arrivalStartsAt ? { p_arrival_starts_at: input.arrivalStartsAt } : {}),
    ...(input.arrivalEndsAt ? { p_arrival_ends_at: input.arrivalEndsAt } : {}),
    ...(input.arrivalTimeZone ? { p_arrival_time_zone: input.arrivalTimeZone } : {}),
    ...(input.replacesEntryId ? { p_replaces_entry_id: input.replacesEntryId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function inviteToRoster(
  db: XosClient,
  input: RosterEntryFields & { readonly engagementId: string; readonly email: string },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("invite_to_roster", {
    p_engagement_id: input.engagementId,
    p_email: input.email,
    ...(input.roleCode ? { p_role_code: input.roleCode } : {}),
    ...(input.arrivalStartsAt ? { p_arrival_starts_at: input.arrivalStartsAt } : {}),
    ...(input.arrivalEndsAt ? { p_arrival_ends_at: input.arrivalEndsAt } : {}),
    ...(input.arrivalTimeZone ? { p_arrival_time_zone: input.arrivalTimeZone } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function updateRosterEntry(
  db: XosClient,
  rosterEntryId: string,
  fields: RosterEntryFields,
): Promise<Result<null>> {
  const { error } = await db.rpc("update_roster_entry", {
    p_roster_entry_id: rosterEntryId,
    // The RPC takes every field, so a cleared field is sent as null.
    p_role_code: fields.roleCode as string,
    p_arrival_starts_at: fields.arrivalStartsAt as string,
    p_arrival_ends_at: fields.arrivalEndsAt as string,
    p_arrival_time_zone: fields.arrivalTimeZone as string,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/**
 * The producing org sets or clears an engagement's names lock (R5, G-142): after `locksAt` the company side can no
 * longer add, invite, edit Draft entries or submit new names. Null clears it; a past instant locks at once.
 */
export async function setRosterLock(
  db: XosClient,
  engagementId: string,
  locksAt: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_roster_lock", {
    p_engagement_id: engagementId,
    // The RPC takes null to clear the lock.
    p_locks_at: locksAt as string,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** An engagement's names lock as the producing org reads it, with the project's zone the lock is set in. */
export interface RosterLock {
  readonly locksAt: string | null;
  readonly timeZone: string;
}

/** The names lock of each engagement the producing org reads, by engagement id. */
export async function listRosterLocks(
  db: XosClient,
  engagementIds: readonly string[],
): Promise<Result<Record<string, RosterLock>>> {
  if (engagementIds.length === 0) return ok({});
  const { data, error } = await db
    .from("engagements")
    .select("id, roster_locks_at, projects(time_zone)")
    .in("id", [...engagementIds]);
  if (error) return fail(toDataError(error));
  return ok(
    Object.fromEntries(
      (data ?? []).map((e) => [
        e.id,
        { locksAt: e.roster_locks_at, timeZone: e.projects?.time_zone ?? "UTC" },
      ]),
    ),
  );
}

/** True once a names lock has passed. */
export function rosterLocked(locksAt: string | null, now: Date = new Date()): boolean {
  return locksAt !== null && new Date(locksAt).getTime() <= now.getTime();
}

/** Submits every Draft and Returned entry for review; returns how many. Under a names lock only Returned entries. */
export async function submitRoster(db: XosClient, engagementId: string): Promise<Result<number>> {
  const { data, error } = await db.rpc("submit_roster", { p_engagement_id: engagementId });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function withdrawRosterEntry(
  db: XosClient,
  rosterEntryId: string,
  reason: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("withdraw_roster_entry", {
    p_roster_entry_id: rosterEntryId,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function reissueRosterInvitation(
  db: XosClient,
  rosterEntryId: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("reissue_roster_invitation", {
    p_roster_entry_id: rosterEntryId,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** The person's own answer to an entry. */
export async function respondRosterEntry(
  db: XosClient,
  rosterEntryId: string,
  response: Exclude<RosterPersonResponse, "Pending">,
): Promise<Result<null>> {
  const { error } = await db.rpc("respond_roster_entry", {
    p_roster_entry_id: rosterEntryId,
    p_response: response,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** The person's work details as an org or company reader may read them; each call is logged. */
export async function rosterSharedWorkDetails(
  db: XosClient,
  rosterEntryId: string,
): Promise<Result<SharedWorkDetails>> {
  const { data, error } = await db.rpc("roster_shared_work_details", {
    p_roster_entry_id: rosterEntryId,
  });
  if (error) return fail(toDataError(error));
  return ok(parseSharedWorkDetails(data));
}

// Review (the producing org) -----------------------------------------------------------------------

export async function reviewRosterEntry(
  db: XosClient,
  rosterEntryId: string,
  outcome: "Accepted" | "Returned",
  reason?: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("review_roster_entry", {
    p_roster_entry_id: rosterEntryId,
    p_outcome: outcome,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** Accepts or returns several entries in one all-or-nothing call; a return carries one reason. */
export async function bulkReviewRosterEntries(
  db: XosClient,
  ids: readonly string[],
  outcome: "Accepted" | "Returned",
  options: { readonly reason?: string | null; readonly preview?: boolean } = {},
): Promise<Result<BulkOutcome>> {
  return bulkUpdate(db, "engagement_roster_entries", sameValueRows(ids, { entry_state: outcome }), {
    preview: options.preview ?? false,
    reason: options.reason ?? null,
  });
}

// Account team -------------------------------------------------------------------------------------

export interface EngagementAssignment {
  readonly id: string;
  readonly engagementId: string;
  readonly accountMembershipId: string;
  readonly personId: string;
  readonly fullName: string;
  readonly duty: AccountEngagementDuty;
}

export async function listEngagementAssignments(
  db: XosClient,
  engagementId: string,
): Promise<Result<EngagementAssignment[]>> {
  const { data, error } = await db
    .schema("api_external")
    .from("account_engagement_assignments")
    .select("id, engagement_id, account_membership_id, person_id, full_name, duty")
    .eq("engagement_id", engagementId)
    .order("full_name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      r.id === null ||
      r.engagement_id === null ||
      r.account_membership_id === null ||
      r.person_id === null ||
      r.duty === null
        ? []
        : [
            {
              id: r.id,
              engagementId: r.engagement_id,
              accountMembershipId: r.account_membership_id,
              personId: r.person_id,
              fullName: r.full_name ?? "",
              duty: r.duty,
            },
          ],
    ),
  );
}

export async function assignEngagementMember(
  db: XosClient,
  engagementId: string,
  accountMembershipId: string,
  duty: AccountEngagementDuty,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("assign_engagement_member", {
    p_engagement_id: engagementId,
    p_account_membership_id: accountMembershipId,
    p_duty: duty,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function unassignEngagementMember(
  db: XosClient,
  assignmentId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("unassign_engagement_member", { p_assignment_id: assignmentId });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Account invitations and acceptance -----------------------------------------------------------------

export interface AccountInvitation {
  readonly id: string;
  readonly accountId: string;
  readonly email: string;
  readonly accountRole: AccountRole;
  readonly invitedByName: string | null;
  readonly expiresAt: string;
}

export async function inviteAccountMember(
  db: XosClient,
  accountId: string,
  email: string,
  role: AccountRole,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("invite_account_member", {
    p_account_id: accountId,
    p_email: email,
    p_role: role,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function revokeAccountInvitation(
  db: XosClient,
  invitationId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_account_invitation", {
    p_account_invitation_id: invitationId,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function listAccountInvitations(
  db: XosClient,
  accountId: string,
): Promise<Result<AccountInvitation[]>> {
  const { data, error } = await db
    .schema("api_external")
    .from("account_invitations")
    .select("id, account_id, email, account_role, invited_by_name, expires_at")
    .eq("account_id", accountId)
    .order("expires_at", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      r.id === null ||
      r.account_id === null ||
      r.email === null ||
      r.account_role === null ||
      r.expires_at === null
        ? []
        : [
            {
              id: r.id,
              accountId: r.account_id,
              email: r.email,
              accountRole: r.account_role,
              invitedByName: r.invited_by_name,
              expiresAt: r.expires_at,
            },
          ],
    ),
  );
}

/** An invitation waiting for the caller, matched by their confirmed email. */
export interface PendingInvitation {
  readonly kind: "account" | "roster";
  readonly id: string;
  readonly accountName: string | null;
  readonly orgName: string | null;
  readonly projectName: string | null;
  readonly partyName: string | null;
  readonly jobTitle: string | null;
  readonly accountRole: AccountRole | null;
  readonly inviterName: string | null;
  readonly expiresAt: string;
}

export async function myPendingInvitations(db: XosClient): Promise<Result<PendingInvitation[]>> {
  const { data, error } = await db.rpc("my_pending_invitations");
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as Database["app"]["Functions"]["my_pending_invitations"]["Returns"]).flatMap(
      (r) =>
        (r.invitation_kind !== "account" && r.invitation_kind !== "roster") || !r.invitation_id
          ? []
          : [
              {
                kind: r.invitation_kind,
                id: r.invitation_id,
                accountName: r.account_name,
                orgName: r.org_name,
                projectName: r.project_name,
                partyName: r.party_name,
                jobTitle: r.job_title,
                accountRole: r.account_role,
                inviterName: r.inviter_name,
                expiresAt: r.expires_at,
              },
            ],
    ),
  );
}

/** Accepts or declines an invitation; returns the membership (account) or entry (roster) id, null on a decline. */
export async function respondPartyInvitation(
  db: XosClient,
  kind: "account" | "roster",
  invitationId: string,
  accept: boolean,
): Promise<Result<string | null>> {
  const { data, error } = await db.rpc("respond_party_invitation", {
    p_invitation_kind: kind,
    p_invitation_id: invitationId,
    p_accept: accept,
  });
  if (error) return fail(toDataError(error));
  return ok((data as Json as string | null) ?? null);
}

export async function acceptAccountMembership(
  db: XosClient,
  accountMembershipId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("accept_account_membership", {
    p_account_membership_id: accountMembershipId,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** The caller's own memberships they have not confirmed, for Gateway Home. */
export interface UnconfirmedMembership {
  readonly accountMembershipId: string;
  readonly accountId: string;
  readonly accountName: string;
}

export async function listMyUnconfirmedMemberships(
  db: XosClient,
  personId: string,
): Promise<Result<UnconfirmedMembership[]>> {
  const { data, error } = await db
    .schema("api_external")
    .from("account_members")
    .select("account_membership_id, account_id, accepted_at")
    .eq("person_id", personId)
    .is("accepted_at", null);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []).flatMap((r) =>
    r.account_membership_id === null || r.account_id === null
      ? []
      : [{ id: r.account_membership_id, accountId: r.account_id }],
  );
  if (rows.length === 0) return ok([]);
  const accounts = await db
    .schema("api_external")
    .from("my_accounts")
    .select("account_id, name")
    .in(
      "account_id",
      rows.map((r) => r.accountId),
    );
  if (accounts.error) return fail(toDataError(accounts.error));
  const names = new Map((accounts.data ?? []).map((a) => [a.account_id, a.name ?? ""]));
  return ok(
    rows.map((r) => ({
      accountMembershipId: r.id,
      accountId: r.accountId,
      accountName: names.get(r.accountId) ?? "",
    })),
  );
}

/** A role from the Roles Library, for the roster's role picker. */
export interface RoleOption {
  readonly roleCode: string;
  readonly jobTitle: string;
}

/**
 * Roles to pick from on a roster entry, read on the server: the roles of the engagement role's
 * department class when it has one (a vendor's audio crew picks among audio roles), else the first
 * 300 by job title.
 */
export async function listRoleOptions(
  db: XosClient,
  engagementRoleCode: string | null,
): Promise<Result<RoleOption[]>> {
  let query = db.schema("xpms").from("role").select("role_code, job_title");
  if (engagementRoleCode) query = query.eq("class_code", engagementRoleCode.slice(0, 4));
  const { data, error } = await query.order("job_title", { ascending: true }).limit(300);
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as { role_code: string; job_title: string }[]).map((r) => ({
      roleCode: r.role_code,
      jobTitle: r.job_title,
    })),
  );
}
