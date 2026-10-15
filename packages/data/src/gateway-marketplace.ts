import type { XosClient } from "./client.ts";
import {
  derivedRow,
  external,
  req,
  type ApplicationState,
  type ExternalRoleType,
  type ExternalRow,
  type InterviewKind,
  type ListingReportReason,
  type OpportunityRequirementKind,
  type OpportunityState,
  type OpportunityVisibility,
  type RateType,
} from "./gateway-external.ts";
import { toDisplayKey } from "./gateway-keys.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Gateway marketplace repository (Section 4.4.3): opportunities open to the caller, applications,
 * sealed bids, agency slates, interviews and listing reports. Reads use `api_external`; writes use
 * the column grants of migration 0720, whose triggers refuse a closed deadline, a hidden listing
 * and a Do Not Engage flag with the same refusal, so the flag never shows.
 */

export interface Opportunity {
  readonly id: string;
  readonly key: string;
  readonly orgId: string;
  readonly orgName: string;
  /** The org's identity is verified (A28b 1001): a trust signal shown on every card. */
  readonly orgVerified: boolean;
  readonly title: string;
  readonly description: string | null;
  readonly roleType: ExternalRoleType;
  readonly roleCode: string | null;
  readonly catUrid: string | null;
  readonly venueName: string | null;
  /** The venue's city or locality, the place shown when there is no venue name. */
  readonly venueLocality: string | null;
  readonly jurisdictionId: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly visibility: OpportunityVisibility;
  readonly rateType: RateType | null;
  readonly payMinMinor: number | null;
  readonly payMaxMinor: number | null;
  readonly currency: string | null;
  /** True when no compensation is posted: the UI shows Rate on Request, never zero. */
  readonly rateOnRequest: boolean;
  readonly deadlineAt: string | null;
  readonly minimumAge: number | null;
  readonly state: OpportunityState;
  readonly positionCount: number;
}

const OPPORTUNITY_COLUMNS =
  "id, org_id, org_name, title, description, role_type, role_code, cat_urid, venue_name, jurisdiction_id, starts_on, ends_on, visibility, rate_type, pay_min_minor, pay_max_minor, currency_code, rate_on_request, deadline_at, minimum_age, opportunity_state, position_count, org_verified, venue_locality";

function toOpportunity(row: ExternalRow<"opportunities">): Opportunity {
  const id = req(row.id, "opportunities.id");
  return {
    id,
    key: toDisplayKey("opportunity", id),
    orgId: req(row.org_id, "opportunities.org_id"),
    orgName: req(row.org_name, "opportunities.org_name"),
    orgVerified: row.org_verified ?? false,
    title: req(row.title, "opportunities.title"),
    description: row.description,
    roleType: req(row.role_type, "opportunities.role_type"),
    roleCode: row.role_code,
    catUrid: row.cat_urid,
    venueName: row.venue_name,
    venueLocality: row.venue_locality,
    jurisdictionId: row.jurisdiction_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    visibility: req(row.visibility, "opportunities.visibility"),
    rateType: row.rate_type,
    payMinMinor: row.pay_min_minor,
    payMaxMinor: row.pay_max_minor,
    currency: row.currency_code,
    rateOnRequest: row.rate_on_request ?? row.rate_type === null,
    deadlineAt: row.deadline_at,
    minimumAge: row.minimum_age,
    state: req(row.opportunity_state, "opportunities.opportunity_state"),
    positionCount: row.position_count ?? 0,
  };
}

export interface OpportunityFilter {
  /** Words matched against the title and description. */
  readonly query?: string;
  readonly roleTypes?: readonly ExternalRoleType[];
  readonly startsAfter?: string;
  readonly endsBefore?: string;
  /** Lowest acceptable posted pay in minor units; Rate on Request listings stay in. */
  readonly minPayMinor?: number;
  /** Only this org (a white-label Gateway, Section 4.4.7). */
  readonly orgId?: string;
  /** Only the org of this name, when a white-label host names the org but not its id. */
  readonly orgName?: string;
  readonly limit?: number;
}

/** Characters PostgREST treats as filter syntax inside `or()` values. */
function safeTerm(term: string): string {
  return term.replace(/[%,()*\\]/g, " ").trim();
}

/**
 * Published opportunities open to the caller, soonest first. Ranking factors are public (Section
 * 4.4.3, How ranking works): the deadline and start date only; no placement can be bought.
 */
export async function searchOpportunities(
  db: XosClient,
  filter: OpportunityFilter = {},
): Promise<Result<Opportunity[]>> {
  let query = external(db)
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("opportunity_state", "Published");
  const term = filter.query ? safeTerm(filter.query) : "";
  if (term.length > 0) query = query.or(`title.ilike.*${term}*,description.ilike.*${term}*`);
  if (filter.roleTypes && filter.roleTypes.length > 0)
    query = query.in("role_type", filter.roleTypes);
  if (filter.startsAfter) query = query.gte("starts_on", filter.startsAfter);
  if (filter.endsBefore) query = query.lte("ends_on", filter.endsBefore);
  if (filter.minPayMinor !== undefined) {
    query = query.or(
      `rate_on_request.is.true,pay_max_minor.gte.${filter.minPayMinor},pay_min_minor.gte.${filter.minPayMinor}`,
    );
  }
  if (filter.orgId) query = query.eq("org_id", filter.orgId);
  if (filter.orgName) query = query.eq("org_name", filter.orgName);
  const { data, error } = await query
    .order("deadline_at", { ascending: true, nullsFirst: false })
    .order("starts_on", { ascending: true, nullsFirst: false })
    .limit(filter.limit ?? 100);
  if (error) return fail(toDataError(error));
  return ok(data.map(toOpportunity));
}

export interface OpportunityPosition {
  readonly id: string;
  readonly label: string;
  readonly callAt: string | null;
  readonly endsAt: string | null;
}

export interface OpportunityQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly required: boolean;
}

export interface OpportunityRequirement {
  readonly id: string;
  readonly kind: OpportunityRequirementKind;
  readonly description: string | null;
  readonly certificationName: string | null;
  /** True when the caller holds a current certification that meets it; null when not checkable. */
  readonly callerHolds: boolean | null;
  readonly insuranceMinimumMinor: number | null;
  readonly currency: string | null;
}

export interface OpportunityDetail extends Opportunity {
  readonly positions: readonly OpportunityPosition[];
  readonly questions: readonly OpportunityQuestion[];
  readonly requirements: readonly OpportunityRequirement[];
}

/** One opportunity with its positions, questions and requirements; not-found when not open. */
export async function getOpportunity(
  db: XosClient,
  id: string,
): Promise<Result<OpportunityDetail>> {
  const x = external(db);
  const [opp, positions, questions, requirements] = await Promise.all([
    x.from("opportunities").select(OPPORTUNITY_COLUMNS).eq("id", id).maybeSingle(),
    x
      .from("opportunity_positions")
      .select("id, opportunity_id, label, call_at, ends_at")
      .eq("opportunity_id", id)
      .order("call_at", { ascending: true }),
    x
      .from("opportunity_questions")
      .select("id, opportunity_id, prompt, sort_order, is_required")
      .eq("opportunity_id", id)
      .order("sort_order", { ascending: true }),
    x
      .from("opportunity_requirements")
      .select(
        "id, opportunity_id, requirement_kind, description, certification_name, caller_holds, insurance_minimum_minor, currency_code",
      )
      .eq("opportunity_id", id),
  ]);
  const error = opp.error ?? positions.error ?? questions.error ?? requirements.error;
  if (error) return fail(toDataError(error));
  if (!opp.data) return fail({ kind: "not-found" });
  return ok({
    ...toOpportunity(opp.data),
    positions: (positions.data ?? []).map((p) => ({
      id: req(p.id, "opportunity_positions.id"),
      label: req(p.label, "opportunity_positions.label"),
      callAt: p.call_at,
      endsAt: p.ends_at,
    })),
    questions: (questions.data ?? []).map((q) => ({
      id: req(q.id, "opportunity_questions.id"),
      prompt: req(q.prompt, "opportunity_questions.prompt"),
      required: q.is_required ?? false,
    })),
    requirements: (requirements.data ?? []).map((r) => ({
      id: req(r.id, "opportunity_requirements.id"),
      kind: req(r.requirement_kind, "opportunity_requirements.requirement_kind"),
      description: r.description,
      certificationName: r.certification_name,
      callerHolds: r.requirement_kind === "Certification" ? (r.caller_holds ?? false) : null,
      insuranceMinimumMinor: r.insurance_minimum_minor,
      currency: r.currency_code,
    })),
  });
}

/** Whether an opportunity still takes applications at `now`. */
export function acceptsApplications(
  o: Pick<Opportunity, "state" | "deadlineAt">,
  now: Date = new Date(),
): boolean {
  return o.state === "Published" && (o.deadlineAt === null || new Date(o.deadlineAt) > now);
}

/** How the role type applies (Section 4.4.3 Applying): people, vendor bids, artist EPKs, agency slates. */
export type ApplicationMode = "person" | "bid" | "artist" | "slate";

export function applicationMode(
  roleType: ExternalRoleType,
  rateType: RateType | null,
  asAccount: boolean,
): ApplicationMode {
  if (roleType === "Vendor" || rateType === "Bid") return "bid";
  if (roleType === "Artist") return "artist";
  if (roleType === "Staff" && asAccount) return "slate";
  return "person";
}

// Applications ------------------------------------------------------------------------------------

export interface Application {
  readonly id: string;
  readonly key: string;
  readonly opportunityId: string;
  readonly applicantPersonId: string | null;
  readonly applicantOrganizationId: string | null;
  readonly availabilityConfirmed: boolean;
  readonly coverNote: string | null;
  readonly proposedFeeMinor: number | null;
  readonly currency: string | null;
  readonly state: ApplicationState;
  readonly submittedAt: string;
}

function toApplication(row: ExternalRow<"applications">): Application {
  const id = req(row.id, "applications.id");
  return {
    id,
    key: toDisplayKey("application", id),
    opportunityId: req(row.opportunity_id, "applications.opportunity_id"),
    applicantPersonId: row.applicant_person_id,
    applicantOrganizationId: row.applicant_organization_id,
    availabilityConfirmed: row.availability_confirmed ?? false,
    coverNote: row.cover_note,
    proposedFeeMinor: row.proposed_fee_minor,
    currency: row.currency_code,
    state: req(row.application_state, "applications.application_state"),
    submittedAt: req(row.submitted_at, "applications.submitted_at"),
  };
}

export interface ApplicationWithOpportunity extends Application {
  readonly opportunity: Opportunity | null;
  readonly interviews: readonly Interview[];
  readonly bid: Bid | null;
}

export interface Interview {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: InterviewKind;
  readonly scheduledAt: string;
  readonly durationMinutes: number | null;
  readonly location: string | null;
}

export interface BidLine {
  readonly id: string;
  readonly description: string;
  readonly quantity: number;
  /** Unit price in minor units; null when the line is not priced (never zero). */
  readonly unitPriceMinor: number | null;
}

export interface Bid {
  readonly id: string;
  readonly applicationId: string;
  readonly currency: string;
  readonly validUntil: string | null;
  readonly submittedAt: string;
  readonly lines: readonly BidLine[];
}

/** The caller's applications with their opportunity, interviews and own sealed bid, newest first. */
export async function listMyApplications(
  db: XosClient,
): Promise<Result<ApplicationWithOpportunity[]>> {
  const x = external(db);
  const apps = await x
    .from("applications")
    .select(
      "id, opportunity_id, applicant_person_id, applicant_organization_id, submitted_by, availability_confirmed, cover_note, proposed_fee_minor, currency_code, application_state, submitted_at",
    )
    .order("submitted_at", { ascending: false });
  if (apps.error) return fail(toDataError(apps.error));
  const applications = apps.data.map(toApplication);
  if (applications.length === 0) return ok([]);
  const appIds = applications.map((a) => a.id);
  const oppIds = [...new Set(applications.map((a) => a.opportunityId))];
  const [opps, interviews, bids] = await Promise.all([
    x.from("opportunities").select(OPPORTUNITY_COLUMNS).in("id", oppIds),
    x
      .from("interviews")
      .select("id, application_id, interview_kind, scheduled_at, duration_minutes, location_text")
      .in("application_id", appIds)
      .order("scheduled_at", { ascending: true }),
    x
      .from("bids")
      .select("id, application_id, currency_code, valid_until, submitted_at")
      .in("application_id", appIds),
  ]);
  const error = opps.error ?? interviews.error ?? bids.error;
  if (error) return fail(toDataError(error));
  const bidIds = (bids.data ?? []).map((b) => req(b.id, "bids.id"));
  const lines =
    bidIds.length === 0
      ? { data: [], error: null }
      : await x
          .from("bid_lines")
          .select("id, bid_id, description, element_id, quantity, unit_price_minor")
          .in("bid_id", bidIds);
  if (lines.error) return fail(toDataError(lines.error));
  const oppById = new Map((opps.data ?? []).map((o) => [o.id, toOpportunity(o)]));
  return ok(
    applications.map((a) => {
      const bidRow = (bids.data ?? []).find((b) => b.application_id === a.id);
      return {
        ...a,
        opportunity: oppById.get(a.opportunityId) ?? null,
        interviews: (interviews.data ?? [])
          .filter((i) => i.application_id === a.id)
          .map((i) => ({
            id: req(i.id, "interviews.id"),
            applicationId: a.id,
            kind: req(i.interview_kind, "interviews.interview_kind"),
            scheduledAt: req(i.scheduled_at, "interviews.scheduled_at"),
            durationMinutes: i.duration_minutes,
            location: i.location_text,
          })),
        bid: bidRow
          ? {
              id: req(bidRow.id, "bids.id"),
              applicationId: a.id,
              currency: req(bidRow.currency_code, "bids.currency_code"),
              validUntil: bidRow.valid_until,
              submittedAt: req(bidRow.submitted_at, "bids.submitted_at"),
              lines: (lines.data ?? [])
                .filter((l) => l.bid_id === bidRow.id)
                .map((l) => ({
                  id: req(l.id, "bid_lines.id"),
                  description: req(l.description, "bid_lines.description"),
                  quantity: req(l.quantity, "bid_lines.quantity"),
                  unitPriceMinor: l.unit_price_minor,
                })),
            }
          : null,
      };
    }),
  );
}

/** Application states in which the person still has something to decide or wait on. */
export const OPEN_APPLICATION_STATES: readonly ApplicationState[] = [
  "Submitted",
  "In Review",
  "Shortlisted",
  "Offered",
];

/** Moves the caller's own application: Withdrawn, or Accepted and Declined from an offer. */
export async function decideApplication(
  db: XosClient,
  input: {
    readonly applicationId: string;
    readonly expected: ApplicationState;
    readonly next: "Withdrawn" | "Accepted" | "Declined";
    readonly reason: string;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("transition_application", {
    p_application_id: input.applicationId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface ApplyInput {
  readonly opportunityId: string;
  /** The person applying for themselves or for a represented artist; null when an account applies. */
  readonly applicantPersonId: string | null;
  readonly applicantOrganizationId: string | null;
  readonly profileShareId: string | null;
  readonly availabilityConfirmed: boolean;
  readonly coverNote: string | null;
  readonly proposedFeeMinor: number | null;
  readonly currency: string | null;
  readonly answers: readonly { readonly questionId: string; readonly text: string }[];
}

/** Submits an application and its answers (Section 4.4.3, one step with the profile snapshot). */
export async function applyToOpportunity(
  db: XosClient,
  input: ApplyInput,
): Promise<Result<{ applicationId: string }>> {
  const { data, error } = await db
    .from("applications")
    .insert(
      derivedRow<"applications">({
        opportunity_id: input.opportunityId,
        applicant_person_id: input.applicantPersonId,
        applicant_organization_id: input.applicantOrganizationId,
        profile_share_id: input.profileShareId,
        availability_confirmed: input.availabilityConfirmed,
        cover_note: input.coverNote,
        proposed_fee_minor: input.proposedFeeMinor,
        currency_code: input.proposedFeeMinor === null ? null : input.currency,
      }),
    )
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  const answers = input.answers.filter((a) => a.text.trim().length > 0);
  if (answers.length > 0) {
    const inserted = await db.from("application_answers").insert(
      answers.map((a) =>
        derivedRow<"application_answers">({
          application_id: data.id,
          opportunity_question_id: a.questionId,
          answer_text: a.text.trim(),
        }),
      ),
    );
    if (inserted.error) return fail(toDataError(inserted.error));
  }
  return ok({ applicationId: data.id });
}

/** A vendor's sealed bid with its line items; sealed until the deadline (Section 8.7). */
export async function submitBid(
  db: XosClient,
  input: {
    readonly applicationId: string;
    readonly currency: string;
    readonly validUntil: string | null;
    readonly lines: readonly {
      readonly description: string;
      readonly quantity: number;
      readonly unitPriceMinor: number | null;
    }[];
  },
): Promise<Result<{ bidId: string }>> {
  const { data, error } = await db
    .from("bids")
    .insert(
      derivedRow<"bids">({
        application_id: input.applicationId,
        currency_code: input.currency,
        valid_until: input.validUntil,
      }),
    )
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  if (input.lines.length > 0) {
    const inserted = await db.from("bid_lines").insert(
      input.lines.map((l) =>
        derivedRow<"bid_lines">({
          bid_id: data.id,
          description: l.description.trim(),
          quantity: l.quantity,
          unit_price_minor: l.unitPriceMinor,
        }),
      ),
    );
    if (inserted.error) return fail(toDataError(inserted.error));
  }
  return ok({ bidId: data.id });
}

/** A staffing agency's slate: named members of its account put forward on its application. */
export async function submitSlate(
  db: XosClient,
  input: { readonly applicationId: string; readonly personIds: readonly string[] },
): Promise<Result<null>> {
  if (input.personIds.length === 0) return ok(null);
  const { error } = await db
    .from("agency_slates")
    .insert(
      input.personIds.map((p) =>
        derivedRow<"agency_slates">({ application_id: input.applicationId, person_id: p }),
      ),
    );
  return error ? fail(toDataError(error)) : ok(null);
}

/** The sum of priced bid lines; null when any line is unpriced (Section 3.7: blanks stay blank). */
export function bidTotal(
  lines: readonly Pick<BidLine, "quantity" | "unitPriceMinor">[],
): number | null {
  let total = 0;
  for (const l of lines) {
    if (l.unitPriceMinor === null) return null;
    total += Math.round(l.quantity * l.unitPriceMinor);
  }
  return total;
}

// Saved searches and reports ----------------------------------------------------------------------

/** Saves a marketplace search; alerts go out by email and push when enabled. */
export async function saveSearch(
  db: XosClient,
  input: {
    readonly personId: string;
    readonly name: string;
    readonly roleType: ExternalRoleType | null;
    readonly startsAfter: string | null;
    readonly endsBefore: string | null;
    readonly orgId: string | null;
  },
): Promise<Result<{ savedSearchId: string }>> {
  const { data, error } = await db
    .from("saved_searches")
    .insert({
      person_id: input.personId,
      name: input.name.trim(),
      role_type: input.roleType,
      starts_after: input.startsAfter,
      ends_before: input.endsBefore,
      org_id: input.orgId,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ savedSearchId: data.id });
}

/** Reports a listing under notice and action (Section 4.4.3 abuse). */
export async function reportListing(
  db: XosClient,
  input: {
    readonly opportunityId: string;
    readonly reason: ListingReportReason;
    readonly details: string | null;
  },
): Promise<Result<null>> {
  const { error } = await db.from("listing_reports").insert(
    derivedRow<"listing_reports", "reporter_person_id">({
      opportunity_id: input.opportunityId,
      reason: input.reason,
      details: input.details && input.details.trim().length > 0 ? input.details.trim() : null,
    }),
  );
  return error ? fail(toDataError(error)) : ok(null);
}

export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  readonly roleType: ExternalRoleType | null;
  readonly startsAfter: string | null;
  readonly endsBefore: string | null;
  readonly alertsEnabled: boolean;
}

/** The caller's saved searches (api_external.my_saved_searches), by name. */
export async function listMySavedSearches(db: XosClient): Promise<Result<SavedSearch[]>> {
  const { data, error } = await external(db)
    .from("my_saved_searches")
    .select("id, name, role_type, starts_after, ends_before, alerts_enabled")
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "my_saved_searches.id"),
      name: req(row.name, "my_saved_searches.name"),
      roleType: row.role_type,
      startsAfter: row.starts_after,
      endsBefore: row.ends_before,
      alertsEnabled: row.alerts_enabled ?? false,
    })),
  );
}

export interface SavedOpportunity {
  readonly id: string;
  readonly opportunityId: string;
  readonly savedAt: string;
  /** False once the opportunity stops taking applications. */
  readonly open: boolean;
}

/** Opportunities the caller saved (api_external.my_saved_opportunities), newest first. */
export async function listSavedOpportunities(db: XosClient): Promise<Result<SavedOpportunity[]>> {
  const { data, error } = await external(db)
    .from("my_saved_opportunities")
    .select("id, opportunity_id, saved_at, is_open")
    .order("saved_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "my_saved_opportunities.id"),
      opportunityId: req(row.opportunity_id, "my_saved_opportunities.opportunity_id"),
      savedAt: req(row.saved_at, "my_saved_opportunities.saved_at"),
      open: row.is_open ?? false,
    })),
  );
}

/** Saves an opportunity to come back to (Section 11.12: swipe right to save). */
export async function saveOpportunity(
  db: XosClient,
  input: { readonly personId: string; readonly opportunityId: string },
): Promise<Result<null>> {
  const { error } = await db.from("saved_opportunities").insert(
    derivedRow<"saved_opportunities">({
      person_id: input.personId,
      opportunity_id: input.opportunityId,
    }),
  );
  return error ? fail(toDataError(error)) : ok(null);
}

/** Removes a saved opportunity (soft delete). */
export async function unsaveOpportunity(db: XosClient, savedId: string): Promise<Result<null>> {
  const { error } = await db
    .from("saved_opportunities")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", savedId);
  return error ? fail(toDataError(error)) : ok(null);
}

/** Opportunities by id, for the saved list and offers. */
export async function listOpportunitiesById(
  db: XosClient,
  ids: readonly string[],
): Promise<Result<Opportunity[]>> {
  if (ids.length === 0) return ok([]);
  const { data, error } = await external(db)
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .in("id", ids);
  if (error) return fail(toDataError(error));
  return ok(data.map(toOpportunity));
}

/** Turns a saved search's alerts on or off. */
export async function setSavedSearchAlerts(
  db: XosClient,
  input: { readonly id: string; readonly enabled: boolean },
): Promise<Result<null>> {
  const { error } = await db
    .from("saved_searches")
    .update({ alerts_enabled: input.enabled })
    .eq("id", input.id);
  return error ? fail(toDataError(error)) : ok(null);
}

/** Removes a saved search (soft delete). */
export async function removeSavedSearch(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("saved_searches")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}
