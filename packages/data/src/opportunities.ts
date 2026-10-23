import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Opportunities repository (Section 4.2 Opportunities, Section 4.4.3 and 4.4.4): the org side of the engagement
 * lifecycle from requisition to re-engagement. Postings and their positions, requirements, questions and invitations;
 * applications on the Pipeline board with shortlists, interviews, sealed bids and offers; engagements with their
 * documents, signing links, deliverables and onboarding; pools; ratings; and the marketplace settings. Reads go through
 * row level security and A28's owner-run board views (migration 0775); every state change goes through the RPCs of
 * migrations 0700 to 0775, which authorize, compare-and-set and write the ledgers. Refusals come back as typed errors.
 */

type Enums = Database["app"]["Enums"];
export type OpportunityState = Enums["opportunity_state"];
export type OpportunityVisibility = Enums["opportunity_visibility"];
export type RateType = Enums["rate_type"];
export type ExternalRoleType = Enums["external_role_type"];
export type ApplicationState = Enums["application_state"];
export type EngagementState = Enums["engagement_state"];
export type EngagementDocumentState = Enums["engagement_document_state"];
export type EngagementDocumentKind = Enums["engagement_document_kind"];
export type OfferState = Enums["offer_state"];
export type OfferSide = Enums["offer_side"];
export type PoolKind = Enums["pool_kind"];
export type PoolStanding = Enums["pool_standing"];
export type InterviewKind = Enums["interview_kind"];
export type OnboardingItemKind = Enums["onboarding_item_kind"];
export type VerificationMethod = Enums["verification_method"];
export type VerificationOutcome = Enums["verification_outcome"];
export type RequisitionState = Enums["requisition_state"];
export type DeliverableState = Enums["deliverable_state"];
export type ApprovalDecision = Enums["approval_decision"];

/** Every opportunity state in lifecycle order (Section 4.4.4). */
export const OPPORTUNITY_STATES: readonly OpportunityState[] = [
  "Draft",
  "Pending Approval",
  "Published",
  "Paused",
  "Filled",
  "Closed",
  "Canceled",
];
/** Every application state in pipeline order: the columns of the Pipeline board. */
export const APPLICATION_STATES: readonly ApplicationState[] = [
  "Submitted",
  "In Review",
  "Shortlisted",
  "Offered",
  "Accepted",
  "Declined",
  "Withdrawn",
  "Not Selected",
];
export const ENGAGEMENT_STATES: readonly EngagementState[] = [
  "Onboarding",
  "Blocked",
  "Active",
  "Closing",
  "Complete",
  "Canceled",
];
export const ROLE_TYPES: readonly ExternalRoleType[] = [
  "Client",
  "Vendor",
  "Contractor",
  "Crew",
  "Staff",
  "Artist",
  "Artist Representative",
  "Sponsor",
];
/** Role types that publish only from an Approved requisition (migration 0774). */
export const REQUISITION_ROLE_TYPES: readonly ExternalRoleType[] = ["Contractor", "Crew", "Staff"];
export const VISIBILITIES: readonly OpportunityVisibility[] = [
  "Invited",
  "Pool",
  "Network",
  "Public",
];
export const RATE_TYPES: readonly RateType[] = ["Hourly", "Day", "Flat", "Milestone", "Bid"];
export const DOCUMENT_KINDS: readonly EngagementDocumentKind[] = [
  "Offer",
  "Agreement",
  "Statement of Work",
  "Non-Disclosure Agreement",
  "Rider",
  "Advance Packet",
  "Insurance Certificate",
  "Lien Waiver",
  "Settlement",
  "Proof of Performance",
  "Content Consent",
];
export const ONBOARDING_ITEM_KINDS: readonly OnboardingItemKind[] = [
  "Document Upload",
  "Electronic Signature",
  "Form",
  "Certification",
  "Training",
  "Acknowledgment",
  "Background Check",
  "Tax Form",
  "Payout Details",
];

/**
 * The moves each lifecycle allows from a state, mirroring private.lifecycle_transition_rules. The database still
 * decides every move; these only choose which buttons the pages offer.
 */
export const OPPORTUNITY_MOVES: Readonly<Record<OpportunityState, readonly OpportunityState[]>> = {
  Draft: ["Pending Approval", "Canceled"],
  "Pending Approval": ["Published", "Draft", "Canceled"],
  Published: ["Paused", "Filled", "Closed", "Canceled"],
  Paused: ["Published", "Closed", "Canceled"],
  Filled: ["Published", "Closed"],
  Closed: [],
  Canceled: [],
};
/** Org-side application moves (the applicant withdraws, accepts or declines in Gateway). */
export const APPLICATION_ORG_MOVES: Readonly<
  Record<ApplicationState, readonly ApplicationState[]>
> = {
  Submitted: ["In Review", "Not Selected"],
  "In Review": ["Shortlisted", "Not Selected"],
  Shortlisted: ["Not Selected"],
  Offered: [],
  Accepted: [],
  Declined: [],
  Withdrawn: [],
  "Not Selected": [],
};
export const ENGAGEMENT_MOVES: Readonly<Record<EngagementState, readonly EngagementState[]>> = {
  Onboarding: ["Active", "Blocked", "Canceled"],
  Blocked: ["Onboarding", "Active", "Canceled"],
  Active: ["Closing", "Blocked", "Canceled"],
  Closing: ["Complete", "Active"],
  Complete: [],
  Canceled: [],
};
/** Org-side document moves; the party signs (Sent to Signed) in Gateway or through a signing link. */
export const DOCUMENT_ORG_MOVES: Readonly<
  Record<EngagementDocumentState, readonly EngagementDocumentState[]>
> = {
  Proposed: ["Sent", "Canceled"],
  Sent: ["Proposed", "Expired", "Canceled"],
  Signed: ["Executed", "Canceled"],
  Executed: ["Superseded", "Expired"],
  Expired: [],
  Superseded: [],
  Canceled: [],
};

/**
 * Role types whose engagements carry no work terms (owner decision 31, migration 1624): a client pays the org and a
 * sponsor contributes, so neither has a canon role, worker classification, pay basis, rate or employment terms.
 */
export const ROLE_TYPES_WITHOUT_WORK_TERMS: readonly ExternalRoleType[] = ["Client", "Sponsor"];

/** Whether an engagement of this role type carries a role, classification and pay terms. */
export function hasWorkTerms(roleType: ExternalRoleType): boolean {
  return !ROLE_TYPES_WITHOUT_WORK_TERMS.includes(roleType);
}

// Shapes -------------------------------------------------------------------------------------------------------------

export interface Requisition {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly roleCode: string;
  readonly jobTitle: string | null;
  readonly roleType: ExternalRoleType | null;
  readonly headcount: number;
  readonly rateMinor: number | null;
  readonly currencyCode: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly justification: string;
  readonly state: RequisitionState;
  readonly opportunityCount: number;
}

export interface OpportunitySummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly title: string;
  readonly roleType: ExternalRoleType;
  readonly roleCode: string | null;
  readonly visibility: OpportunityVisibility;
  readonly rateType: RateType | null;
  readonly payMinMinor: number | null;
  readonly payMaxMinor: number | null;
  readonly currencyCode: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly deadlineAt: string | null;
  readonly state: OpportunityState;
  readonly requisitionId: string | null;
  readonly positionCount: number;
  readonly applicationCount: number;
  readonly updatedAt: string;
}

export interface OpportunityPosition {
  readonly id: string;
  readonly label: string;
  readonly callAt: string | null;
  readonly endsAt: string | null;
}

export interface OpportunityRequirement {
  readonly id: string;
  readonly kind: Enums["opportunity_requirement_kind"];
  readonly description: string;
  readonly certificationId: string | null;
  readonly insuranceMinimumMinor: number | null;
  readonly currencyCode: string | null;
}

export interface OpportunityQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly sortOrder: number;
  readonly required: boolean;
}

export interface OpportunityInvitation {
  readonly id: string;
  readonly personId: string | null;
  readonly organizationId: string | null;
}

export interface OpportunityDetail extends OpportunitySummary {
  readonly description: string | null;
  readonly scopeNodeId: string | null;
  readonly venueId: string | null;
  readonly jurisdictionId: string | null;
  readonly minimumAge: number | null;
  readonly positions: readonly OpportunityPosition[];
  readonly requirements: readonly OpportunityRequirement[];
  readonly questions: readonly OpportunityQuestion[];
  readonly invitations: readonly OpportunityInvitation[];
}

export interface OpportunityInput {
  readonly projectId: string;
  readonly title: string;
  readonly roleType: ExternalRoleType;
  readonly roleCode?: string | null;
  readonly requisitionId?: string | null;
  readonly description?: string | null;
  readonly venueId?: string | null;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
  readonly visibility: OpportunityVisibility;
  readonly rateType?: RateType | null;
  readonly payMinMinor?: number | null;
  readonly payMaxMinor?: number | null;
  readonly currencyCode?: string | null;
  readonly deadlineAt?: string | null;
  readonly minimumAge?: number | null;
  /** Remote work follows the pay transparency rules that cover remote roles (1125). */
  readonly isRemote?: boolean;
}

export type OpportunityPatch = Partial<Omit<OpportunityInput, "projectId" | "roleType">>;

export interface ApplicationCard {
  readonly id: string;
  readonly opportunityId: string;
  readonly opportunityTitle: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly roleType: ExternalRoleType;
  readonly applicantKind: "Person" | "Account";
  readonly applicantName: string | null;
  readonly applicantPersonId: string | null;
  readonly applicantOrganizationId: string | null;
  readonly state: ApplicationState;
  readonly submittedAt: string;
  readonly availabilityConfirmed: boolean;
  readonly coverNote: string | null;
  readonly proposedFeeMinor: number | null;
  readonly currencyCode: string | null;
  readonly shortlistRank: number | null;
  readonly nextInterviewAt: string | null;
  readonly offerId: string | null;
  readonly offerState: OfferState | null;
  readonly offerTurnSide: OfferSide | null;
  readonly offerRateType: RateType | null;
  readonly offerAmountMinor: number | null;
  readonly offerCurrencyCode: string | null;
  readonly offerExpiresAt: string | null;
  readonly hasBid: boolean;
  readonly bidSealed: boolean;
  readonly bidTotalMinor: number | null;
  readonly bidCurrencyCode: string | null;
  readonly engagementId: string | null;
}

export interface ApplicationAnswer {
  readonly id: string;
  readonly questionId: string;
  readonly prompt: string;
  readonly answer: string;
}

export interface Interview {
  readonly id: string;
  readonly kind: InterviewKind;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly location: string | null;
  readonly internalNote: string | null;
}

export interface OfferVersion {
  readonly id: string;
  readonly version: number;
  readonly side: OfferSide;
  readonly rateType: RateType | null;
  readonly amountMinor: number | null;
  readonly currencyCode: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly message: string | null;
  readonly expiresAt: string | null;
  readonly proposedAt: string;
}

export interface OfferTerms {
  readonly rateType: RateType | null;
  readonly amountMinor: number | null;
  readonly currencyCode: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly message: string | null;
  readonly expiresAt?: string | null;
}

export interface EngagementCard {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly partyName: string | null;
  readonly personId: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly roleType: ExternalRoleType;
  /** Null for Client and Sponsor engagements (hasWorkTerms). */
  readonly roleCode: string | null;
  readonly jobTitle: string | null;
  /** Null for Client and Sponsor engagements (hasWorkTerms). */
  readonly workerClassification: string | null;
  readonly state: EngagementState;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly applicationId: string | null;
  readonly openBlockingCount: number;
  readonly onboardingItemCount: number;
  readonly documentsInFlight: number;
  readonly deliverablesToReview: number;
  readonly orgRated: boolean;
  readonly partyRated: boolean;
  readonly ratingsReleased: boolean;
}

export interface ResolvedRate {
  readonly rateMinor: number | null;
  readonly currencyCode: string | null;
  readonly masked: boolean;
  readonly payBasis: string | null;
  readonly arrangement: string | null;
}

export interface EngagementDocument {
  readonly id: string;
  readonly kind: EngagementDocumentKind;
  readonly title: string;
  readonly state: EngagementDocumentState;
  readonly expiresOn: string | null;
}

export interface OnboardingStatus {
  readonly itemId: string;
  readonly engagementId: string;
  readonly requirementId: string;
  readonly name: string;
  readonly kind: OnboardingItemKind;
  readonly blocking: boolean;
  readonly method: VerificationMethod;
  readonly submittedAt: string | null;
  readonly latestOutcome: VerificationOutcome | null;
  readonly expiresOn: string | null;
  readonly passes: boolean;
  readonly carriedOver: boolean;
  readonly reminderDue: boolean;
}

export interface Deliverable {
  readonly id: string;
  readonly recordId: string;
  readonly title: string | null;
  readonly state: DeliverableState;
  readonly submittedAt: string | null;
  readonly submissionMessage: string | null;
  readonly returnReason: string | null;
  /** Agreed milestone fee in minor units of the engagement currency; null is unpriced (1121). */
  readonly feeMinor: number | null;
}

export interface Rating {
  readonly id: string;
  readonly engagementId: string;
  readonly side: Enums["rating_side"];
  readonly score: number;
  readonly comment: string | null;
  readonly submittedAt: string;
  readonly reply: string | null;
}

export interface OnboardingRequirement {
  readonly id: string;
  readonly name: string;
  readonly kind: OnboardingItemKind;
  readonly roleType: ExternalRoleType | null;
  readonly jurisdictionId: string | null;
  readonly method: VerificationMethod;
  readonly blocking: boolean;
  readonly validForDays: number | null;
  readonly remindDaysBefore: number | null;
}

export interface OnboardingRequirementInput {
  readonly orgId: string;
  readonly name: string;
  readonly kind: OnboardingItemKind;
  readonly roleType?: ExternalRoleType | null;
  readonly jurisdictionId?: string | null;
  readonly method: VerificationMethod;
  readonly blocking: boolean;
  readonly validForDays?: number | null;
  readonly remindDaysBefore?: number | null;
}

export interface TalentPool {
  readonly id: string;
  readonly name: string;
  readonly kind: PoolKind;
  readonly memberCount: number;
}

export interface PoolMember {
  readonly id: string;
  readonly poolId: string;
  readonly personId: string | null;
  readonly organizationId: string | null;
  readonly name: string | null;
  readonly standing: PoolStanding;
  readonly reason: string | null;
  readonly reviewOn: string | null;
}

export interface ListingReport {
  readonly id: string;
  readonly opportunityId: string;
  readonly opportunityTitle: string | null;
  readonly reason: Enums["listing_report_reason"];
  readonly details: string | null;
  readonly reportedAt: string;
}

export interface SigningLink {
  readonly tokenId: string;
  readonly token: string;
  readonly accessCode: string;
  readonly expiresAt: string;
}

// Helpers ------------------------------------------------------------------------------------------------------------

const n = (value: number | null | undefined): number => value ?? 0;
const toNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function rpcResult<T>(data: T | null, error: Parameters<typeof toDataError>[0] | null): Result<T> {
  if (error) return fail(toDataError(error));
  return ok(data as T);
}

// Requisitions ---------------------------------------------------------------------------------------------------------

/** Approved and pending staffing requisitions of the org with how many opportunities each already published from. */
export async function listRequisitions(
  db: XosClient,
  orgId: string,
): Promise<Result<Requisition[]>> {
  const { data, error } = await db
    .from("requisitions")
    .select(
      "id, project_id, role_code, role_type, headcount, rate_minor, currency_code, starts_on, ends_on, justification, requisition_state, project:projects(project_key), opportunities(id, deleted_at)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    project_id: string;
    role_code: string;
    role_type: ExternalRoleType | null;
    headcount: number;
    rate_minor: number | null;
    currency_code: string;
    starts_on: string | null;
    ends_on: string | null;
    justification: string;
    requisition_state: RequisitionState;
    project: { project_key: string } | null;
    opportunities: { id: string; deleted_at: string | null }[] | null;
  }>;
  const titles = await jobTitles(
    db,
    rows.map((r) => r.role_code),
  );
  if (!titles.ok) return fail(titles.error);
  return ok(
    rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectKey: r.project?.project_key ?? "",
      roleCode: r.role_code,
      jobTitle: titles.data.get(r.role_code) ?? null,
      roleType: r.role_type,
      headcount: r.headcount,
      rateMinor: r.rate_minor,
      currencyCode: r.currency_code,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      justification: r.justification,
      state: r.requisition_state,
      opportunityCount: (r.opportunities ?? []).filter((o) => o.deleted_at === null).length,
    })),
  );
}

/** Job titles from the canon Roles Library, so codes always appear beside a plain name (Section 11.10, habit 2). */
export async function jobTitles(
  db: XosClient,
  roleCodes: readonly string[],
): Promise<Result<Map<string, string>>> {
  const codes = [...new Set(roleCodes.filter((c) => c))];
  if (codes.length === 0) return ok(new Map());
  const { data, error } = await db
    .schema("xpms")
    .from("role")
    .select("role_code, job_title")
    .in("role_code", codes);
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      (data ?? []).map((r: { role_code: string; job_title: string }) => [r.role_code, r.job_title]),
    ),
  );
}

// Postings ---------------------------------------------------------------------------------------------------------------

const OPPORTUNITY_COLUMNS =
  "id, project_id, title, role_type, role_code, visibility, rate_type, pay_min_minor, pay_max_minor, currency_code, starts_on, ends_on, deadline_at, opportunity_state, requisition_id, updated_at, description, scope_node_id, venue_id, jurisdiction_id, minimum_age, project:projects(project_key, name), positions:opportunity_positions(id, label, call_at, ends_at, deleted_at), applications(id, deleted_at)";

interface OpportunityRow {
  id: string;
  project_id: string;
  title: string;
  role_type: ExternalRoleType;
  role_code: string | null;
  visibility: OpportunityVisibility;
  rate_type: RateType | null;
  pay_min_minor: number | null;
  pay_max_minor: number | null;
  currency_code: string | null;
  starts_on: string | null;
  ends_on: string | null;
  deadline_at: string | null;
  opportunity_state: OpportunityState;
  requisition_id: string | null;
  updated_at: string;
  description: string | null;
  scope_node_id: string | null;
  venue_id: string | null;
  jurisdiction_id: string | null;
  minimum_age: number | null;
  project: { project_key: string; name: string } | null;
  positions:
    | {
        id: string;
        label: string;
        call_at: string | null;
        ends_at: string | null;
        deleted_at: string | null;
      }[]
    | null;
  applications: { id: string; deleted_at: string | null }[] | null;
}

function toSummary(r: OpportunityRow): OpportunitySummary {
  return {
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project?.project_key ?? "",
    projectName: r.project?.name ?? "",
    title: r.title,
    roleType: r.role_type,
    roleCode: r.role_code,
    visibility: r.visibility,
    rateType: r.rate_type,
    payMinMinor: r.pay_min_minor,
    payMaxMinor: r.pay_max_minor,
    currencyCode: r.currency_code,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    deadlineAt: r.deadline_at,
    state: r.opportunity_state,
    requisitionId: r.requisition_id,
    positionCount: (r.positions ?? []).filter((p) => p.deleted_at === null).length,
    applicationCount: (r.applications ?? []).filter((a) => a.deleted_at === null).length,
    updatedAt: r.updated_at,
  };
}

/** Opportunities of the org, newest first, optionally for one project or in some states. */
export async function listOpportunities(
  db: XosClient,
  orgId: string,
  filter: { projectId?: string; states?: readonly OpportunityState[] } = {},
): Promise<Result<OpportunitySummary[]>> {
  let query = db
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.states && filter.states.length > 0)
    query = query.in("opportunity_state", [...filter.states]);
  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as OpportunityRow[]).map(toSummary));
}

/** One opportunity with its positions, requirements, questions and invitations; not-found when unreadable. */
export async function getOpportunity(
  db: XosClient,
  id: string,
): Promise<Result<OpportunityDetail>> {
  const { data, error } = await db
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as OpportunityRow;
  const [requirements, questions, invitations] = await Promise.all([
    db
      .from("opportunity_requirements")
      .select(
        "id, requirement_kind, description, certification_id, insurance_minimum_minor, currency_code",
      )
      .eq("opportunity_id", id)
      .is("deleted_at", null),
    db
      .from("opportunity_questions")
      .select("id, prompt, sort_order, is_required")
      .eq("opportunity_id", id)
      .is("deleted_at", null)
      .order("sort_order"),
    db
      .from("opportunity_invitations")
      .select("id, person_id, organization_id")
      .eq("opportunity_id", id)
      .is("deleted_at", null),
  ]);
  for (const r of [requirements, questions, invitations])
    if (r.error) return fail(toDataError(r.error));
  return ok({
    ...toSummary(row),
    description: row.description,
    scopeNodeId: row.scope_node_id,
    venueId: row.venue_id,
    jurisdictionId: row.jurisdiction_id,
    minimumAge: row.minimum_age,
    positions: (row.positions ?? [])
      .filter((p) => p.deleted_at === null)
      .map((p) => ({ id: p.id, label: p.label, callAt: p.call_at, endsAt: p.ends_at })),
    requirements: (requirements.data ?? []).map((r) => ({
      id: r.id,
      kind: r.requirement_kind,
      description: r.description,
      certificationId: r.certification_id,
      insuranceMinimumMinor: r.insurance_minimum_minor,
      currencyCode: r.currency_code,
    })),
    questions: (questions.data ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      sortOrder: q.sort_order,
      required: q.is_required,
    })),
    invitations: (invitations.data ?? []).map((i) => ({
      id: i.id,
      personId: i.person_id,
      organizationId: i.organization_id,
    })),
  });
}

function opportunityColumns(input: OpportunityPatch) {
  const row: Record<string, unknown> = {};
  const map: [keyof OpportunityPatch, string][] = [
    ["title", "title"],
    ["roleCode", "role_code"],
    ["requisitionId", "requisition_id"],
    ["description", "description"],
    ["venueId", "venue_id"],
    ["startsOn", "starts_on"],
    ["endsOn", "ends_on"],
    ["visibility", "visibility"],
    ["rateType", "rate_type"],
    ["payMinMinor", "pay_min_minor"],
    ["payMaxMinor", "pay_max_minor"],
    ["currencyCode", "currency_code"],
    ["deadlineAt", "deadline_at"],
    ["minimumAge", "minimum_age"],
    ["isRemote", "is_remote"],
  ];
  for (const [key, column] of map) if (input[key] !== undefined) row[column] = input[key];
  return row;
}

/** Drafts an opportunity; it starts Draft and publishes through approval. */
export async function createOpportunity(
  db: XosClient,
  input: OpportunityInput,
): Promise<Result<{ id: string }>> {
  const row = {
    ...opportunityColumns(input),
    project_id: input.projectId,
    role_type: input.roleType,
  };
  const { data, error } = await db
    .from("opportunities")
    .insert(row as unknown as Database["app"]["Tables"]["opportunities"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Edits an opportunity; compensation, visibility, deadline and requisition are refused once published. */
export async function updateOpportunity(
  db: XosClient,
  id: string,
  patch: OpportunityPatch,
): Promise<Result<null>> {
  const { error } = await db
    .from("opportunities")
    .update(opportunityColumns(patch) as Database["app"]["Tables"]["opportunities"]["Update"])
    .eq("id", id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** Moves an opportunity; publishing applies spend authority, pay transparency and the plan gate. */
export async function transitionOpportunity(
  db: XosClient,
  id: string,
  expected: OpportunityState,
  next: OpportunityState,
  reason: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("transition_opportunity", {
    p_opportunity_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  return rpcResult(data as string | null, error);
}

export async function addPosition(
  db: XosClient,
  opportunityId: string,
  input: { label: string; callAt?: string | null; endsAt?: string | null },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("opportunity_positions")
    .insert({
      opportunity_id: opportunityId,
      label: input.label,
      call_at: input.callAt ?? null,
      ends_at: input.endsAt ?? null,
    } as unknown as Database["app"]["Tables"]["opportunity_positions"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function addQuestion(
  db: XosClient,
  opportunityId: string,
  input: { prompt: string; sortOrder: number; required: boolean },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("opportunity_questions")
    .insert({
      opportunity_id: opportunityId,
      prompt: input.prompt,
      sort_order: input.sortOrder,
      is_required: input.required,
    } as unknown as Database["app"]["Tables"]["opportunity_questions"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function addRequirement(
  db: XosClient,
  opportunityId: string,
  input:
    | { kind: "Equipment"; description: string }
    | { kind: "Insurance"; description: string; minimumMinor: number; currencyCode: string },
): Promise<Result<{ id: string }>> {
  const row: Record<string, unknown> = {
    opportunity_id: opportunityId,
    requirement_kind: input.kind,
    description: input.description,
  };
  if (input.kind === "Insurance") {
    row["insurance_minimum_minor"] = input.minimumMinor;
    row["currency_code"] = input.currencyCode;
  }
  const { data, error } = await db
    .from("opportunity_requirements")
    .insert(row as unknown as Database["app"]["Tables"]["opportunity_requirements"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Invites a person or an external account by id; for Invited visibility they are the only ones who see it. */
export async function addInvitation(
  db: XosClient,
  opportunityId: string,
  party: { personId: string } | { organizationId: string },
): Promise<Result<{ id: string }>> {
  const row =
    "personId" in party ? { person_id: party.personId } : { organization_id: party.organizationId };
  const { data, error } = await db
    .from("opportunity_invitations")
    .insert({
      opportunity_id: opportunityId,
      ...row,
    } as unknown as Database["app"]["Tables"]["opportunity_invitations"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Soft-deletes a child row of an opportunity (position, requirement, question or invitation). */
export async function removeOpportunityChild(
  db: XosClient,
  table:
    | "opportunity_positions"
    | "opportunity_requirements"
    | "opportunity_questions"
    | "opportunity_invitations",
  id: string,
): Promise<Result<null>> {
  const { error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Pipeline ------------------------------------------------------------------------------------------------------------------

interface BoardRow {
  application_id: string | null;
  opportunity_id: string | null;
  opportunity_title: string | null;
  project_id: string | null;
  project_key: string | null;
  role_type: ExternalRoleType | null;
  applicant_kind: string | null;
  applicant_name: string | null;
  applicant_person_id: string | null;
  applicant_organization_id: string | null;
  application_state: ApplicationState | null;
  submitted_at: string | null;
  availability_confirmed: boolean | null;
  cover_note: string | null;
  proposed_fee_minor: number | null;
  currency_code: string | null;
  shortlist_rank: number | null;
  next_interview_at: string | null;
  offer_id: string | null;
  offer_state: OfferState | null;
  offer_turn_side: OfferSide | null;
  offer_rate_type: RateType | null;
  offer_amount_minor: number | null;
  offer_currency_code: string | null;
  offer_expires_at: string | null;
  has_bid: boolean | null;
  bid_sealed: boolean | null;
  bid_total_minor: number | null;
  bid_currency_code: string | null;
  engagement_id: string | null;
}

function toCard(r: BoardRow): ApplicationCard {
  return {
    id: r.application_id ?? "",
    opportunityId: r.opportunity_id ?? "",
    opportunityTitle: r.opportunity_title ?? "",
    projectId: r.project_id ?? "",
    projectKey: r.project_key ?? "",
    roleType: (r.role_type ?? "Crew") as ExternalRoleType,
    applicantKind: r.applicant_kind === "Account" ? "Account" : "Person",
    applicantName: r.applicant_name,
    applicantPersonId: r.applicant_person_id,
    applicantOrganizationId: r.applicant_organization_id,
    state: (r.application_state ?? "Submitted") as ApplicationState,
    submittedAt: r.submitted_at ?? "",
    availabilityConfirmed: Boolean(r.availability_confirmed),
    coverNote: r.cover_note,
    proposedFeeMinor: r.proposed_fee_minor,
    currencyCode: r.currency_code,
    shortlistRank: r.shortlist_rank,
    nextInterviewAt: r.next_interview_at,
    offerId: r.offer_id,
    offerState: r.offer_state,
    offerTurnSide: r.offer_turn_side,
    offerRateType: r.offer_rate_type,
    offerAmountMinor: r.offer_amount_minor,
    offerCurrencyCode: r.offer_currency_code,
    offerExpiresAt: r.offer_expires_at,
    hasBid: Boolean(r.has_bid),
    bidSealed: Boolean(r.bid_sealed),
    bidTotalMinor: r.bid_total_minor,
    bidCurrencyCode: r.bid_currency_code,
    engagementId: r.engagement_id,
  };
}

/** Applications on the Pipeline board, newest first; bid totals stay hidden while sealed for the reader. */
export async function listApplications(
  db: XosClient,
  orgId: string,
  filter: { opportunityId?: string; projectId?: string } = {},
): Promise<Result<ApplicationCard[]>> {
  let query = db.from("application_board").select("*").eq("org_id", orgId);
  if (filter.opportunityId) query = query.eq("opportunity_id", filter.opportunityId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query.order("submitted_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as BoardRow[]).map(toCard));
}

export async function getApplication(db: XosClient, id: string): Promise<Result<ApplicationCard>> {
  const { data, error } = await db
    .from("application_board")
    .select("*")
    .eq("application_id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toCard(data as unknown as BoardRow));
}

export async function listApplicationAnswers(
  db: XosClient,
  applicationId: string,
): Promise<Result<ApplicationAnswer[]>> {
  const { data, error } = await db
    .from("application_answers")
    .select(
      "id, opportunity_question_id, answer_text, question:opportunity_questions(prompt, sort_order)",
    )
    .eq("application_id", applicationId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    id: string;
    opportunity_question_id: string;
    answer_text: string;
    question: { prompt: string; sort_order: number } | null;
  }[];
  return ok(
    rows
      .sort((a, b) => n(a.question?.sort_order) - n(b.question?.sort_order))
      .map((r) => ({
        id: r.id,
        questionId: r.opportunity_question_id,
        prompt: r.question?.prompt ?? "",
        answer: r.answer_text,
      })),
  );
}

export async function listInterviews(
  db: XosClient,
  applicationId: string,
): Promise<Result<Interview[]>> {
  const { data, error } = await db
    .from("interviews")
    .select("id, interview_kind, scheduled_at, duration_minutes, location_text, internal_note")
    .eq("application_id", applicationId)
    .is("deleted_at", null)
    .order("scheduled_at");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      id: r.id,
      kind: r.interview_kind,
      scheduledAt: r.scheduled_at,
      durationMinutes: r.duration_minutes,
      location: r.location_text,
      internalNote: r.internal_note,
    })),
  );
}

export async function scheduleInterview(
  db: XosClient,
  applicationId: string,
  input: {
    kind: InterviewKind;
    scheduledAt: string;
    durationMinutes: number;
    location?: string | null;
    internalNote?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("interviews")
    .insert({
      application_id: applicationId,
      interview_kind: input.kind,
      scheduled_at: input.scheduledAt,
      duration_minutes: input.durationMinutes,
      location_text: input.location ?? null,
      internal_note: input.internalNote ?? null,
    } as unknown as Database["app"]["Tables"]["interviews"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Moves an application on the org side: review, shortlist or not selected. */
export async function transitionApplication(
  db: XosClient,
  id: string,
  expected: ApplicationState,
  next: ApplicationState,
  reason: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("transition_application", {
    p_application_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  return rpcResult(data as string | null, error);
}

/** Puts an application on its opportunity's shortlist at a rank, or moves it to that rank. */
export async function setShortlistRank(
  db: XosClient,
  input: { opportunityId: string; applicationId: string; rank: number; note?: string | null },
): Promise<Result<null>> {
  const existing = await db
    .from("shortlists")
    .select("id")
    .eq("application_id", input.applicationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing.error) return fail(toDataError(existing.error));
  const write = existing.data
    ? await db
        .from("shortlists")
        .update({ rank: input.rank, note: input.note ?? null })
        .eq("id", existing.data.id)
    : await db.from("shortlists").insert({
        opportunity_id: input.opportunityId,
        application_id: input.applicationId,
        rank: input.rank,
        note: input.note ?? null,
      } as unknown as Database["app"]["Tables"]["shortlists"]["Insert"]);
  if (write.error) return fail(toDataError(write.error));
  return ok(null);
}

// Offers ------------------------------------------------------------------------------------------------------------------------

export async function listOfferVersions(
  db: XosClient,
  offerId: string,
): Promise<Result<OfferVersion[]>> {
  const { data, error } = await db
    .from("offer_versions")
    .select(
      "id, version_number, proposed_side, rate_type, amount_minor, currency_code, starts_on, ends_on, message, expires_at, created_at",
    )
    .eq("offer_id", offerId)
    .order("version_number", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((v) => ({
      id: v.id,
      version: v.version_number,
      side: v.proposed_side,
      rateType: v.rate_type,
      amountMinor: v.amount_minor,
      currencyCode: v.currency_code,
      startsOn: v.starts_on,
      endsOn: v.ends_on,
      message: v.message,
      expiresAt: v.expires_at,
      proposedAt: v.created_at,
    })),
  );
}

const termsArgs = (t: OfferTerms) => ({
  p_rate_type: t.rateType as RateType,
  p_amount_minor: t.amountMinor as number,
  p_currency_code: t.currencyCode as string,
  p_starts_on: t.startsOn as string,
  p_ends_on: t.endsOn as string,
  p_message: t.message as string,
});

export async function sendOffer(
  db: XosClient,
  applicationId: string,
  terms: OfferTerms,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("send_offer", {
    p_application_id: applicationId,
    ...termsArgs(terms),
    p_expires_at: (terms.expiresAt ?? null) as string,
  });
  return rpcResult(data as string | null, error);
}

export async function reviseOffer(
  db: XosClient,
  offerId: string,
  terms: OfferTerms,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("revise_offer", {
    p_offer_id: offerId,
    ...termsArgs(terms),
    p_expires_at: (terms.expiresAt ?? null) as string,
  });
  return rpcResult(data as string | null, error);
}

/** The org accepts a counter (the applicant accepts in Gateway). */
export async function acceptOffer(db: XosClient, offerId: string): Promise<Result<null>> {
  const { error } = await db.rpc("accept_offer", { p_offer_id: offerId });
  return rpcResult(null, error);
}

export async function withdrawOffer(
  db: XosClient,
  offerId: string,
  reason: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("withdraw_offer", { p_offer_id: offerId, p_reason: reason });
  return rpcResult(null, error);
}

/** Stage 5 to 6: an accepted application becomes an Onboarding engagement with the accepted terms. */
export async function createEngagementFromApplication(
  db: XosClient,
  input: {
    applicationId: string;
    /** Null for a client or sponsor opportunity, whose engagement keeps no work terms (1624). */
    workerClassification: string | null;
    payBasis: string | null;
    arrangement: string | null;
    startDate?: string | null;
    endDate?: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("create_engagement_from_application", {
    p_application_id: input.applicationId,
    p_worker_classification: input.workerClassification as string,
    p_pay_basis: input.payBasis as string,
    p_arrangement: input.arrangement as string,
    p_start_date: (input.startDate ?? null) as string,
    p_end_date: (input.endDate ?? null) as string,
  });
  return rpcResult(data as string | null, error);
}

// Engagements ---------------------------------------------------------------------------------------------------------------------

interface EngagementBoardRow {
  engagement_id: string | null;
  project_id: string | null;
  project_key: string | null;
  project_name: string | null;
  party_name: string | null;
  person_id: string | null;
  account_id: string | null;
  account_name: string | null;
  role_type: ExternalRoleType | null;
  role_code: string | null;
  job_title: string | null;
  worker_classification: string | null;
  engagement_state: EngagementState | null;
  start_date: string | null;
  end_date: string | null;
  application_id: string | null;
  open_blocking_count: number | null;
  onboarding_item_count: number | null;
  documents_in_flight: number | null;
  deliverables_to_review: number | null;
  org_rated: boolean | null;
  party_rated: boolean | null;
  ratings_released: boolean | null;
}

function toEngagement(r: EngagementBoardRow): EngagementCard {
  return {
    id: r.engagement_id ?? "",
    projectId: r.project_id ?? "",
    projectKey: r.project_key ?? "",
    projectName: r.project_name ?? "",
    partyName: r.party_name,
    personId: r.person_id,
    accountId: r.account_id,
    accountName: r.account_name,
    roleType: (r.role_type ?? "Crew") as ExternalRoleType,
    roleCode: r.role_code,
    jobTitle: r.job_title,
    workerClassification: r.worker_classification,
    state: (r.engagement_state ?? "Onboarding") as EngagementState,
    startDate: r.start_date ?? "",
    endDate: r.end_date,
    applicationId: r.application_id,
    openBlockingCount: n(toNumber(r.open_blocking_count)),
    onboardingItemCount: n(toNumber(r.onboarding_item_count)),
    documentsInFlight: n(toNumber(r.documents_in_flight)),
    deliverablesToReview: n(toNumber(r.deliverables_to_review)),
    orgRated: Boolean(r.org_rated),
    partyRated: Boolean(r.party_rated),
    ratingsReleased: Boolean(r.ratings_released),
  };
}

export async function listEngagements(
  db: XosClient,
  orgId: string,
  filter: { projectId?: string; states?: readonly EngagementState[] } = {},
): Promise<Result<EngagementCard[]>> {
  let query = db.from("engagement_board").select("*").eq("org_id", orgId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.states && filter.states.length > 0)
    query = query.in("engagement_state", [...filter.states]);
  const { data, error } = await query.order("start_date", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as EngagementBoardRow[]).map(toEngagement));
}

export async function getEngagement(db: XosClient, id: string): Promise<Result<EngagementCard>> {
  const { data, error } = await db
    .from("engagement_board")
    .select("*")
    .eq("engagement_id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toEngagement(data as unknown as EngagementBoardRow));
}

/** The rate in force, masked (null with masked true) without data.restricted.read.payroll (ADR 0019 item 3). */
export async function getEngagementRate(
  db: XosClient,
  engagementId: string,
): Promise<Result<ResolvedRate>> {
  const { data, error } = await db
    .from("engagement_resolved")
    .select("rate_minor, rate_currency_code, is_masked, pay_basis, arrangement")
    .eq("engagement_id", engagementId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({
    rateMinor: data.rate_minor,
    currencyCode: data.rate_currency_code,
    masked: Boolean(data.is_masked),
    payBasis: data.pay_basis,
    arrangement: data.arrangement,
  });
}

export async function transitionEngagement(
  db: XosClient,
  id: string,
  expected: EngagementState,
  next: EngagementState,
  reason: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("transition_engagement", {
    p_engagement_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  return rpcResult(data as string | null, error);
}

export async function listEngagementDocuments(
  db: XosClient,
  engagementId: string,
): Promise<Result<EngagementDocument[]>> {
  const { data, error } = await db
    .from("engagement_documents")
    .select("id, document_kind, title, engagement_document_state, expires_on")
    .eq("engagement_id", engagementId)
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((d) => ({
      id: d.id,
      kind: d.document_kind,
      title: d.title,
      state: d.engagement_document_state,
      expiresOn: d.expires_on,
    })),
  );
}

export async function createEngagementDocument(
  db: XosClient,
  input: {
    engagementId: string;
    kind: EngagementDocumentKind;
    title: string;
    expiresOn?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("engagement_documents")
    .insert({
      engagement_id: input.engagementId,
      document_kind: input.kind,
      title: input.title,
      expires_on: input.expiresOn ?? null,
    } as unknown as Database["app"]["Tables"]["engagement_documents"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function transitionEngagementDocument(
  db: XosClient,
  id: string,
  expected: EngagementDocumentState,
  next: EngagementDocumentState,
  reason: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("transition_engagement_document", {
    p_document_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  return rpcResult(data as string | null, error);
}

/** Issues a signing link for a Sent document; the token and code are returned once (Section 4.4.6). */
export async function issueSigningLink(
  db: XosClient,
  documentId: string,
  recipientEmail: string,
  validForDays: number,
): Promise<Result<SigningLink>> {
  const { data, error } = await db.rpc("issue_engagement_document_token", {
    p_document_id: documentId,
    p_recipient_email: recipientEmail,
    p_valid_for: `${validForDays} days`,
  });
  if (error) return fail(toDataError(error));
  const row = (
    data as { token_id: string; token: string; access_code: string; expires_at: string }[] | null
  )?.[0];
  if (!row) return fail({ kind: "unexpected", message: "The signing link was not returned." });
  return ok({
    tokenId: row.token_id,
    token: row.token,
    accessCode: row.access_code,
    expiresAt: row.expires_at,
  });
}

export async function listOnboardingStatus(
  db: XosClient,
  filter: { engagementId?: string; orgId?: string },
): Promise<Result<OnboardingStatus[]>> {
  let query = db.from("onboarding_item_status").select("*");
  if (filter.engagementId) query = query.eq("engagement_id", filter.engagementId);
  if (filter.orgId) query = query.eq("org_id", filter.orgId);
  const { data, error } = await query.order("name");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      itemId: r.onboarding_item_id ?? "",
      engagementId: r.engagement_id ?? "",
      requirementId: r.onboarding_requirement_id ?? "",
      name: r.name ?? "",
      kind: (r.item_kind ?? "Form") as OnboardingItemKind,
      blocking: Boolean(r.is_blocking),
      method: (r.verification_method ?? "Reviewer") as VerificationMethod,
      submittedAt: r.submitted_at,
      latestOutcome: r.latest_outcome,
      expiresOn: r.expires_on,
      passes: Boolean(r.passes),
      carriedOver: Boolean(r.carried_over),
      reminderDue: Boolean(r.reminder_due),
    })),
  );
}

/** A reviewer verifies an onboarding item; the database refuses the engaged party and automatic items. */
export async function verifyOnboardingItem(
  db: XosClient,
  input: { itemId: string; outcome: VerificationOutcome; note?: string | null },
): Promise<Result<null>> {
  const { error } = await db.from("onboarding_verifications").insert({
    onboarding_item_id: input.itemId,
    outcome: input.outcome,
    note: input.note ?? null,
  } as unknown as Database["app"]["Tables"]["onboarding_verifications"]["Insert"]);
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function listDeliverables(
  db: XosClient,
  engagementId: string,
): Promise<Result<Deliverable[]>> {
  const { data, error } = await db
    .from("engagement_deliverables")
    .select(
      "id, record_id, deliverable_state, submitted_at, submission_message, return_reason, fee_minor, record:records(title)",
    )
    .eq("engagement_id", engagementId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as unknown as {
        id: string;
        record_id: string;
        deliverable_state: DeliverableState;
        submitted_at: string | null;
        submission_message: string | null;
        return_reason: string | null;
        fee_minor: number | null;
        record: { title: string } | null;
      }[]
    ).map((d) => ({
      id: d.id,
      recordId: d.record_id,
      title: d.record?.title ?? null,
      state: d.deliverable_state,
      submittedAt: d.submitted_at,
      submissionMessage: d.submission_message,
      returnReason: d.return_reason,
      feeMinor: d.fee_minor,
    })),
  );
}

/** Sets or clears (null, unpriced) a milestone's fee until it is accepted (app.set_deliverable_fee). */
export async function setDeliverableFee(
  db: XosClient,
  id: string,
  feeMinor: number | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_deliverable_fee", {
    p_deliverable_id: id,
    ...(feeMinor === null ? {} : { p_fee_minor: feeMinor }),
  });
  return rpcResult(null, error);
}

export async function decideDeliverable(
  db: XosClient,
  id: string,
  decision: ApprovalDecision,
  reason: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("decide_deliverable", {
    p_deliverable_id: id,
    p_decision: decision,
    p_reason: reason as string,
  });
  return rpcResult(null, error);
}

// Ratings -------------------------------------------------------------------------------------------------------------------------

export async function listRatings(db: XosClient, orgId: string): Promise<Result<Rating[]>> {
  const { data, error } = await db
    .from("ratings")
    .select(
      "id, engagement_id, rater_side, score, comment, submitted_at, replies:rating_replies(body, deleted_at)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("submitted_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as unknown as {
        id: string;
        engagement_id: string;
        rater_side: Enums["rating_side"];
        score: number;
        comment: string | null;
        submitted_at: string;
        replies: { body: string; deleted_at: string | null }[] | null;
      }[]
    ).map((r) => ({
      id: r.id,
      engagementId: r.engagement_id,
      side: r.rater_side,
      score: r.score,
      comment: r.comment,
      submittedAt: r.submitted_at,
      reply: (r.replies ?? []).find((x) => x.deleted_at === null)?.body ?? null,
    })),
  );
}

/** The org rates the party of a completed engagement; both ratings release together (ADR 0019 item 6). */
export async function rateParty(
  db: XosClient,
  input: { engagementId: string; score: number; comment?: string | null },
): Promise<Result<null>> {
  const { error } = await db.from("ratings").insert({
    engagement_id: input.engagementId,
    rater_side: "Organization",
    score: input.score,
    comment: input.comment ?? null,
  } as unknown as Database["app"]["Tables"]["ratings"]["Insert"]);
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** The org replies once, publicly, to the party's released rating. */
export async function replyToRating(
  db: XosClient,
  ratingId: string,
  body: string,
): Promise<Result<null>> {
  const { error } = await db.from("rating_replies").insert({
    rating_id: ratingId,
    body,
  } as unknown as Database["app"]["Tables"]["rating_replies"]["Insert"]);
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Onboarding requirements ----------------------------------------------------------------------------------------------------------

export async function listOnboardingRequirements(
  db: XosClient,
  orgId: string,
): Promise<Result<OnboardingRequirement[]>> {
  const { data, error } = await db
    .from("onboarding_requirements")
    .select(
      "id, name, item_kind, role_type, jurisdiction_id, verification_method, is_blocking, valid_for_days, remind_days_before",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.item_kind,
      roleType: r.role_type,
      jurisdictionId: r.jurisdiction_id,
      method: r.verification_method,
      blocking: r.is_blocking,
      validForDays: r.valid_for_days,
      remindDaysBefore: r.remind_days_before,
    })),
  );
}

export async function createOnboardingRequirement(
  db: XosClient,
  input: OnboardingRequirementInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("onboarding_requirements")
    .insert({
      org_id: input.orgId,
      name: input.name,
      item_kind: input.kind,
      role_type: input.roleType ?? null,
      jurisdiction_id: input.jurisdictionId ?? null,
      verification_method: input.method,
      is_blocking: input.blocking,
      valid_for_days: input.validForDays ?? null,
      remind_days_before: input.remindDaysBefore ?? null,
    } as unknown as Database["app"]["Tables"]["onboarding_requirements"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

// Pools ------------------------------------------------------------------------------------------------------------------------------

export async function listPools(db: XosClient, orgId: string): Promise<Result<TalentPool[]>> {
  const { data, error } = await db
    .from("talent_pools")
    .select("id, name, pool_kind, members:pool_members(id, deleted_at)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as unknown as {
        id: string;
        name: string;
        pool_kind: PoolKind;
        members: { id: string; deleted_at: string | null }[] | null;
      }[]
    ).map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.pool_kind,
      memberCount: (p.members ?? []).filter((m) => m.deleted_at === null).length,
    })),
  );
}

export async function createPool(
  db: XosClient,
  input: { orgId: string; name: string; kind: PoolKind },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("talent_pools")
    .insert({
      org_id: input.orgId,
      name: input.name,
      pool_kind: input.kind,
    } as unknown as Database["app"]["Tables"]["talent_pools"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/**
 * Members of a pool with names. Person names come from the engagement board, so only people the org has engaged or
 * received an application from are named; pool rows themselves never leave the org (Section 4.4.3).
 */
export async function listPoolMembers(
  db: XosClient,
  poolId: string,
): Promise<Result<PoolMember[]>> {
  const { data, error } = await db
    .from("pool_members")
    .select("id, talent_pool_id, person_id, organization_id, standing, reason, review_on")
    .eq("talent_pool_id", poolId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const rows = data ?? [];
  const personIds = rows.flatMap((r) => (r.person_id ? [r.person_id] : []));
  const orgIds = rows.flatMap((r) => (r.organization_id ? [r.organization_id] : []));
  const names = new Map<string, string>();
  if (personIds.length > 0 || orgIds.length > 0) {
    const [engaged, applied] = await Promise.all([
      db.from("engagement_board").select("person_id, account_id, party_name, account_name"),
      db
        .from("application_board")
        .select("applicant_person_id, applicant_organization_id, applicant_name"),
    ]);
    if (engaged.error) return fail(toDataError(engaged.error));
    if (applied.error) return fail(toDataError(applied.error));
    for (const e of engaged.data ?? []) {
      if (e.person_id && e.party_name) names.set(e.person_id, e.party_name);
      if (e.account_id && e.account_name) names.set(e.account_id, e.account_name);
    }
    for (const a of applied.data ?? []) {
      const key = a.applicant_person_id ?? a.applicant_organization_id;
      if (key && a.applicant_name && !names.has(key)) names.set(key, a.applicant_name);
    }
  }
  return ok(
    rows.map((r) => ({
      id: r.id,
      poolId: r.talent_pool_id,
      personId: r.person_id,
      organizationId: r.organization_id,
      name: names.get(r.person_id ?? r.organization_id ?? "") ?? null,
      standing: r.standing,
      reason: r.reason,
      reviewOn: r.review_on,
    })),
  );
}

/** Adds a person or account to a pool; Do Not Engage needs a reason and a review date (Section 4.4.3). */
export async function addPoolMember(
  db: XosClient,
  input: {
    poolId: string;
    party: { personId: string } | { organizationId: string };
    standing: PoolStanding;
    reason?: string | null;
    reviewOn?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const party =
    "personId" in input.party
      ? { person_id: input.party.personId }
      : { organization_id: input.party.organizationId };
  const { data, error } = await db
    .from("pool_members")
    .insert({
      talent_pool_id: input.poolId,
      ...party,
      standing: input.standing,
      reason: input.reason ?? null,
      review_on: input.reviewOn ?? null,
    } as unknown as Database["app"]["Tables"]["pool_members"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function setPoolStanding(
  db: XosClient,
  memberId: string,
  input: { standing: PoolStanding; reason?: string | null; reviewOn?: string | null },
): Promise<Result<null>> {
  const { error } = await db
    .from("pool_members")
    .update({
      standing: input.standing,
      reason: input.reason ?? null,
      review_on: input.reviewOn ?? null,
    })
    .eq("id", memberId);
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function removePoolMember(db: XosClient, memberId: string): Promise<Result<null>> {
  const { error } = await db
    .from("pool_members")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", memberId);
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Marketplace settings ---------------------------------------------------------------------------------------------------------------

export async function listListingReports(
  db: XosClient,
  orgId: string,
): Promise<Result<ListingReport[]>> {
  const { data, error } = await db
    .from("listing_reports")
    .select("id, opportunity_id, reason, details, reported_at, opportunity:opportunities(title)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("reported_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as unknown as {
        id: string;
        opportunity_id: string;
        reason: Enums["listing_report_reason"];
        details: string | null;
        reported_at: string;
        opportunity: { title: string } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      opportunityId: r.opportunity_id,
      opportunityTitle: r.opportunity?.title ?? null,
      reason: r.reason,
      details: r.details,
      reportedAt: r.reported_at,
    })),
  );
}

export async function listPayTransparencyRules(
  db: XosClient,
): Promise<
  Result<
    { jurisdictionId: string; requiresPayRange: boolean; effectiveFrom: string; citation: string }[]
  >
> {
  const { data, error } = await db
    .from("pay_transparency_rules")
    .select("jurisdiction_id, requires_pay_range, effective_from, citation")
    .order("jurisdiction_id");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      jurisdictionId: r.jurisdiction_id ?? "",
      requiresPayRange: Boolean(r.requires_pay_range),
      effectiveFrom: r.effective_from ?? "",
      citation: r.citation ?? "",
    })),
  );
}
