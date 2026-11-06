"use server";

import type { DataError } from "@xos/data";
import * as repo from "@xos/data/registration";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { errorState, type OpportunityActionState } from "@/lib/opportunities/action-state";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * Registration pages and the registrations queue (B10, G-129). The database decides who may write and every refusal: a
 * page's pool, its fixed slug and minimum age, questions only in Draft, one decision per row.
 */

type State = OpportunityActionState & {
  /** Each decision's outcome, shown on the page rather than in a row that leaves after the refresh. */
  readonly decisions?: readonly repo.DecisionResult[];
  readonly invited?: number;
};

async function contextFor(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function values(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$")) out[k] = v;
  return out;
}

function fieldErrors(error: z.ZodError, typed: Record<string, string>): State {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const name = String(issue.path[0] ?? "form");
    errors[name] ??= issue.code === "too_small" && typed[name] === "" ? "required" : "invalid";
  }
  return { fieldErrors: errors, values: typed };
}

const refresh = (ctx: OrgContext) => revalidatePath(`/${ctx.org.slug}/opportunities/registration-pages`);

function done(ctx: OrgContext, typed: Record<string, string>, error: DataError | null): State {
  if (error) return errorState(error, typed);
  refresh(ctx);
  return { ok: true };
}

const pageSchema = z.object({
  id: z.union([z.uuid(), z.literal("")]).default(""),
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80),
  intro: z.string().trim().max(4000).default(""),
  poolId: z.uuid(),
  minimumAge: z.coerce.number().int().min(16).max(99),
});

export async function saveRegistrationPageAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = pageSchema.safeParse(typed);
  if (!parsed.success) return fieldErrors(parsed.error, typed);
  const result = await repo.saveRegistrationPage(ctx.viewer.db, {
    orgId: ctx.org.id,
    id: parsed.data.id || null,
    slug: parsed.data.slug,
    title: parsed.data.title,
    intro: parsed.data.intro || null,
    poolId: parsed.data.poolId,
    minimumAge: parsed.data.minimumAge,
  });
  return done(ctx, typed, result.ok ? null : result.error);
}

const STATES = ["Draft", "Open", "Closed"] as const;

export async function transitionRegistrationPageAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = z
    .object({ id: z.uuid(), expected: z.enum(STATES), next: z.enum(STATES) })
    .safeParse(typed);
  if (!parsed.success) return fieldErrors(parsed.error, typed);
  const result = await repo.transitionRegistrationPage(ctx.viewer.db, parsed.data);
  return done(ctx, typed, result.ok ? null : result.error);
}

const questionSchema = z.object({
  prompt: z.string().trim().min(1).max(500),
  isRequired: z
    .string()
    .default("")
    .transform((v) => v === "true"),
});

export async function addRegistrationQuestionAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = questionSchema.and(z.object({ pageId: z.uuid() })).safeParse(typed);
  if (!parsed.success) return fieldErrors(parsed.error, typed);
  const result = await repo.addRegistrationQuestion(ctx.viewer.db, parsed.data);
  return done(ctx, typed, result.ok ? null : result.error);
}

export async function updateRegistrationQuestionAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = questionSchema.and(z.object({ id: z.uuid() })).safeParse(typed);
  if (!parsed.success) return fieldErrors(parsed.error, typed);
  const result = await repo.updateRegistrationQuestion(ctx.viewer.db, parsed.data);
  return done(ctx, typed, result.ok ? null : result.error);
}

export async function removeRegistrationQuestionAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const typed = values(form);
  const id = z.uuid().safeParse(typed["id"]);
  if (!id.success) return { error: "invalid", values: typed };
  const result = await repo.removeRegistrationQuestion(ctx.viewer.db, id.data);
  return done(ctx, typed, result.ok ? null : result.error);
}

export async function applyRegistrationTemplateAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = z.object({ pageId: z.uuid(), templateId: z.uuid() }).safeParse(typed);
  if (!parsed.success) return fieldErrors(parsed.error, typed);
  const result = await repo.applyRegistrationTemplate(ctx.viewer.db, parsed.data);
  return done(ctx, typed, result.ok ? null : result.error);
}

export async function decideRegistrationsAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const ids = form.getAll("ids").filter((v): v is string => typeof v === "string");
  const parsed = z
    .object({ ids: z.array(z.uuid()).min(1).max(200), approve: z.enum(["true", "false"]) })
    .safeParse({ ids, approve: form.get("approve") });
  if (!parsed.success) return { error: "invalid" };
  const result = await repo.decideRegistrations(ctx.viewer.db, {
    ids: parsed.data.ids,
    approve: parsed.data.approve === "true",
  });
  if (!result.ok) return errorState(result.error, {});
  refresh(ctx);
  return { ok: true, decisions: result.data };
}

export async function inviteToRegistrationAction(_: State, form: FormData): Promise<State> {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = z
    .object({
      pageId: z.uuid(),
      includePastCrew: z
        .string()
        .default("")
        .transform((v) => v === "true"),
    })
    .safeParse(typed);
  if (!parsed.success) return fieldErrors(parsed.error, typed);
  const result = await repo.inviteToRegistration(ctx.viewer.db, parsed.data);
  if (!result.ok) return errorState(result.error, typed);
  refresh(ctx);
  return { ok: true, invited: result.data.invited };
}
