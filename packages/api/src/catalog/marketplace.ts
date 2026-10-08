/**
 * Opportunities (Atlas module, Section 4.2) and Gateway resources (Section 4.4).
 */
import { z } from "@hono/zod-openapi";
import {
  ApplicationState,
  EngagementState,
  OpportunityState,
  marketplace as mk,
} from "@xos/schemas";
import { collectionQuery, itemAction, resource, transitionBody } from "./define.ts";
import type { ResourceSpec } from "./types.ts";

const machineTransition = (
  lifecycle: string,
  id: string,
  state: z.ZodType,
  example: [string, string],
  rules: string,
) =>
  itemAction("transition", {
    segment: "transitions",
    summary: `Transition the ${lifecycle} state`,
    description: `Moves the ${lifecycle} state machine through its transition RPC, which writes its ledger. ${rules}`,
    body: transitionBody(id, state, example),
  });

const searchQuery = z.object({
  q: z
    .string()
    .optional()
    .meta({
      param: { name: "q", in: "query", description: "Free-text search." },
      example: "rigger",
    }),
  near: z
    .string()
    .regex(/^-?[0-9.]+,-?[0-9.]+$/)
    .optional()
    .meta({
      param: {
        name: "near",
        in: "query",
        description: "Latitude and longitude to measure distance from.",
      },
      example: "25.7617,-80.1918",
    }),
  radius_km: z.coerce
    .number()
    .positive()
    .optional()
    .meta({
      param: { name: "radius_km", in: "query", description: "Search radius in kilometers." },
      example: 50,
    }),
});

export const marketplaceResources: readonly ResourceSpec[] = [
  resource("Opportunities", "/opportunities", mk.Opportunity, {
    actions: [
      machineTransition(
        "opportunity",
        "OpportunityTransitionRequest",
        OpportunityState,
        ["Draft", "Pending Approval"],
        "Publishing applies spend authority and refuses a posting without a pay range where the jurisdiction requires one.",
      ),
    ],
  }),
  resource("Opportunities", "/opportunity-positions", mk.OpportunityPosition),
  resource("Opportunities", "/opportunity-requirements", mk.OpportunityRequirement),
  resource("Opportunities", "/opportunity-questions", mk.OpportunityQuestion, {
    order: { by: ["position"], numeric: false },
  }),
  resource("Opportunities", "/pay-transparency-rules", mk.PayTransparencyRule),
  resource("Opportunities", "/applications", mk.Application, {
    verbs: ["list", "get", "create"],
    actions: [
      machineTransition(
        "application",
        "ApplicationTransitionRequest",
        ApplicationState,
        ["Submitted", "In Review"],
        "Applicants may only withdraw; every other transition belongs to the org.",
      ),
    ],
  }),
  resource("Opportunities", "/application-answers", mk.ApplicationAnswer, {
    verbs: ["list", "get", "create"],
  }),
  resource("Opportunities", "/bids", mk.Bid, {
    verbs: ["list", "get", "create", "update"],
    actions: [
      itemAction("unseal", {
        summary: "Unseal a bid",
        description:
          "Unseals a bid before the deadline. Requires `procurement.bid.unseal`; otherwise refused.",
      }),
    ],
  }),
  resource("Opportunities", "/bid-lines", mk.BidLine),
  resource("Opportunities", "/agency-slates", mk.AgencySlate, {
    verbs: ["list", "get", "create", "delete"],
    label: "agency slate entry",
  }),
  resource("Opportunities", "/shortlists", mk.Shortlist, {
    op: "shortlistEntries",
    label: "shortlist entry",
  }),
  resource("Opportunities", "/interviews", mk.Interview),
  resource("Opportunities", "/engagements", mk.Engagement, {
    verbs: ["list", "get", "create"],
    actions: [
      machineTransition(
        "engagement",
        "EngagementTransitionRequest",
        EngagementState,
        ["Onboarding", "Active"],
        "Active is refused until every blocking onboarding item passes. Complete narrows external access to money and documents.",
      ),
    ],
  }),
  resource("Opportunities", "/engagement-documents", mk.EngagementDocument, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("transition", {
        segment: "transitions",
        summary: "Transition an engagement document",
        description: "Moves the document through the canon Engagement-Document lifecycle.",
        body: transitionBody("EngagementDocumentTransitionRequest", z.string().min(1), [
          "Proposed",
          "Active",
        ]),
      }),
    ],
  }),
  resource("Opportunities", "/onboarding-requirements", mk.OnboardingRequirement),
  resource("Opportunities", "/onboarding-items", mk.OnboardingItem, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Opportunities", "/onboarding-verifications", mk.OnboardingVerification, {
    verbs: ["list", "get", "create"],
  }),
  resource("Opportunities", "/talent-pools", mk.TalentPool),
  resource("Opportunities", "/pool-members", mk.PoolMember),
  resource("Opportunities", "/ratings", mk.Rating, { verbs: ["list", "get", "create"] }),
  resource("Opportunities", "/rating-replies", mk.RatingReply, {
    verbs: ["list", "get", "create"],
  }),

  // Gateway
  resource("Gateway", "/marketplace/opportunities", mk.MarketplaceListing, {
    op: "marketplace",
    verbs: [],
    actions: [
      collectionQuery("search", {
        segment: "",
        summary: "Search the marketplace",
        description:
          "Searches opportunities the caller may see, by role type, discipline and category, distance, dates, rate and required certifications through the filter grammar. Ranking factors are published; no placement can be bought.",
        query: searchQuery,
        paged: true,
      }),
    ],
  }),
  resource("Gateway", "/saved-searches", mk.SavedSearch),
  resource("Gateway", "/opportunity-alerts", mk.OpportunityAlert, { verbs: ["list", "get"] }),
  resource("Gateway", "/listing-reports", mk.ListingReport, { verbs: ["list", "get", "create"] }),
  resource("Gateway", "/moderation-actions", mk.ModerationAction, {
    verbs: ["list", "get", "create"],
  }),
  resource("Gateway", "/profile-shares", mk.ProfileShare, {
    verbs: ["list", "get", "create"],
    actions: [
      itemAction("revoke", {
        summary: "Revoke a profile share",
        description:
          "Stops future updates to the org. The org keeps records it must retain by law.",
      }),
    ],
  }),
  resource("Gateway", "/availability-calendars", mk.AvailabilityCalendar),
  resource("Gateway", "/availability-blocks", mk.AvailabilityBlock),
  resource("Gateway", "/engagement-threads", mk.EngagementThread, {
    verbs: ["list", "get", "create", "update"],
  }),
  resource("Gateway", "/engagement-messages", mk.EngagementMessage, {
    verbs: ["list", "get", "create"],
  }),
  resource("Gateway", "/tax-forms", mk.TaxForm, { verbs: ["list", "get", "create"] }),
  resource("Gateway", "/payout-accounts", mk.PayoutAccount, {
    verbs: ["list", "get", "create", "delete"],
  }),
  resource("Gateway", "/background-checks", mk.BackgroundCheck, {
    verbs: ["list", "get", "create"],
  }),
];
