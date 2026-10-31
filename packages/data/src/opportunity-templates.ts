import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Application question templates and opportunity defaults (A136, migration 2290, Section 4.5.6 item 27): how an org's
 * new opportunities start. A template is a reusable set of application questions; applying it copies its questions
 * into a Draft opportunity (app.apply_question_template), so later edits to the template never change a posting. The
 * defaults are one row per org that the create form reads as editable prefill. Reads go through row level security;
 * writes take opportunities.marketplace.manage.
 */

type Enums = Database["app"]["Enums"];
type OpportunityVisibility = Enums["opportunity_visibility"];
type RateType = Enums["rate_type"];

export interface TemplateQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly sortOrder: number;
  readonly required: boolean;
}

export interface QuestionTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Live questions in display order. */
  readonly questions: readonly TemplateQuestion[];
}

export interface OpportunityDefaults {
  readonly visibility: OpportunityVisibility;
  readonly rateType: RateType | null;
  readonly currencyCode: string | null;
  readonly applicationWindowDays: number | null;
  /** The default template, or null when none is set or the one set was deleted since. */
  readonly questionTemplateId: string | null;
  /** New postings start with the client and event hidden until booking (2870). */
  readonly hideClientUntilBooked: boolean;
}

export type OpportunityDefaultsInput = OpportunityDefaults;

/** What a new opportunity starts from when the org has saved no defaults. */
export const NO_DEFAULTS: OpportunityDefaults = {
  visibility: "Invited",
  rateType: null,
  currencyCode: null,
  applicationWindowDays: null,
  questionTemplateId: null,
  hideClientUntilBooked: false,
};

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  questions:
    | {
        id: string;
        prompt: string;
        sort_order: number;
        is_required: boolean;
        deleted_at: string | null;
      }[]
    | null;
}

/** The org's live question templates by name, each with its live questions in order. */
export async function listQuestionTemplates(
  db: XosClient,
  orgId: string,
): Promise<Result<QuestionTemplate[]>> {
  const { data, error } = await db
    .from("application_question_templates")
    .select(
      "id, name, description, questions:application_template_questions(id, prompt, sort_order, is_required, deleted_at)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown as TemplateRow[]).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      questions: (t.questions ?? [])
        .filter((q) => q.deleted_at === null)
        .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
        .map((q) => ({
          id: q.id,
          prompt: q.prompt,
          sortOrder: q.sort_order,
          required: q.is_required,
        })),
    })),
  );
}

export async function createQuestionTemplate(
  db: XosClient,
  input: { orgId: string; name: string; description: string | null },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("application_question_templates")
    .insert({
      org_id: input.orgId,
      name: input.name,
      description: input.description,
    } as unknown as Database["app"]["Tables"]["application_question_templates"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Moves a template to Trash; postings that already copied its questions keep them. */
export async function deleteQuestionTemplate(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("application_question_templates")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

export async function addTemplateQuestion(
  db: XosClient,
  templateId: string,
  input: { prompt: string; sortOrder: number; required: boolean },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("application_template_questions")
    .insert({
      application_question_template_id: templateId,
      prompt: input.prompt,
      sort_order: input.sortOrder,
      is_required: input.required,
    } as unknown as Database["app"]["Tables"]["application_template_questions"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function removeTemplateQuestion(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("application_template_questions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** The org's opportunity defaults, or NO_DEFAULTS when it saved none. A deleted default template reads as none. */
export async function getOpportunityDefaults(
  db: XosClient,
  orgId: string,
): Promise<Result<OpportunityDefaults>> {
  const { data, error } = await db
    .from("opportunity_defaults")
    .select(
      "visibility, rate_type, currency_code, application_window_days, hide_client_until_booked, template:application_question_templates(id, deleted_at)",
    )
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(NO_DEFAULTS);
  const row = data as unknown as {
    visibility: OpportunityVisibility;
    rate_type: RateType | null;
    currency_code: string | null;
    application_window_days: number | null;
    hide_client_until_booked: boolean;
    template: { id: string; deleted_at: string | null } | null;
  };
  return ok({
    visibility: row.visibility,
    rateType: row.rate_type,
    currencyCode: row.currency_code,
    applicationWindowDays: row.application_window_days,
    questionTemplateId: row.template && row.template.deleted_at === null ? row.template.id : null,
    hideClientUntilBooked: row.hide_client_until_booked,
  });
}

/** Saves the org's one row of defaults, creating it the first time. */
export async function saveOpportunityDefaults(
  db: XosClient,
  orgId: string,
  input: OpportunityDefaultsInput,
): Promise<Result<null>> {
  const { error } = await db.from("opportunity_defaults").upsert(
    {
      org_id: orgId,
      visibility: input.visibility,
      rate_type: input.rateType,
      currency_code: input.currencyCode,
      application_window_days: input.applicationWindowDays,
      application_question_template_id: input.questionTemplateId,
      hide_client_until_booked: input.hideClientUntilBooked,
    } as unknown as Database["app"]["Tables"]["opportunity_defaults"]["Insert"],
    { onConflict: "org_id" },
  );
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** Copies a template's questions into a Draft opportunity after the ones it has; returns how many were copied. */
export async function applyQuestionTemplate(
  db: XosClient,
  opportunityId: string,
  templateId: string,
): Promise<Result<number>> {
  const { data, error } = await db.rpc("apply_question_template", {
    p_opportunity_id: opportunityId,
    p_template_id: templateId,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/**
 * The application deadline a new opportunity starts with: the window's days after `now`, as an ISO instant, or null
 * when the org sets no window.
 */
export function defaultDeadline(now: Date, windowDays: number | null): string | null {
  if (windowDays === null) return null;
  return new Date(now.getTime() + windowDays * 86_400_000).toISOString();
}

/**
 * The visibility a new opportunity starts with: the default when the org's marketplace visibility allows it, else
 * capped the way private.marketplace_visibility_cap caps it (1327): Network when Network is allowed, else Invited.
 */
export function defaultVisibility(
  preferred: OpportunityVisibility,
  allowed: readonly OpportunityVisibility[],
): OpportunityVisibility {
  if (allowed.includes(preferred)) return preferred;
  return allowed.includes("Network") ? "Network" : "Invited";
}
