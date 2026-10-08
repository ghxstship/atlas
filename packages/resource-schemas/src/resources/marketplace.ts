/**
 * Opportunities, applications, engagements, onboarding, pools, ratings and the Gateway
 * resources (Sections 4.4 and 7.3 "Added in 1.4"). Internal-only columns never reach an
 * external caller; those are served through `api_external` projections.
 */
import { z } from "zod";
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import {
  ApplicationState,
  EngagementState,
  ExternalRoleType,
  OpportunityState,
  OpportunityVisibility,
  PoolLevel,
  RateType,
} from "../common/enums.ts";
import { MoneyTotal } from "../common/envelope.ts";
import { defineResource } from "../common/resource.ts";

export const Opportunity = defineResource({
  name: "Opportunity",
  table: "app.opportunities",
  description:
    "An opportunity published from an approved requisition. Without posted compensation it shows Rate on Request, never zero.",
  immutable: ["requisition_id"],
  serverSet: ["opportunity_state", "published_at"],
  fields: {
    requisition_id: f.ref("approved requisition"),
    project_id: f.ref("project"),
    scope_node_id: f.ref("scope node").nullable(),
    title: f.text("Opportunity title, Title Case.", "Stagehands for Harborfront Load-In"),
    role_type: ExternalRoleType,
    role_code: c.RoleCode.nullable(),
    urid: c.UridAtAnyGrain.nullable(),
    description: f.longText("Description.", "Six stagehands for a two-day load-in."),
    venue_id: f.ref("venue").nullable(),
    starts_at: f.instant("First call.").nullable(),
    ends_at: f.instant("Last wrap.").nullable(),
    positions: f.int("Number of positions.", 6, 1),
    rate_type: RateType.nullable(),
    rate_min_minor: f.money("Lowest posted rate; null when not posted.", 32000),
    rate_max_minor: f.money("Highest posted rate; null when not posted.", 38000),
    currency: f.currency(),
    visibility: OpportunityVisibility,
    application_deadline_at: f.instant("Application deadline.").nullable(),
    opportunity_state: OpportunityState,
    published_at: f.instant("When it was published.").nullable(),
  },
});

export const OpportunityPosition = defineResource({
  name: "OpportunityPosition",
  table: "app.opportunity_positions",
  description: "A position within an opportunity.",
  immutable: ["opportunity_id"],
  fields: {
    opportunity_id: f.ref("opportunity"),
    title: f.text("Position title.", "Stagehand"),
    role_code: c.RoleCode.nullable(),
    count: f.int("Openings.", 6, 1),
  },
});

export const OpportunityRequirement = defineResource({
  name: "OpportunityRequirement",
  table: "app.opportunity_requirements",
  description:
    "A requirement of an opportunity: a certification through a canon compliance tag, insurance or equipment.",
  immutable: ["opportunity_id"],
  fields: {
    opportunity_id: f.ref("opportunity"),
    tag_id: c.TagId.nullable(),
    certification_id: f.ref("certification").nullable(),
    statement: f.text("Requirement statement.", "OSHA 10 card"),
    insurance_minimum_minor: f.money(
      "Insurance minimum, when the requirement is insurance.",
      100000000,
    ),
    currency: f.currency(),
  },
});

export const OpportunityQuestion = defineResource({
  name: "OpportunityQuestion",
  table: "app.opportunity_questions",
  description: "An application question.",
  immutable: ["opportunity_id"],
  fields: {
    opportunity_id: f.ref("opportunity"),
    position: f.int("Question order.", 1, 1),
    prompt: f.text("Question.", "Have you worked a festival load-in before?"),
    required: f.bool("Whether an answer is required.", true),
  },
});

export const PayTransparencyRule = defineResource({
  name: "PayTransparencyRule",
  table: "app.pay_transparency_rules",
  description: "Where a pay range is legally required in a posting.",
  base: "view",
  fields: {
    jurisdiction_id: c.JurisdictionId,
    range_required: f.bool("Whether a pay range is required.", true),
    effective_from: f.date("First day the rule applies."),
  },
});

export const SavedSearch = defineResource({
  name: "SavedSearch",
  table: "app.saved_searches",
  description: "A saved marketplace search that sends alerts.",
  base: "global",
  immutable: ["person_id"],
  fields: {
    person_id: f.ref("owner"),
    name: f.text("Search name.", "Miami Rigging Calls"),
    query: f.text("Search query in the filter grammar.", "filter[role_type][eq]=Crew"),
    alerts_enabled: f.bool("Whether alerts are sent by email and push.", true),
  },
});

export const OpportunityAlert = defineResource({
  name: "OpportunityAlert",
  table: "app.opportunity_alerts",
  description: "An alert raised for a saved search.",
  base: "global",
  serverSet: ["saved_search_id", "opportunity_id", "sent_at"],
  fields: {
    saved_search_id: f.ref("saved search"),
    opportunity_id: f.ref("opportunity"),
    sent_at: f.instant("When the alert was sent."),
  },
});

export const ListingReport = defineResource({
  name: "ListingReport",
  table: "app.listing_reports",
  description: "A report against a listing or profile, handled through notice and action.",
  base: "global",
  serverSet: ["report_state"],
  fields: {
    subject_urn: f.text(
      "URN of the reported listing or profile.",
      "urn:xpms:opportunity:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    reason: f.longText("Why it is reported.", "The listing asks for an upfront fee."),
    report_state: f.stateLabel("Report state.", "In Review"),
  },
});

export const ModerationAction = defineResource({
  name: "ModerationAction",
  table: "app.moderation_actions",
  description: "A moderation decision with a statement of reasons sent to the affected party.",
  base: "global",
  immutable: ["listing_report_id"],
  fields: {
    listing_report_id: f.ref("listing report"),
    action: f.stateLabel("Action taken.", "Removed"),
    statement_of_reasons: f.longText(
      "Statement of reasons.",
      "The listing requested a fee from applicants.",
    ),
  },
});

export const Application = defineResource({
  name: "Application",
  table: "app.applications",
  description: "An application to an opportunity, with a consented profile snapshot.",
  immutable: ["opportunity_id", "person_id", "organization_id"],
  serverSet: ["application_state", "submitted_at"],
  fields: {
    opportunity_id: f.ref("opportunity"),
    person_id: f.ref("applying person").nullable(),
    organization_id: f.ref("applying external account").nullable(),
    profile_share_id: f.ref("consented profile snapshot"),
    availability_confirmed: f.bool("Whether the applicant confirmed availability.", true),
    proposed_rate_minor: f.money("Fee proposed by an artist instead of the posted fee.", 250000),
    currency: f.currency(),
    application_state: ApplicationState,
    submitted_at: f.instant("When it was submitted."),
  },
});

export const ApplicationAnswer = defineResource({
  name: "ApplicationAnswer",
  table: "app.application_answers",
  description: "An answer to an application question.",
  immutable: ["application_id", "opportunity_question_id"],
  fields: {
    application_id: f.ref("application"),
    opportunity_question_id: f.ref("question"),
    answer: f.longText("Answer.", "Yes, three seasons of festival load-ins."),
  },
});

export const Bid = defineResource({
  name: "Bid",
  table: "app.bids",
  description:
    "A sealed line-item bid. A bidder never sees another bidder, and the org sees bids only after the deadline unless it holds `procurement.bid.unseal`.",
  immutable: ["application_id"],
  serverSet: ["total", "sealed"],
  fields: {
    application_id: f.ref("application"),
    total: MoneyTotal,
    sealed: f.bool("Whether the bid is still sealed.", true),
    notes: f.longText("Bid notes.", "Pricing holds for 30 days.").nullable(),
  },
});

export const BidLine = defineResource({
  name: "BidLine",
  table: "app.bid_lines",
  description: "A line of a sealed bid.",
  immutable: ["bid_id"],
  fields: {
    bid_id: f.ref("bid"),
    description: f.text("Line description.", "Line array rental"),
    quantity: f.quantity("Quantity.", 1).nullable(),
    unit_price_minor: f.money("Unit price.", 1800000),
    currency: f.currency(),
  },
});

export const AgencySlate = defineResource({
  name: "AgencySlate",
  table: "app.agency_slates",
  description: "A named staff member on a staffing agency's slate.",
  immutable: ["application_id", "person_id"],
  fields: { application_id: f.ref("agency application"), person_id: f.ref("slated staff member") },
});

export const Shortlist = defineResource({
  name: "Shortlist",
  table: "app.shortlists",
  description: "An application placed on the opportunity shortlist.",
  immutable: ["opportunity_id", "application_id"],
  fields: {
    opportunity_id: f.ref("opportunity"),
    application_id: f.ref("application"),
    rank: f.int("Rank on the shortlist.", 1, 1).nullable(),
  },
});

export const Interview = defineResource({
  name: "Interview",
  table: "app.interviews",
  description: "An interview or audition for an application.",
  immutable: ["application_id"],
  fields: {
    application_id: f.ref("application"),
    scheduled_at: f.instant("When it is scheduled."),
    meeting_url: f.url("Video meeting link.").nullable(),
    outcome_notes: f.longText("Internal notes.", "Strong rigging experience.").nullable(),
  },
});

export const Engagement = defineResource({
  name: "Engagement",
  table: "app.engagements",
  description:
    "An external relationship: a person or external account working for an org. It cannot become Active until every blocking onboarding item passes.",
  immutable: ["person_id", "organization_id", "role_type"],
  serverSet: ["engagement_state", "activated_at", "completed_at"],
  fields: {
    person_id: f.ref("engaged person").nullable(),
    organization_id: f.ref("engaged external account").nullable(),
    project_id: f.ref("project").nullable(),
    offer_id: f.ref("accepted offer").nullable(),
    role_type: ExternalRoleType,
    engagement_state: EngagementState,
    activated_at: f.instant("When it became Active.").nullable(),
    completed_at: f.instant("When it became Complete.").nullable(),
  },
});

export const EngagementDocument = defineResource({
  name: "EngagementDocument",
  table: "app.engagement_documents",
  description: "A document in an engagement, under the canon Engagement-Document lifecycle.",
  immutable: ["engagement_id"],
  serverSet: ["engagement_document_state"],
  fields: {
    engagement_id: f.ref("engagement"),
    document_id: f.ref("document"),
    title: f.text("Document title.", "Statement of Work"),
    engagement_document_state: f.stateLabel("Engagement-Document lifecycle state.", "Proposed"),
  },
});

export const OnboardingRequirement = defineResource({
  name: "OnboardingRequirement",
  table: "app.onboarding_requirements",
  description: "A requirement of the onboarding packet, by role type and jurisdiction.",
  fields: {
    role_type: ExternalRoleType,
    jurisdiction_id: c.JurisdictionId.nullable(),
    item_type: f.stateLabel("Item type.", "Tax Form"),
    title: f.text("Requirement title.", "W-9"),
    blocking: f.bool("Whether it blocks Active.", true),
    verification_method: f.stateLabel("Verification method.", "Reviewer"),
    validity_months: f.int("Months until expiry.", 12).nullable(),
  },
});

export const OnboardingItem = defineResource({
  name: "OnboardingItem",
  table: "app.onboarding_items",
  description: "One onboarding requirement instantiated for an engagement.",
  immutable: ["engagement_id", "onboarding_requirement_id"],
  serverSet: ["onboarding_item_state", "carried_over"],
  fields: {
    engagement_id: f.ref("engagement"),
    onboarding_requirement_id: f.ref("onboarding requirement"),
    document_id: f.ref("submitted document").nullable(),
    onboarding_item_state: f.stateLabel("Item state.", "In Review"),
    expires_on: f.date("Expiry.").nullable(),
    carried_over: f.bool("Whether a verified item carried over from an earlier engagement.", false),
  },
});

export const OnboardingVerification = defineResource({
  name: "OnboardingVerification",
  table: "app.onboarding_verifications",
  description: "A verification decision on an onboarding item.",
  immutable: ["onboarding_item_id"],
  serverSet: ["verified_by", "verified_at"],
  fields: {
    onboarding_item_id: f.ref("onboarding item"),
    passed: f.bool("Whether the item passed.", true),
    verified_by: f.ref("verifier"),
    verified_at: f.instant("When it was verified."),
    notes: f.longText("Reviewer notes.", "Name matches the tax form.").nullable(),
  },
});

export const TaxForm = defineResource({
  name: "TaxForm",
  table: "app.tax_forms",
  description:
    "A tax form. Restricted and encrypted; only the last four digits of the identifier are ever displayed.",
  immutable: ["engagement_id", "form_type"],
  restricted: ["tax_identifier"],
  serverSet: ["tax_identifier_last4"],
  fields: {
    engagement_id: f.ref("engagement"),
    form_type: f.code("Form type.", "W-9"),
    tax_identifier: f.code("Tax identifier, write-only after entry.", "123456789"),
    tax_identifier_last4: f.code("Last four digits of the tax identifier.", "6789"),
    foreign_performer_withholding: f.bool("Foreign performer withholding flag.", false),
  },
});

export const PayoutAccount = defineResource({
  name: "PayoutAccount",
  table: "app.payout_accounts",
  description: "Payout details held by the payment provider. XOS stores provider references only.",
  serverSet: ["account_last4"],
  fields: {
    person_id: f.ref("payee person").nullable(),
    organization_id: f.ref("payee organization").nullable(),
    provider: f.code("Payment provider.", "stripe_connect"),
    provider_account_ref: f.code("Provider account reference.", "acct_1PqRsT"),
    account_last4: f.code("Last four digits of the account.", "4421"),
  },
});

export const BackgroundCheck = defineResource({
  name: "BackgroundCheck",
  table: "app.background_checks",
  description: "A background check result from the provider. The report itself is never stored.",
  immutable: ["engagement_id"],
  serverSet: ["provider_result", "completed_at"],
  fields: {
    engagement_id: f.ref("engagement"),
    provider: f.code("Background check provider.", "checkr"),
    provider_reference: f.code("Provider reference.", "chk_7c1a2b"),
    provider_result: f.stateLabel("Provider result.", "Clear").nullable(),
    completed_at: f.instant("When the provider completed it.").nullable(),
  },
});

export const TalentPool = defineResource({
  name: "TalentPool",
  table: "app.talent_pools",
  description: "A talent or vendor pool.",
  fields: {
    name: f.text("Pool name.", "Preferred Riggers"),
    role_type: ExternalRoleType,
  },
});

export const PoolMember = defineResource({
  name: "PoolMember",
  table: "app.pool_members",
  description:
    "A pool member. Do Not Engage needs a reason and a review date and is never visible externally.",
  immutable: ["talent_pool_id"],
  fields: {
    talent_pool_id: f.ref("pool"),
    person_id: f.ref("member person").nullable(),
    organization_id: f.ref("member organization").nullable(),
    level: PoolLevel,
    reason: f.longText("Reason, required for Do Not Engage.", "Repeated no-shows.").nullable(),
    review_on: f.date("Review date, required for Do Not Engage.").nullable(),
    rehire_eligible: f.bool("Rehire eligibility.", true),
  },
});

export const Rating = defineResource({
  name: "Rating",
  table: "app.ratings",
  description:
    "A two-sided rating from a completed engagement, released together or after 14 days.",
  immutable: ["engagement_id", "rater_side"],
  serverSet: ["released_at"],
  fields: {
    engagement_id: f.ref("completed engagement"),
    rater_side: f.code("Which side rated.", "org"),
    score: f.int("Score from 1 to 5.", 5, 1),
    comment: f.longText("Public comment.", "Prepared, punctual and safe.").nullable(),
    released_at: f.instant("When both ratings were released.").nullable(),
  },
});

export const RatingReply = defineResource({
  name: "RatingReply",
  table: "app.rating_replies",
  description: "A public reply from the rated party.",
  immutable: ["rating_id"],
  fields: {
    rating_id: f.ref("rating"),
    body: f.longText("Reply.", "Thank you, glad to work the series again."),
  },
});

export const EngagementThread = defineResource({
  name: "EngagementThread",
  table: "app.engagement_threads",
  description: "A message thread inside an engagement.",
  immutable: ["engagement_id"],
  fields: {
    engagement_id: f.ref("engagement"),
    subject: f.text("Thread subject.", "Parking for Load-In"),
  },
});

export const EngagementMessage = defineResource({
  name: "EngagementMessage",
  table: "app.engagement_messages",
  description: "A message in an engagement thread.",
  immutable: ["engagement_thread_id"],
  serverSet: ["sent_by", "sent_at"],
  fields: {
    engagement_thread_id: f.ref("thread"),
    body: f.longText("Message body.", "Use the north lot; passes are at the gate."),
    sent_by: f.ref("sender"),
    sent_at: f.instant("When it was sent."),
  },
});

export const AvailabilityCalendar = defineResource({
  name: "AvailabilityCalendar",
  table: "app.availability_calendars",
  description: "A person's availability calendar.",
  base: "global",
  immutable: ["person_id"],
  fields: { person_id: f.ref("owner"), time_zone: f.timeZone() },
});

export const AvailabilityBlock = defineResource({
  name: "AvailabilityBlock",
  table: "app.availability_blocks",
  description: "A block of availability or unavailability.",
  base: "global",
  immutable: ["availability_calendar_id"],
  fields: {
    availability_calendar_id: f.ref("availability calendar"),
    starts_at: f.instant("Block start."),
    ends_at: f.instant("Block end."),
    available: f.bool("Whether the person is available.", false),
  },
});

export const ProfileShare = defineResource({
  name: "ProfileShare",
  table: "app.profile_shares",
  description:
    "A consent snapshot of profile fields shared with one org. Live updates stop on revoke after close.",
  base: "global",
  immutable: ["person_id", "organization_id"],
  serverSet: ["snapshot_at", "revoked_at"],
  fields: {
    person_id: f.ref("sharing person").nullable(),
    organization_id: f.ref("receiving organization"),
    shared_fields: z.array(z.string().min(1)).meta({
      description: "Profile field keys shared with the org.",
      example: ["headline", "skills", "certifications"],
    }),
    live_updates: f.bool("Whether live updates flow while the engagement is active.", true),
    snapshot_at: f.instant("When the snapshot was taken."),
    revoked_at: f.instant("When consent was revoked.").nullable(),
  },
});

export const MarketplaceListing = defineResource({
  name: "MarketplaceListing",
  table: "api_external.v_marketplace_opportunities",
  description:
    "A marketplace view of an opportunity the caller may see. Internal columns never appear. Unposted compensation reads Rate on Request.",
  base: "view",
  fields: {
    opportunity_id: f.ref("opportunity"),
    organization_id: f.ref("posting organization"),
    title: f.text("Opportunity title.", "Stagehands for Harborfront Load-In"),
    role_type: ExternalRoleType,
    role_code: c.RoleCode.nullable(),
    locality: f.text("City.", "Miami").nullable(),
    starts_at: f.instant("First call.").nullable(),
    rate_type: RateType.nullable(),
    rate_min_minor: f.money("Lowest posted rate.", 32000),
    rate_max_minor: f.money("Highest posted rate.", 38000),
    currency: f.currency(),
    distance_km: f.quantity("Distance from the search location.", 12.4).nullable(),
  },
});
