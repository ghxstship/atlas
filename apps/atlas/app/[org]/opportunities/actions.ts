"use server";

import type { Result } from "@xos/data";
import * as repo from "@xos/data/opportunities";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { errorState, type OpportunityActionState } from "@/lib/opportunities/action-state";
import { gatewayUrl } from "@/lib/gateway-url";
import { parseMoney } from "@/lib/opportunities/format";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * Opportunities server actions. Each one resolves the viewer's org context again (404 when it is gone), validates the
 * form with zod, and calls the repository. Row level security, the RPCs and the guards of migrations 0700 to 0775 decide
 * every write; refusals come back as catalog keys. Audit events and webhooks come from the database triggers.
 */

type Action = (state: OpportunityActionState, form: FormData) => Promise<OpportunityActionState>;

const uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null);
const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.iso.date().nullable())
  .nullable()
  .default(null);
const optionalInstant = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : new Date(v).toISOString()))
  .nullable()
  .default(null);
const reason = text(500);

function formValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries())
    if (typeof v === "string" && !k.startsWith("$")) values[k] = v;
  return values;
}

async function contextFor(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function fieldErrors(error: z.ZodError, values: Record<string, string>): OpportunityActionState {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const name = String(issue.path[0] ?? "form");
    // Custom issues carry their own catalog key under opportunities.fieldErrors.
    errors[name] ??=
      issue.code === "custom"
        ? issue.message
        : issue.code === "too_small" && values[name] === ""
          ? "required"
          : "invalid";
  }
  return { fieldErrors: errors, values };
}

/** Builds an action: parse, run, map the result, revalidate the module. */
function action<S extends z.ZodType>(
  schema: S,
  run: (ctx: OrgContext, input: z.infer<S>) => Promise<Result<unknown> | OpportunityActionState>,
): Action {
  return async (_state, form) => {
    const ctx = await contextFor(form);
    const values = formValues(form);
    const parsed = schema.safeParse(values);
    if (!parsed.success) return fieldErrors(parsed.error, values);
    const result = await run(ctx, parsed.data);
    if (
      "ok" in result &&
      typeof result.ok === "boolean" &&
      ("data" in result || "error" in result)
    ) {
      const r = result as Result<unknown>;
      if (!r.ok) {
        if (r.error.kind === "unexpected") console.error("Opportunities action failed", r.error);
        return errorState(r.error, values);
      }
      revalidatePath(`/${ctx.org.slug}/opportunities`, "layout");
      revalidatePath(`/${ctx.org.slug}/p`, "layout");
      return { ok: true };
    }
    revalidatePath(`/${ctx.org.slug}/opportunities`, "layout");
    return result as OpportunityActionState;
  };
}

// Postings -------------------------------------------------------------------------------------------------------------

const opportunitySchema = z
  .object({
    projectId: uuid,
    requisitionId: z.union([uuid, z.literal("")]).default(""),
    title: text(200),
    roleType: z.enum(repo.ROLE_TYPES as unknown as [string, ...string[]]),
    roleCode: z.string().trim().max(40).default(""),
    description: optionalText(10000),
    visibility: z.enum(repo.VISIBILITIES as unknown as [string, ...string[]]),
    rateType: z
      .union([z.enum(repo.RATE_TYPES as unknown as [string, ...string[]]), z.literal("")])
      .default(""),
    payMin: z.string().default(""),
    payMax: z.string().default(""),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    startsOn: optionalDate,
    endsOn: optionalDate,
    deadlineAt: optionalInstant,
  })
  .transform((v, ctx) => {
    const min = parseMoney(v.payMin, v.currencyCode);
    const max = parseMoney(v.payMax, v.currencyCode);
    if (Number.isNaN(min)) ctx.addIssue({ code: "custom", path: ["payMin"], message: "invalid" });
    if (Number.isNaN(max)) ctx.addIssue({ code: "custom", path: ["payMax"], message: "invalid" });
    // Posted pay needs a rate type other than Bid (opportunities_pay_needs_terms).
    if ((min !== null || max !== null) && (v.rateType === "" || v.rateType === "Bid")) {
      ctx.addIssue({ code: "custom", path: ["rateType"], message: "payNeedsRate" });
    }
    return { ...v, min, max };
  });

export const createOpportunityAction: Action = action(opportunitySchema, (ctx, v) => {
  const posted = v.min !== null || v.max !== null;
  return repo.createOpportunity(ctx.viewer.db, {
    projectId: v.projectId,
    title: v.title,
    roleType: v.roleType as repo.ExternalRoleType,
    roleCode: v.roleCode === "" ? null : v.roleCode,
    requisitionId: v.requisitionId === "" ? null : v.requisitionId,
    description: v.description,
    visibility: v.visibility as repo.OpportunityVisibility,
    rateType: v.rateType === "" ? null : (v.rateType as repo.RateType),
    payMinMinor: v.min,
    payMaxMinor: v.max,
    currencyCode: posted ? v.currencyCode : null,
    startsOn: v.startsOn,
    endsOn: v.endsOn,
    deadlineAt: v.deadlineAt,
  });
});

export const updateOpportunityAction: Action = action(
  z.object({
    opportunityId: uuid,
    title: text(200),
    description: optionalText(10000),
    startsOn: optionalDate,
    endsOn: optionalDate,
    deadlineAt: optionalInstant,
  }),
  (ctx, v) =>
    repo.updateOpportunity(ctx.viewer.db, v.opportunityId, {
      title: v.title,
      description: v.description,
      startsOn: v.startsOn,
      endsOn: v.endsOn,
      deadlineAt: v.deadlineAt,
    }),
);

export const transitionOpportunityAction: Action = action(
  z.object({
    opportunityId: uuid,
    expected: z.enum(repo.OPPORTUNITY_STATES as unknown as [string, ...string[]]),
    next: z.enum(repo.OPPORTUNITY_STATES as unknown as [string, ...string[]]),
    reason,
  }),
  (ctx, v) =>
    repo.transitionOpportunity(
      ctx.viewer.db,
      v.opportunityId,
      v.expected as repo.OpportunityState,
      v.next as repo.OpportunityState,
      v.reason,
    ),
);

export const addPositionAction: Action = action(
  z.object({ opportunityId: uuid, label: text(200), callAt: optionalInstant }),
  (ctx, v) =>
    repo.addPosition(ctx.viewer.db, v.opportunityId, { label: v.label, callAt: v.callAt }),
);

export const addQuestionAction: Action = action(
  z.object({
    opportunityId: uuid,
    prompt: text(500),
    sortOrder: z.coerce.number().int().min(1).max(999),
    required: z
      .string()
      .default("")
      .transform((s) => s === "true"),
  }),
  (ctx, v) =>
    repo.addQuestion(ctx.viewer.db, v.opportunityId, {
      prompt: v.prompt,
      sortOrder: v.sortOrder,
      required: v.required,
    }),
);

export const addRequirementAction: Action = action(
  z
    .object({
      opportunityId: uuid,
      kind: z.enum(["Equipment", "Insurance"]),
      description: text(500),
      minimum: z.string().default(""),
      currencyCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/)
        .default("USD"),
    })
    .transform((v, ctx) => {
      const minimum = parseMoney(v.minimum, v.currencyCode);
      if (v.kind === "Insurance" && (minimum === null || Number.isNaN(minimum))) {
        ctx.addIssue({ code: "custom", path: ["minimum"], message: "invalid" });
      }
      return { ...v, minimumMinor: minimum };
    }),
  (ctx, v) =>
    repo.addRequirement(
      ctx.viewer.db,
      v.opportunityId,
      v.kind === "Insurance"
        ? {
            kind: "Insurance",
            description: v.description,
            minimumMinor: v.minimumMinor ?? 0,
            currencyCode: v.currencyCode,
          }
        : { kind: "Equipment", description: v.description },
    ),
);

export const addInvitationAction: Action = action(
  z.object({ opportunityId: uuid, party: z.string().regex(/^(person|org):[0-9a-f-]{36}$/) }),
  (ctx, v) => {
    const [kind, id] = v.party.split(":") as [string, string];
    return repo.addInvitation(
      ctx.viewer.db,
      v.opportunityId,
      kind === "person" ? { personId: id } : { organizationId: id },
    );
  },
);

export const removeOpportunityChildAction: Action = action(
  z.object({
    table: z.enum([
      "opportunity_positions",
      "opportunity_requirements",
      "opportunity_questions",
      "opportunity_invitations",
    ]),
    id: uuid,
  }),
  (ctx, v) => repo.removeOpportunityChild(ctx.viewer.db, v.table, v.id),
);

// Pipeline ---------------------------------------------------------------------------------------------------------------

export const transitionApplicationAction: Action = action(
  z.object({
    applicationId: uuid,
    expected: z.enum(repo.APPLICATION_STATES as unknown as [string, ...string[]]),
    next: z.enum(repo.APPLICATION_STATES as unknown as [string, ...string[]]),
    reason,
  }),
  (ctx, v) =>
    repo.transitionApplication(
      ctx.viewer.db,
      v.applicationId,
      v.expected as repo.ApplicationState,
      v.next as repo.ApplicationState,
      v.reason,
    ),
);

export const shortlistAction: Action = action(
  z.object({
    opportunityId: uuid,
    applicationId: uuid,
    rank: z.coerce.number().int().min(1).max(999),
    note: optionalText(2000),
  }),
  (ctx, v) => repo.setShortlistRank(ctx.viewer.db, v),
);

export const scheduleInterviewAction: Action = action(
  z.object({
    applicationId: uuid,
    kind: z.enum(["Interview", "Audition"]),
    scheduledAt: z
      .string()
      .trim()
      .min(1)
      .transform((s) => new Date(s).toISOString()),
    durationMinutes: z.coerce.number().int().min(5).max(480),
    location: optionalText(500),
    internalNote: optionalText(4000),
  }),
  (ctx, v) =>
    repo.scheduleInterview(ctx.viewer.db, v.applicationId, {
      kind: v.kind,
      scheduledAt: v.scheduledAt,
      durationMinutes: v.durationMinutes,
      location: v.location,
      internalNote: v.internalNote,
    }),
);

const termsSchema = z
  .object({
    rateType: z.union([z.enum(["Hourly", "Day", "Flat", "Milestone"]), z.literal("")]).default(""),
    amount: z.string().default(""),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    startsOn: optionalDate,
    endsOn: optionalDate,
    message: optionalText(4000),
    expiresAt: optionalInstant,
  })
  .transform((v, ctx) => {
    const amount = parseMoney(v.amount, v.currencyCode);
    if (Number.isNaN(amount))
      ctx.addIssue({ code: "custom", path: ["amount"], message: "invalid" });
    if (amount !== null && v.rateType === "")
      ctx.addIssue({ code: "custom", path: ["rateType"], message: "payNeedsRate" });
    return {
      rateType: v.rateType === "" ? null : (v.rateType as repo.RateType),
      amountMinor: amount,
      currencyCode: amount === null ? null : v.currencyCode,
      startsOn: v.startsOn,
      endsOn: v.endsOn,
      message: v.message,
      expiresAt: v.expiresAt,
    };
  });

export const sendOfferAction: Action = action(
  z.object({ applicationId: uuid }).and(termsSchema),
  (ctx, v) => repo.sendOffer(ctx.viewer.db, v.applicationId, v),
);

export const reviseOfferAction: Action = action(
  z.object({ offerId: uuid }).and(termsSchema),
  (ctx, v) => repo.reviseOffer(ctx.viewer.db, v.offerId, v),
);

export const acceptCounterAction: Action = action(z.object({ offerId: uuid }), (ctx, v) =>
  repo.acceptOffer(ctx.viewer.db, v.offerId),
);

export const withdrawOfferAction: Action = action(z.object({ offerId: uuid, reason }), (ctx, v) =>
  repo.withdrawOffer(ctx.viewer.db, v.offerId, v.reason),
);

export const createEngagementAction: Action = action(
  z.object({
    applicationId: uuid,
    workerClassification: z.enum([
      "EMPLOYEE",
      "INDEPENDENT_CONTRACTOR",
      "VENDOR_SUPPLIED",
      "UNPAID_INTERN",
      "VOLUNTEER",
    ]),
    payBasis: z.string().trim().max(60).default(""),
    arrangement: z.string().trim().max(60).default(""),
    startDate: optionalDate,
    endDate: optionalDate,
  }),
  (ctx, v) =>
    repo.createEngagementFromApplication(ctx.viewer.db, {
      applicationId: v.applicationId,
      workerClassification: v.workerClassification,
      payBasis: v.payBasis === "" ? null : v.payBasis,
      arrangement: v.arrangement === "" ? null : v.arrangement,
      startDate: v.startDate,
      endDate: v.endDate,
    }),
);

// Engagements -----------------------------------------------------------------------------------------------------------------

export const transitionEngagementAction: Action = action(
  z.object({
    engagementId: uuid,
    expected: z.enum(repo.ENGAGEMENT_STATES as unknown as [string, ...string[]]),
    next: z.enum(repo.ENGAGEMENT_STATES as unknown as [string, ...string[]]),
    reason,
  }),
  (ctx, v) =>
    repo.transitionEngagement(
      ctx.viewer.db,
      v.engagementId,
      v.expected as repo.EngagementState,
      v.next as repo.EngagementState,
      v.reason,
    ),
);

export const createDocumentAction: Action = action(
  z.object({
    engagementId: uuid,
    kind: z.enum(repo.DOCUMENT_KINDS as unknown as [string, ...string[]]),
    title: text(200),
    expiresOn: optionalDate,
  }),
  (ctx, v) =>
    repo.createEngagementDocument(ctx.viewer.db, {
      engagementId: v.engagementId,
      kind: v.kind as repo.EngagementDocumentKind,
      title: v.title,
      expiresOn: v.expiresOn,
    }),
);

const documentStates = [
  "Proposed",
  "Sent",
  "Signed",
  "Executed",
  "Expired",
  "Superseded",
  "Canceled",
] as const;

export const transitionDocumentAction: Action = action(
  z.object({
    documentId: uuid,
    expected: z.enum(documentStates),
    next: z.enum(documentStates),
    reason,
  }),
  (ctx, v) =>
    repo.transitionEngagementDocument(ctx.viewer.db, v.documentId, v.expected, v.next, v.reason),
);

export const issueSigningLinkAction: Action = action(
  z.object({
    documentId: uuid,
    email: z.email().max(320),
    days: z.coerce.number().int().min(1).max(90),
  }),
  async (ctx, v) => {
    const result = await repo.issueSigningLink(ctx.viewer.db, v.documentId, v.email, v.days);
    if (!result.ok) return result;
    return {
      ok: true,
      link: {
        // The Gateway route /sign/{token} (apps/gateway/ia/sitemap.yaml, agreement-signing), in full.
        url: gatewayUrl(`/sign/${result.data.token}`),
        accessCode: result.data.accessCode,
        expiresAt: result.data.expiresAt,
      },
    };
  },
);

export const verifyItemAction: Action = action(
  z.object({ itemId: uuid, outcome: z.enum(["Passed", "Failed"]), note: optionalText(2000) }),
  (ctx, v) =>
    repo.verifyOnboardingItem(ctx.viewer.db, {
      itemId: v.itemId,
      outcome: v.outcome,
      note: v.note,
    }),
);

export const decideDeliverableAction: Action = action(
  z.object({
    deliverableId: uuid,
    decision: z.enum(["Approved", "Rejected"]),
    reason: optionalText(2000),
  }),
  (ctx, v) => repo.decideDeliverable(ctx.viewer.db, v.deliverableId, v.decision, v.reason),
);

export const rateAction: Action = action(
  z.object({
    engagementId: uuid,
    score: z.coerce.number().int().min(1).max(5),
    comment: optionalText(2000),
  }),
  (ctx, v) => repo.rateParty(ctx.viewer.db, v),
);

export const replyAction: Action = action(
  z.object({ ratingId: uuid, body: text(2000) }),
  (ctx, v) => repo.replyToRating(ctx.viewer.db, v.ratingId, v.body),
);

// Onboarding requirements ---------------------------------------------------------------------------------------------------------

export const createRequirementAction: Action = action(
  z.object({
    name: text(200),
    kind: z.enum(repo.ONBOARDING_ITEM_KINDS as unknown as [string, ...string[]]),
    roleType: z
      .union([z.enum(repo.ROLE_TYPES as unknown as [string, ...string[]]), z.literal("")])
      .default(""),
    method: z.enum(["Reviewer", "Automatic"]),
    blocking: z
      .string()
      .default("")
      .transform((s) => s === "true"),
    validForDays: z
      .string()
      .default("")
      .transform((s) => (s === "" ? null : Number(s)))
      .pipe(z.number().int().positive().nullable()),
  }),
  (ctx, v) =>
    repo.createOnboardingRequirement(ctx.viewer.db, {
      orgId: ctx.org.id,
      name: v.name,
      kind: v.kind as repo.OnboardingItemKind,
      roleType: v.roleType === "" ? null : (v.roleType as repo.ExternalRoleType),
      method: v.method,
      blocking: v.blocking,
      validForDays: v.validForDays,
    }),
);

// Pools -----------------------------------------------------------------------------------------------------------------------------

export const createPoolAction: Action = action(
  z.object({ name: text(200), kind: z.enum(["Talent", "Vendor"]) }),
  (ctx, v) => repo.createPool(ctx.viewer.db, { orgId: ctx.org.id, name: v.name, kind: v.kind }),
);

const standingSchema = z
  .object({
    standing: z.enum(["Preferred", "Approved", "Do Not Engage"]),
    reason: optionalText(1000),
    reviewOn: optionalDate,
  })
  .superRefine((v, ctx) => {
    if (v.standing === "Do Not Engage" && v.reason === null)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "dneReason" });
    if (v.standing === "Do Not Engage" && v.reviewOn === null)
      ctx.addIssue({ code: "custom", path: ["reviewOn"], message: "dneReview" });
  });

export const addPoolMemberAction: Action = action(
  z
    .object({ poolId: uuid, party: z.string().regex(/^(person|org):[0-9a-f-]{36}$/) })
    .and(standingSchema),
  (ctx, v) => {
    const [kind, id] = v.party.split(":") as [string, string];
    return repo.addPoolMember(ctx.viewer.db, {
      poolId: v.poolId,
      party: kind === "person" ? { personId: id } : { organizationId: id },
      standing: v.standing,
      reason: v.reason,
      reviewOn: v.reviewOn,
    });
  },
);

export const setStandingAction: Action = action(
  z.object({ memberId: uuid }).and(standingSchema),
  (ctx, v) =>
    repo.setPoolStanding(ctx.viewer.db, v.memberId, {
      standing: v.standing,
      reason: v.reason,
      reviewOn: v.reviewOn,
    }),
);

export const removePoolMemberAction: Action = action(z.object({ memberId: uuid }), (ctx, v) =>
  repo.removePoolMember(ctx.viewer.db, v.memberId),
);
