import type { Database, XosClient } from "./client";

/**
 * The `api_external` projections (migration 0750, ADR 0019 item 5): the only path by which Gateway
 * reads engagement data. Each view allowlists its columns and filters rows with the Section 8.7
 * helpers, so internal notes, margins, other parties' rates, internal ratings and Do Not Engage
 * flags never reach an external user. Row shapes and enums come from the generated types.
 */

type Enums = Database["app"]["Enums"];
type Views = Database["api_external"]["Views"];

export type ExternalView = keyof Views;
export type ExternalRow<V extends ExternalView> = Views[V]["Row"];

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
export type PaymentState = NonNullable<ExternalRow<"payments">["payment_state"]>;
export type RecordKind = NonNullable<ExternalRow<"records">["record_kind"]>;
export type RecordState = NonNullable<ExternalRow<"records">["record_state"]>;

/** Section 8.7 areas a caller may have open on an engagement. */
export const ENGAGEMENT_AREAS = [
  "engagement",
  "documents",
  "onboarding",
  "operational",
  "money",
] as const;
export type EngagementArea = (typeof ENGAGEMENT_AREAS)[number];

/** The `api_external` schema on the caller's client; the view filters scope every row. */
export function external(db: XosClient) {
  return db.schema("api_external");
}

type Tables = Database["app"]["Tables"];
type Insert<T extends keyof Tables> = Tables[T]["Insert"];

/**
 * An insert row whose org_id the tenant guard derives from the parent row (ADR 0002), and whose
 * stamped columns (a reporter, an author) a trigger sets from the session. The column grants of
 * 0720 to 0740 let an external caller write only the remaining columns.
 */
export function derivedRow<T extends keyof Tables, K extends keyof Insert<T> = never>(
  row: Omit<Insert<T>, "org_id" | K>,
): Insert<T> {
  return row as Insert<T>;
}

/**
 * View columns are nullable in the generated types because Postgres cannot prove a view column
 * NOT NULL. Columns that are NOT NULL in their source table pass through this guard, which refuses
 * a missing value loudly instead of inventing one.
 */
export function req<T>(value: T | null | undefined, column: string): T {
  if (value === null || value === undefined) {
    throw new Error(`api_external returned no ${column}; the source column is NOT NULL.`);
  }
  return value;
}
