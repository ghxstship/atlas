"use server";

import type { Result } from "@xos/data";
import * as repo from "@xos/data/opportunity-templates";
import { RATE_TYPES, VISIBILITIES } from "@xos/data/opportunities";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { errorState, type OpportunityActionState } from "@/lib/opportunities/action-state";
import { observability } from "@/lib/observability";
import { contextFor } from "@/lib/platform/action-context";
import type { OrgContext } from "@/lib/shell/context";

/**
 * A136's settings actions (Settings, Gateway and Marketplace): the org's application question templates and the
 * defaults new opportunities start from (migration 2290). Each resolves the viewer's org context again and writes as
 * the viewer, so row level security decides: opportunities.marketplace.manage. Answers are the Opportunities form
 * states, so the panel reuses its ActionForm and catalog keys.
 */

type Action = (state: OpportunityActionState, form: FormData) => Promise<OpportunityActionState>;

const uuid = z.uuid();
const required = z
  .string()
  .default("")
  .transform((s) => s === "true");
/** A blank field reads as null; anything else goes on to the schema piped after it. */
const blank = z
  .string()
  .trim()
  .default("")
  .transform((v) => (v === "" ? null : v));

function formValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$")) out[k] = v;
  return out;
}

/** Parse, run as the viewer, map the result, revalidate the panel and the create form that reads it. */
function settingsAction<S extends z.ZodType>(
  schema: S,
  run: (ctx: OrgContext, input: z.infer<S>) => Promise<Result<unknown>>,
): Action {
  return async (_state, form) => {
    const ctx = await contextFor(form);
    const values = formValues(form);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0] ?? "form");
        fieldErrors[name] ??=
          issue.code === "too_small" && values[name] === "" ? "required" : "invalid";
      }
      return { fieldErrors, values };
    }
    const result = await run(ctx, parsed.data);
    if (!result.ok) {
      if (result.error.kind === "unexpected")
        observability.logger.error("Opportunity templates action failed", { error: result.error });
      return errorState(result.error, values);
    }
    revalidatePath(`/${ctx.org.slug}/settings/gateway-and-marketplace`);
    revalidatePath(`/${ctx.org.slug}/opportunities`, "layout");
    return { ok: true };
  };
}

export const saveOpportunityDefaultsAction: Action = settingsAction(
  z.object({
    visibility: z.enum(VISIBILITIES as unknown as [string, ...string[]]),
    rateType: blank.pipe(z.enum(RATE_TYPES as unknown as [string, ...string[]]).nullable()),
    currencyCode: blank.pipe(
      z
        .string()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/)
        .nullable(),
    ),
    applicationWindowDays: blank.pipe(z.coerce.number<string>().int().min(1).max(365).nullable()),
    questionTemplateId: blank.pipe(uuid.nullable()),
  }),
  (ctx, v) =>
    repo.saveOpportunityDefaults(ctx.viewer.db, ctx.org.id, {
      visibility: v.visibility as repo.OpportunityDefaults["visibility"],
      rateType: v.rateType as repo.OpportunityDefaults["rateType"],
      currencyCode: v.currencyCode,
      applicationWindowDays: v.applicationWindowDays,
      questionTemplateId: v.questionTemplateId,
    }),
);

export const createQuestionTemplateAction: Action = settingsAction(
  z.object({
    name: z.string().trim().min(1).max(200),
    description: blank.pipe(z.string().max(1000).nullable()),
  }),
  (ctx, v) =>
    repo.createQuestionTemplate(ctx.viewer.db, {
      orgId: ctx.org.id,
      name: v.name,
      description: v.description,
    }),
);

export const deleteQuestionTemplateAction: Action = settingsAction(
  z.object({ templateId: uuid }),
  (ctx, v) => repo.deleteQuestionTemplate(ctx.viewer.db, v.templateId),
);

export const addTemplateQuestionAction: Action = settingsAction(
  z.object({
    templateId: uuid,
    prompt: z.string().trim().min(1).max(500),
    sortOrder: z.coerce.number().int().min(1).max(999),
    required,
  }),
  (ctx, v) =>
    repo.addTemplateQuestion(ctx.viewer.db, v.templateId, {
      prompt: v.prompt,
      sortOrder: v.sortOrder,
      required: v.required,
    }),
);

export const removeTemplateQuestionAction: Action = settingsAction(
  z.object({ questionId: uuid }),
  (ctx, v) => repo.removeTemplateQuestion(ctx.viewer.db, v.questionId),
);
