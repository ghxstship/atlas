import type { Database, XosClient } from "./client";
import type { DatabaseErrorLike } from "./result";

/**
 * The `api_external` projections (migration 0750, ADR 0019 item 5): the only path by which Gateway
 * reads engagement data. Each view allowlists its columns and filters rows with the Section 8.7
 * helpers, so internal notes, margins, other parties' rates, internal ratings and Do Not Engage
 * flags never reach an external user.
 *
 * The generated database types cover the `app` and `xpms` schemas only, so the row shapes below
 * restate the view columns from 0750 until `api_external` is added to the type generator; the enum
 * types come from the generated `app` enums so no closed list is redefined here.
 */

type Enums = Database["app"]["Enums"];

export type ExternalRoleType = Enums["external_role_type"];
export type EngagementState = Enums["engagement_state"];
export type EngagementDocumentKind = Enums["engagement_document_kind"];
export type EngagementDocumentState = Enums["engagement_document_state"];
export type ApplicationState = Enums["application_state"];
export type OpportunityState = Enums["opportunity_state"];
export type OpportunityVisibility = Enums["opportunity_visibility"];
export type RateType = Enums["rate_type"];
export type OpportunityRequirementKind = Enums["opportunity_requirement_kind"];
export type AccountRole = Enums["account_role"];
export type RepresentationScope = Enums["representation_scope"];
export type OnboardingItemKind = Enums["onboarding_item_kind"];
export type VerificationMethod = Enums["verification_method"];
export type VerificationOutcome = Enums["verification_outcome"];
export type TaxFormKind = Enums["tax_form_kind"];
export type PayoutProvider = Enums["payout_provider"];
export type RatingSide = Enums["rating_side"];
export type AvailabilityKind = Enums["availability_kind"];
export type AvailabilityVisibility = Enums["availability_visibility"];
export type ListingReportReason = Enums["listing_report_reason"];
export type InterviewKind = Enums["interview_kind"];
export type PaymentState = Database["app"]["Tables"]["payments"]["Row"]["payment_state"];
export type RecordKind = Database["app"]["Tables"]["records"]["Row"]["record_kind"];
export type RecordState = Database["app"]["Tables"]["records"]["Row"]["record_state"];

/** Section 8.7 areas a caller may have open on an engagement. */
export type EngagementArea = "engagement" | "documents" | "onboarding" | "operational" | "money";

export interface ExternalViews {
  engagements: {
    id: string;
    org_id: string;
    org_name: string;
    project_id: string;
    project_name: string;
    role_type: ExternalRoleType;
    role_code: string;
    job_title: string;
    person_id: string | null;
    account_id: string | null;
    pay_basis: string;
    arrangement: string;
    rate_minor: number | null;
    rate_currency_code: string | null;
    start_date: string;
    end_date: string | null;
    engagement_state: EngagementState;
    areas: EngagementArea[];
  };
  engagement_documents: {
    id: string;
    engagement_id: string;
    document_kind: EngagementDocumentKind;
    title: string;
    document_id: string | null;
    expires_on: string | null;
    engagement_document_state: EngagementDocumentState;
  };
  onboarding_items: {
    id: string;
    engagement_id: string;
    name: string;
    item_kind: OnboardingItemKind;
    is_blocking: boolean;
    verification_method: VerificationMethod;
    submitted_at: string | null;
    latest_outcome: VerificationOutcome | null;
    expires_on: string | null;
    passes: boolean;
    satisfied: boolean;
  };
  engagement_threads: { id: string; engagement_id: string; subject: string; created_at: string };
  engagement_messages: {
    id: string;
    engagement_thread_id: string;
    author_person_id: string | null;
    author_name: string | null;
    body: string;
    sent_at: string;
  };
  records: {
    id: string;
    project_id: string;
    record_kind: RecordKind;
    record_subtype: string | null;
    record_state: RecordState;
    title: string;
    starts_at: string | null;
    ends_at: string | null;
    due_at: string | null;
    time_zone: string | null;
  };
  payments: {
    id: string;
    org_id: string;
    org_name: string;
    account_id: string;
    amount_minor: number;
    currency_code: string;
    paid_on: string | null;
    reference_identifier: string | null;
    payment_state: PaymentState;
  };
  tax_forms: {
    id: string;
    org_id: string;
    org_name: string;
    person_id: string | null;
    account_id: string | null;
    form_kind: TaxFormKind;
    tin_last4: string;
    foreign_performer_withholding: boolean;
    signed_at: string;
  };
  payout_accounts: {
    id: string;
    org_id: string;
    person_id: string | null;
    account_id: string | null;
    provider: PayoutProvider;
    account_last4: string | null;
  };
  opportunities: {
    id: string;
    org_id: string;
    org_name: string;
    title: string;
    description: string | null;
    role_type: ExternalRoleType;
    role_code: string | null;
    cat_urid: string | null;
    venue_name: string | null;
    jurisdiction_id: string | null;
    starts_on: string | null;
    ends_on: string | null;
    visibility: OpportunityVisibility;
    rate_type: RateType | null;
    pay_min_minor: number | null;
    pay_max_minor: number | null;
    currency_code: string | null;
    rate_on_request: boolean;
    deadline_at: string | null;
    minimum_age: number | null;
    opportunity_state: OpportunityState;
    position_count: number;
  };
  opportunity_positions: {
    id: string;
    opportunity_id: string;
    label: string;
    call_at: string | null;
    ends_at: string | null;
  };
  opportunity_questions: {
    id: string;
    opportunity_id: string;
    prompt: string;
    sort_order: number;
    is_required: boolean;
  };
  opportunity_requirements: {
    id: string;
    opportunity_id: string;
    requirement_kind: OpportunityRequirementKind;
    description: string | null;
    certification_name: string | null;
    insurance_minimum_minor: number | null;
    currency_code: string | null;
  };
  applications: {
    id: string;
    opportunity_id: string;
    applicant_person_id: string | null;
    applicant_organization_id: string | null;
    submitted_by: string | null;
    availability_confirmed: boolean;
    cover_note: string | null;
    proposed_fee_minor: number | null;
    currency_code: string | null;
    application_state: ApplicationState;
    submitted_at: string;
  };
  bids: {
    id: string;
    application_id: string;
    currency_code: string;
    valid_until: string | null;
    submitted_at: string;
  };
  bid_lines: {
    id: string;
    bid_id: string;
    description: string;
    element_id: string | null;
    quantity: number;
    unit_price_minor: number | null;
  };
  interviews: {
    id: string;
    application_id: string;
    interview_kind: InterviewKind;
    scheduled_at: string;
    duration_minutes: number | null;
    location_text: string | null;
  };
  ratings: {
    id: string;
    rater_side: RatingSide;
    score: number;
    comment: string | null;
    submitted_at: string;
    rated_person_id: string | null;
    rated_organization_id: string | null;
    rater_organization_id: string | null;
    reply: string | null;
    replied_at: string | null;
  };
  my_accounts: {
    account_id: string;
    name: string;
    slug: string;
    organization_type: string;
    my_roles: AccountRole[];
  };
  account_members: {
    account_membership_id: string;
    account_id: string;
    person_id: string;
    full_name: string | null;
    valid_from: string;
    valid_to: string | null;
    roles: AccountRole[];
  };
  representations: {
    id: string;
    account_id: string;
    account_name: string;
    artist_person_id: string;
    artist_name: string | null;
    representative_person_id: string | null;
    expires_on: string;
    accepted_at: string | null;
    revoked_at: string | null;
    scopes: RepresentationScope[];
  };
  availability: {
    id: string;
    person_id: string;
    availability_calendar_id: string;
    starts_at: string;
    ends_at: string;
    availability_kind: AvailabilityKind;
  };
}

export type ExternalView = keyof ExternalViews;
export type ExternalRow<V extends ExternalView> = ExternalViews[V];

export interface ViewResult<T> {
  readonly data: T | null;
  readonly error: DatabaseErrorLike | null;
}

/** The PostgREST filter builder surface the Gateway repositories use on a view. */
export interface ViewQuery<T> extends PromiseLike<ViewResult<T[]>> {
  select(columns?: string): ViewQuery<T>;
  eq(column: string, value: unknown): ViewQuery<T>;
  neq(column: string, value: unknown): ViewQuery<T>;
  in(column: string, values: readonly unknown[]): ViewQuery<T>;
  is(column: string, value: null | boolean): ViewQuery<T>;
  gte(column: string, value: unknown): ViewQuery<T>;
  lte(column: string, value: unknown): ViewQuery<T>;
  ilike(column: string, pattern: string): ViewQuery<T>;
  or(filters: string): ViewQuery<T>;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): ViewQuery<T>;
  limit(count: number): ViewQuery<T>;
  maybeSingle(): PromiseLike<ViewResult<T>>;
}

export interface ExternalReader {
  from<V extends ExternalView>(view: V): ViewQuery<ExternalRow<V>>;
}

/** The `api_external` schema on the caller's client; RLS and the view filters scope every row. */
export function external(db: XosClient): ExternalReader {
  return (db as unknown as { schema(name: "api_external"): ExternalReader }).schema(
    "api_external",
  );
}
