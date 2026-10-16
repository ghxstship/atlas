import type { Database, XosClient } from "./client.ts";
import {
  byCode,
  landed,
  MEMBERSHIP_EMBED,
  toMemberRef,
  toTransitions,
  type MemberRef,
  type TransitionEntry,
} from "./crew/shared.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * People repository (Section 4.2 People, migration 0361), imported as `@xos/data/people`: the
 * directory, canon workforce roles with their staffing ratios, role assignments, staffing
 * requisitions approved under spend authority, agreements signed by token or while signed in (a
 * signed agreement is never revoked, journey 9), offers (owned by A28, read here) and certifications.
 */

type Enums = Database["app"]["Enums"];
export type RequisitionState = Enums["requisition_state"];
export type RoleAssignmentState = Enums["role_assignment_state"];
export type StaffingBasis = Enums["staffing_basis"];
export type AgreementKind = Enums["agreement_kind"];
export type AgreementState = Enums["agreement_state"];
export type OfferState = Enums["offer_state"];

export const REQUISITION_STATES: readonly RequisitionState[] = [
  "Proposed",
  "Approved",
  "Rejected",
  "Filled",
  "Canceled",
];
export const ROLE_ASSIGNMENT_STATES: readonly RoleAssignmentState[] = [
  "Proposed",
  "Active",
  "Complete",
  "Canceled",
];
export const AGREEMENT_STATES: readonly AgreementState[] = [
  "Proposed",
  "Sent",
  "Signed",
  "Superseded",
  "Expired",
  "Canceled",
];
export const AGREEMENT_KINDS: readonly AgreementKind[] = [
  "Offer Letter",
  "Contractor Agreement",
  "Master Services Agreement",
  "Non-Disclosure Agreement",
];
export const OFFER_STATES: readonly OfferState[] = [
  "Sent",
  "Countered",
  "Accepted",
  "Declined",
  "Withdrawn",
  "Expired",
];

// Canon workforce roles -------------------------------------------------------------------------------

/** A canon workforce role (xpms.dim_role, the 61 roles) with its staffing ratio, read from canon. */
export interface WorkforceRole {
  readonly code: string;
  readonly role: string;
  readonly jobTitle: string | null;
  readonly departmentCode: string;
  /** Guests per person; null when the role is not staffed by ratio. */
  readonly staffingRatio: number | null;
  readonly ratioBasis: string | null;
  readonly kitBasis: string | null;
}

export async function listWorkforceRoles(db: XosClient): Promise<Result<WorkforceRole[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_role")
    .select("role_code, role, job_title, dept_code, staffing_ratio, ratio_basis, kit_basis");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((r) => ({
        code: r.role_code,
        role: r.role,
        jobTitle: r.job_title,
        departmentCode: r.dept_code,
        staffingRatio: r.staffing_ratio === null ? null : Number(r.staffing_ratio),
        ratioBasis: r.ratio_basis,
        kitBasis: r.kit_basis,
      }))
      .sort((a, b) => byCode(a.code, b.code)),
  );
}

/**
 * Headcount a ratio role needs for an occupancy: one person per `ratio` guests, rounded up. Null when
 * the role has no ratio or the occupancy is not a positive number (no answer, never a guess).
 */
export function staffingHeadcount(ratio: number | null, occupancy: number): number | null {
  if (ratio === null || ratio <= 0 || !Number.isFinite(occupancy) || occupancy <= 0) return null;
  return Math.ceil(occupancy / ratio);
}

// Directory -------------------------------------------------------------------------------------------------

export interface DirectoryEntry extends MemberRef {
  readonly validFrom: string;
  /** System role codes held, best band first. */
  readonly roles: readonly { code: string; name: string | null; band: number }[];
  readonly assignments: number;
  readonly certifications: number;
}

/** Active members of the org with their roles and counts of role assignments and certifications. */
export async function listDirectory(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<DirectoryEntry[]>> {
  const at = now.toISOString();
  const { data, error } = await db
    .from("memberships")
    .select(
      `${MEMBERSHIP_EMBED}, valid_from, membership_roles(deleted_at, role:roles(code, name, band))`,
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .lte("valid_from", at)
    .or(`valid_to.is.null,valid_to.gt.${at}`);
  if (error) return fail(toDataError(error));
  const rows = data as unknown as Array<{
    id: string;
    person_id: string;
    person: { full_name: string | null } | null;
    valid_from: string;
    membership_roles: Array<{
      deleted_at: string | null;
      role: { code: string; name: string | null; band: number } | null;
    }> | null;
  }>;
  const people = rows.map((r) => r.person_id);
  const [assignments, holders] = await Promise.all([
    people.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("role_assignments")
          .select("person_id")
          .in("person_id", people)
          .is("deleted_at", null)
          .in("assignment_state", ["Proposed", "Active"]),
    people.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("certification_holders")
          .select("person_id")
          .in("person_id", people)
          .is("deleted_at", null),
  ]);
  if (assignments.error) return fail(toDataError(assignments.error));
  if (holders.error) return fail(toDataError(holders.error));
  const count = (list: readonly { person_id: string }[] | null, person: string) =>
    (list ?? []).filter((x) => x.person_id === person).length;
  return ok(
    rows
      .map((r) => ({
        ...toMemberRef(r, r.id),
        validFrom: r.valid_from,
        roles: (r.membership_roles ?? [])
          .flatMap((m) => (m.deleted_at === null && m.role ? [m.role] : []))
          .sort((a, b) => a.band - b.band),
        assignments: count(assignments.data, r.person_id),
        certifications: count(holders.data, r.person_id),
      }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  );
}

/**
 * Members counted against seats (bands above Field, Owner to Collaborator) and Field members, metered
 * separately (Section 16). Viewers count toward neither.
 */
export function seatSplit(entries: readonly DirectoryEntry[]): { seats: number; field: number } {
  let seats = 0;
  let field = 0;
  for (const e of entries) {
    const best = e.roles[0]?.band;
    if (best === undefined) continue;
    if (best < 6) seats += 1;
    else if (best === 6) field += 1;
  }
  return { seats, field };
}

// Role assignments --------------------------------------------------------------------------------------------

export interface RoleAssignment {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly roleCode: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly requisitionId: string | null;
  readonly staffingBasis: StaffingBasis;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly state: RoleAssignmentState;
}

const ASSIGNMENT_SELECT =
  "id, project_id, role_code, person_id, requisition_id, staffing_basis, starts_on, ends_on, assignment_state, project:projects!role_assignments_project_id_fkey(project_key), person:people!role_assignments_person_id_fkey(full_name)";

interface AssignmentRow {
  id: string;
  project_id: string;
  role_code: string;
  person_id: string;
  requisition_id: string | null;
  staffing_basis: StaffingBasis;
  starts_on: string | null;
  ends_on: string | null;
  assignment_state: RoleAssignmentState;
  project: { project_key: string } | null;
  person: { full_name: string | null } | null;
}

function toAssignment(r: AssignmentRow): RoleAssignment {
  return {
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project?.project_key ?? "",
    roleCode: r.role_code,
    personId: r.person_id,
    personName: r.person?.full_name ?? null,
    requisitionId: r.requisition_id,
    staffingBasis: r.staffing_basis,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    state: r.assignment_state,
  };
}

export async function listRoleAssignments(
  db: XosClient,
  filter: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly personId?: string;
    readonly roleCode?: string;
  },
): Promise<Result<RoleAssignment[]>> {
  let query = db
    .from("role_assignments")
    .select(ASSIGNMENT_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.personId) query = query.eq("person_id", filter.personId);
  if (filter.roleCode) query = query.eq("role_code", filter.roleCode);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as AssignmentRow[])
      .map(toAssignment)
      .sort(
        (a, b) =>
          byCode(a.roleCode, b.roleCode) || (a.personName ?? "").localeCompare(b.personName ?? ""),
      ),
  );
}

export interface RoleAssignmentDetail extends RoleAssignment {
  readonly transitions: readonly TransitionEntry[];
}

export async function getRoleAssignment(
  db: XosClient,
  id: string,
): Promise<Result<RoleAssignmentDetail>> {
  const { data, error } = await db
    .from("role_assignments")
    .select(ASSIGNMENT_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const ledger = await db
    .from("role_assignment_state_transitions")
    .select("id, from_state, to_state, reason, created_at, created_by")
    .eq("role_assignment_id", id);
  if (ledger.error) return fail(toDataError(ledger.error));
  return ok({
    ...toAssignment(data as unknown as AssignmentRow),
    transitions: toTransitions(ledger.data),
  });
}

export async function createRoleAssignment(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly roleCode: string;
    readonly personId: string;
    readonly staffingBasis: StaffingBasis;
    readonly requisitionId?: string | null;
    readonly startsOn?: string | null;
    readonly endsOn?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("role_assignments")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      role_code: input.roleCode,
      person_id: input.personId,
      staffing_basis: input.staffingBasis,
      requisition_id: input.requisitionId ?? null,
      starts_on: input.startsOn ?? null,
      ends_on: input.endsOn ?? null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function transitionRoleAssignment(
  db: XosClient,
  id: string,
  expected: RoleAssignmentState,
  next: RoleAssignmentState,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("transition_role_assignment", {
    p_role_assignment_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

// Requisitions ----------------------------------------------------------------------------------------------------

export interface Requisition {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly roleCode: string;
  readonly roleType: Enums["external_role_type"] | null;
  readonly workerClassification: string | null;
  readonly payBasis: string | null;
  readonly arrangement: string | null;
  readonly headcount: number;
  readonly unitsPerHead: number | null;
  readonly rateMinor: number | null;
  readonly currencyCode: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly justification: string;
  readonly requestedBy: string | null;
  readonly state: RequisitionState;
  /** Headcount times units times rate; null while unpriced (never zero). */
  readonly estimatedMinor: number | null;
  readonly createdAt: string;
}

const REQUISITION_SELECT =
  "id, project_id, role_code, role_type, worker_classification, pay_basis, arrangement, headcount, units_per_head, rate_minor, currency_code, starts_on, ends_on, justification, requested_by, requisition_state, created_at, project:projects!requisitions_project_id_fkey(project_key)";

interface RequisitionRow {
  id: string;
  project_id: string;
  role_code: string;
  role_type: Enums["external_role_type"] | null;
  worker_classification: string | null;
  pay_basis: string | null;
  arrangement: string | null;
  headcount: number;
  units_per_head: number | null;
  rate_minor: number | null;
  currency_code: string;
  starts_on: string | null;
  ends_on: string | null;
  justification: string;
  requested_by: string | null;
  requisition_state: RequisitionState;
  created_at: string;
  project: { project_key: string } | null;
}

/** Estimated spend of a requisition, as app.requisition_amounts derives it. */
export function requisitionEstimate(
  headcount: number,
  unitsPerHead: number | null,
  rateMinor: number | null,
): number | null {
  if (unitsPerHead === null || rateMinor === null) return null;
  return Math.round(headcount * unitsPerHead * rateMinor);
}

function toRequisition(r: RequisitionRow): Requisition {
  const units = r.units_per_head === null ? null : Number(r.units_per_head);
  return {
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project?.project_key ?? "",
    roleCode: r.role_code,
    roleType: r.role_type,
    workerClassification: r.worker_classification,
    payBasis: r.pay_basis,
    arrangement: r.arrangement,
    headcount: r.headcount,
    unitsPerHead: units,
    rateMinor: r.rate_minor,
    currencyCode: r.currency_code,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    justification: r.justification,
    requestedBy: r.requested_by,
    state: r.requisition_state,
    estimatedMinor: requisitionEstimate(r.headcount, units, r.rate_minor),
    createdAt: r.created_at,
  };
}

export async function listPeopleRequisitions(
  db: XosClient,
  filter: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly states?: readonly RequisitionState[];
  },
): Promise<Result<Requisition[]>> {
  let query = db
    .from("requisitions")
    .select(REQUISITION_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.states && filter.states.length > 0) {
    query = query.in("requisition_state", [...filter.states]);
  }
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RequisitionRow[]).map(toRequisition));
}

export interface RequisitionDetail extends Requisition {
  readonly transitions: readonly TransitionEntry[];
  readonly assignments: readonly RoleAssignment[];
}

export async function getRequisition(
  db: XosClient,
  id: string,
): Promise<Result<RequisitionDetail>> {
  const { data, error } = await db
    .from("requisitions")
    .select(REQUISITION_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const [ledger, assignments] = await Promise.all([
    db
      .from("requisition_state_transitions")
      .select("id, from_state, to_state, reason, created_at, created_by")
      .eq("requisition_id", id),
    db
      .from("role_assignments")
      .select(ASSIGNMENT_SELECT)
      .eq("requisition_id", id)
      .is("deleted_at", null),
  ]);
  if (ledger.error) return fail(toDataError(ledger.error));
  if (assignments.error) return fail(toDataError(assignments.error));
  return ok({
    ...toRequisition(data as unknown as RequisitionRow),
    transitions: toTransitions(ledger.data),
    assignments: (assignments.data as unknown as AssignmentRow[]).map(toAssignment),
  });
}

export interface RequisitionInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly roleCode: string;
  readonly roleType: Enums["external_role_type"] | null;
  readonly workerClassification: string | null;
  readonly payBasis: string | null;
  readonly arrangement: string | null;
  readonly headcount: number;
  readonly unitsPerHead: number | null;
  readonly rateMinor: number | null;
  readonly currencyCode: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly justification: string;
}

function requisitionColumns(input: Omit<RequisitionInput, "orgId" | "projectId">) {
  return {
    role_code: input.roleCode,
    role_type: input.roleType,
    worker_classification: input.workerClassification,
    pay_basis: input.payBasis,
    arrangement: input.arrangement,
    headcount: input.headcount,
    units_per_head: input.unitsPerHead,
    rate_minor: input.rateMinor,
    currency_code: input.currencyCode,
    starts_on: input.startsOn,
    ends_on: input.endsOn,
    justification: input.justification.trim(),
  };
}

/** Requests staff for a canon role; the requester comes from the session and never approves it. */
export async function createRequisition(
  db: XosClient,
  input: RequisitionInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("requisitions")
    .insert({ org_id: input.orgId, project_id: input.projectId, ...requisitionColumns(input) })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Edits a requisition's terms while it is Proposed (locked afterwards by the database). */
export async function updateRequisition(
  db: XosClient,
  id: string,
  input: Omit<RequisitionInput, "orgId" | "projectId">,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("requisitions")
    .update(requisitionColumns(input))
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Approves under spend authority; `complete` is false while a second approver is needed. */
export async function approveRequisition(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ complete: boolean }>> {
  const { data, error } = await db.rpc("approve_requisition", {
    p_requisition_id: id,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ complete: data });
}

export async function rejectRequisition(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("reject_requisition", {
    p_requisition_id: id,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** Resubmits, fills or cancels a requisition with compare-and-set. */
export async function transitionRequisition(
  db: XosClient,
  id: string,
  expected: RequisitionState,
  next: RequisitionState,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("transition_requisition", {
    p_requisition_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

// Agreements --------------------------------------------------------------------------------------------------------

export interface Agreement {
  readonly id: string;
  readonly projectId: string | null;
  readonly offerId: string | null;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly counterpartyId: string | null;
  readonly kind: AgreementKind;
  readonly title: string;
  readonly state: AgreementState;
  readonly tokenExpiresAt: string | null;
  readonly signedAt: string | null;
  readonly signedName: string | null;
  readonly createdAt: string;
}

const AGREEMENT_SELECT =
  "id, project_id, offer_id, person_id, counterparty_id, agreement_kind, title, agreement_state, token_expires_at, signed_at, signed_name, created_at, person:people!agreements_person_id_fkey(full_name)";

interface AgreementRow {
  id: string;
  project_id: string | null;
  offer_id: string | null;
  person_id: string | null;
  counterparty_id: string | null;
  agreement_kind: AgreementKind;
  title: string;
  agreement_state: AgreementState;
  token_expires_at: string | null;
  signed_at: string | null;
  signed_name: string | null;
  created_at: string;
  person: { full_name: string | null } | null;
}

function toAgreement(r: AgreementRow): Agreement {
  return {
    id: r.id,
    projectId: r.project_id,
    offerId: r.offer_id,
    personId: r.person_id,
    personName: r.person?.full_name ?? null,
    counterpartyId: r.counterparty_id,
    kind: r.agreement_kind,
    title: r.title,
    state: r.agreement_state,
    tokenExpiresAt: r.token_expires_at,
    signedAt: r.signed_at,
    signedName: r.signed_name,
    createdAt: r.created_at,
  };
}

export async function listAgreements(
  db: XosClient,
  filter: { readonly orgId: string; readonly states?: readonly AgreementState[] },
): Promise<Result<Agreement[]>> {
  let query = db
    .from("agreements")
    .select(AGREEMENT_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (filter.states && filter.states.length > 0) {
    query = query.in("agreement_state", [...filter.states]);
  }
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as AgreementRow[]).map(toAgreement));
}

export interface AgreementDetail extends Agreement {
  readonly body: string;
  readonly signedBodySha256: string | null;
  readonly transitions: readonly TransitionEntry[];
}

export async function getAgreement(db: XosClient, id: string): Promise<Result<AgreementDetail>> {
  const { data, error } = await db
    .from("agreements")
    .select(`${AGREEMENT_SELECT}, body, signed_body_sha256`)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const ledger = await db
    .from("agreement_state_transitions")
    .select("id, from_state, to_state, reason, created_at, created_by")
    .eq("agreement_id", id);
  if (ledger.error) return fail(toDataError(ledger.error));
  const row = data as unknown as AgreementRow & { body: string; signed_body_sha256: string | null };
  return ok({
    ...toAgreement(row),
    body: row.body,
    signedBodySha256: row.signed_body_sha256,
    transitions: toTransitions(ledger.data),
  });
}

export interface AgreementInput {
  readonly orgId: string;
  readonly projectId: string | null;
  readonly personId: string | null;
  readonly counterpartyId: string | null;
  readonly offerId: string | null;
  readonly kind: AgreementKind;
  readonly title: string;
  readonly body: string;
}

export async function createAgreement(
  db: XosClient,
  input: AgreementInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("agreements")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      person_id: input.personId,
      counterparty_id: input.counterpartyId,
      offer_id: input.offerId,
      agreement_kind: input.kind,
      title: input.title.trim(),
      body: input.body.trim(),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Edits an agreement's title and text while it is Proposed. */
export async function updateAgreement(
  db: XosClient,
  id: string,
  input: { readonly title: string; readonly body: string },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("agreements")
    .update({ title: input.title.trim(), body: input.body.trim() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/**
 * Sends an agreement for signature. The signing token and access code are returned once and stored only
 * as hashes (invariant 8); the caller shows them and the signer receives them by separate channels.
 */
export async function sendAgreement(
  db: XosClient,
  id: string,
  reason: string,
  validDays = 14,
): Promise<Result<{ signingToken: string; accessCode: string }>> {
  const { data, error } = await db
    .rpc("send_agreement", {
      p_agreement_id: id,
      p_reason: reason,
      p_valid_for: `${validDays} days`,
    })
    .single();
  if (error) return fail(toDataError(error));
  return ok({ signingToken: data.signing_token, accessCode: data.access_code });
}

/** Recalls, expires, cancels or supersedes an agreement. A Signed agreement only becomes Superseded. */
export async function transitionAgreement(
  db: XosClient,
  id: string,
  expected: AgreementState,
  next: AgreementState,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("transition_agreement", {
    p_agreement_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** SHA-256 of the exact text, lowercase hex, as the database checks it at signing. */
export async function bodyHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Signs as the signed-in person the agreement names; false when the text changed or it is not Sent. */
export async function signAgreement(
  db: XosClient,
  id: string,
  signedName: string,
  body: string,
): Promise<Result<{ signed: boolean }>> {
  const { data, error } = await db.rpc("sign_agreement", {
    p_agreement_id: id,
    p_signed_name: signedName.trim(),
    p_body_sha256: await bodyHash(body),
  });
  if (error) return fail(toDataError(error));
  return ok({ signed: data });
}

// Offers (A28's table, read here) ---------------------------------------------------------------------------------------

export interface OfferSummary {
  readonly id: string;
  readonly applicationId: string;
  readonly opportunityId: string | null;
  readonly opportunityTitle: string | null;
  readonly applicantName: string | null;
  readonly state: OfferState;
  readonly createdAt: string;
  readonly latest: {
    readonly amountMinor: number | null;
    readonly currencyCode: string | null;
    readonly rateType: string | null;
    readonly startsOn: string | null;
    readonly endsOn: string | null;
    readonly expiresAt: string | null;
  } | null;
}

export async function listOffers(
  db: XosClient,
  filter: { readonly orgId: string; readonly states?: readonly OfferState[] },
): Promise<Result<OfferSummary[]>> {
  let query = db
    .from("offers")
    .select(
      "id, application_id, offer_state, created_at, application:applications!offers_application_id_fkey(opportunity_id, applicant:people!applications_applicant_person_id_fkey(full_name), opportunity:opportunities!applications_opportunity_id_fkey(title)), versions:offer_versions(version_number, amount_minor, currency_code, rate_type, starts_on, ends_on, expires_at)",
    )
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (filter.states && filter.states.length > 0)
    query = query.in("offer_state", [...filter.states]);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const rows = data as unknown as Array<{
    id: string;
    application_id: string;
    offer_state: OfferState;
    created_at: string;
    application: {
      opportunity_id: string;
      applicant: { full_name: string | null } | null;
      opportunity: { title: string } | null;
    } | null;
    versions: Array<{
      version_number: number;
      amount_minor: number | null;
      currency_code: string | null;
      rate_type: string | null;
      starts_on: string | null;
      ends_on: string | null;
      expires_at: string | null;
    }> | null;
  }>;
  return ok(
    rows.map((r) => {
      const latest = [...(r.versions ?? [])].sort((a, b) => b.version_number - a.version_number)[0];
      return {
        id: r.id,
        applicationId: r.application_id,
        opportunityId: r.application?.opportunity_id ?? null,
        opportunityTitle: r.application?.opportunity?.title ?? null,
        applicantName: r.application?.applicant?.full_name ?? null,
        state: r.offer_state,
        createdAt: r.created_at,
        latest: latest
          ? {
              amountMinor: latest.amount_minor,
              currencyCode: latest.currency_code,
              rateType: latest.rate_type,
              startsOn: latest.starts_on,
              endsOn: latest.ends_on,
              expiresAt: latest.expires_at,
            }
          : null,
      };
    }),
  );
}

// Certifications ------------------------------------------------------------------------------------------------------

export interface Certification {
  readonly id: string;
  readonly name: string;
  readonly issuingBody: string;
}

export interface CertificationHolder {
  readonly id: string;
  readonly certificationId: string;
  readonly certificationName: string;
  readonly issuingBody: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly verifiedBy: string | null;
  readonly issuedOn: string;
  readonly expiresOn: string | null;
  readonly publicVerification: boolean;
}

export async function listCertifications(
  db: XosClient,
  orgId: string,
): Promise<Result<Certification[]>> {
  const { data, error } = await db
    .from("certifications")
    .select("id, name, issuing_body")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map((c) => ({ id: c.id, name: c.name, issuingBody: c.issuing_body })));
}

export async function createCertification(
  db: XosClient,
  orgId: string,
  input: { readonly name: string; readonly issuingBody: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("certifications")
    .insert({ org_id: orgId, name: input.name.trim(), issuing_body: input.issuingBody.trim() })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

const HOLDER_SELECT =
  "id, certification_id, person_id, verified_by, issued_on, expires_on, public_verification_consented, certification:certifications!certification_holders_certification_id_fkey(name, issuing_body), person:people!certification_holders_person_id_fkey(full_name)";

interface HolderRow {
  id: string;
  certification_id: string;
  person_id: string;
  verified_by: string | null;
  issued_on: string;
  expires_on: string | null;
  public_verification_consented: boolean;
  certification: { name: string; issuing_body: string } | null;
  person: { full_name: string | null } | null;
}

function toHolder(h: HolderRow): CertificationHolder {
  return {
    id: h.id,
    certificationId: h.certification_id,
    certificationName: h.certification?.name ?? "",
    issuingBody: h.certification?.issuing_body ?? "",
    personId: h.person_id,
    personName: h.person?.full_name ?? null,
    verifiedBy: h.verified_by,
    issuedOn: h.issued_on,
    expiresOn: h.expires_on,
    publicVerification: h.public_verification_consented,
  };
}

/** Certificates held, soonest expiry first; a certificate without an expiry sorts last. */
export async function listCertificationHolders(
  db: XosClient,
  filter: { readonly orgId: string; readonly personId?: string },
): Promise<Result<CertificationHolder[]>> {
  let query = db
    .from("certification_holders")
    .select(HOLDER_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.personId) query = query.eq("person_id", filter.personId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as HolderRow[])
      .map(toHolder)
      .sort((a, b) => (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999")),
  );
}

export async function getCertificationHolder(
  db: XosClient,
  id: string,
): Promise<Result<CertificationHolder>> {
  const { data, error } = await db
    .from("certification_holders")
    .select(HOLDER_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toHolder(data as unknown as HolderRow));
}

/** Records a certificate held by someone else; the recorder is the verifier and never the holder. */
export async function recordCertificationHolder(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly certificationId: string;
    readonly personId: string;
    readonly issuedOn: string;
    readonly expiresOn: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("certification_holders")
    .insert({
      org_id: input.orgId,
      certification_id: input.certificationId,
      person_id: input.personId,
      issued_on: input.issuedOn,
      expires_on: input.expiresOn,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a certificate record (soft delete), for example one recorded in error. */
export async function removeCertificationHolder(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("certification_holders")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Whether a certificate is current on a day, expiring within a window, or expired. */
export function certificateStatus(
  expiresOn: string | null,
  today: string,
  soonDays = 30,
): "current" | "expiring" | "expired" {
  if (expiresOn === null) return "current";
  if (expiresOn < today) return "expired";
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + soonDays);
  return expiresOn <= soon.toISOString().slice(0, 10) ? "expiring" : "current";
}
