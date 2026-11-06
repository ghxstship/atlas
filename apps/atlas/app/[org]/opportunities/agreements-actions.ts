"use server";

import type { DataError } from "@xos/data";
import * as repo from "@xos/data/engagement-document-batches";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { errorState, type OpportunityActionState } from "@/lib/opportunities/action-state";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * Agreement templates and batches (B10, G-130, ADR 0149 decision 4). The server merges every person's text as the caller,
 * for the preview and again for the batch, so what is created is never what a browser sent.
 */

type Action = (state: OpportunityActionState, form: FormData) => Promise<OpportunityActionState>;

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

function refresh(ctx: OrgContext) {
  revalidatePath(`/${ctx.org.slug}/opportunities/onboarding`);
  revalidatePath(`/${ctx.org.slug}/p`, "layout");
}

function done(
  ctx: OrgContext,
  typed: Record<string, string>,
  error: DataError | null,
): OpportunityActionState {
  if (error) return errorState(error, typed);
  refresh(ctx);
  return { ok: true };
}

const KINDS = ["Agreement", "Statement of Work", "Non-Disclosure Agreement"] as const;

const templateSchema = z.object({
  id: z.union([z.uuid(), z.literal("")]).default(""),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(KINDS),
  locale: z.enum(["en-US", "es-US"]),
  titleTemplate: z.string().trim().min(1).max(200),
  bodyTemplate: z.string().trim().min(1).max(100000),
});

export const saveAgreementTemplateAction: Action = async (_, form) => {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = templateSchema.safeParse(typed);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= "required";
    return { fieldErrors: errors, values: typed };
  }
  const result = await repo.saveTemplate(ctx.viewer.db, {
    orgId: ctx.org.id,
    id: parsed.data.id || null,
    name: parsed.data.name,
    kind: parsed.data.kind,
    locale: parsed.data.locale,
    titleTemplate: parsed.data.titleTemplate,
    bodyTemplate: parsed.data.bodyTemplate,
  });
  return done(ctx, typed, result.ok ? null : result.error);
};

export const duplicateAgreementTemplateAction: Action = async (_, form) => {
  const ctx = await contextFor(form);
  const typed = values(form);
  const parsed = z.object({ id: z.uuid(), name: z.string().min(1).max(190) }).safeParse(typed);
  if (!parsed.success) return { error: "invalid", values: typed };
  const t = await getTranslations("opportunities.agreementTemplates");
  const result = await repo.duplicateTemplate(ctx.viewer.db, {
    orgId: ctx.org.id,
    id: parsed.data.id,
    name: t("copyName", { name: parsed.data.name }),
  });
  return done(ctx, typed, result.ok ? null : result.error);
};

export const removeAgreementTemplateAction: Action = async (_, form) => {
  const ctx = await contextFor(form);
  const typed = values(form);
  const id = z.uuid().safeParse(typed["id"]);
  if (!id.success) return { error: "invalid", values: typed };
  const result = await repo.removeTemplate(ctx.viewer.db, id.data);
  return done(ctx, typed, result.ok ? null : result.error);
};

export const sendAgreementBatchAction: Action = async (_, form) => {
  const ctx = await contextFor(form);
  const typed = values(form);
  const id = z.uuid().safeParse(typed["batchId"]);
  if (!id.success) return { error: "invalid", values: typed };
  const result = await repo.sendBatch(ctx.viewer.db, id.data);
  return done(ctx, typed, result.ok ? null : result.error);
};

export const countersignAgreementBatchAction: Action = async (_, form) => {
  const ctx = await contextFor(form);
  const typed = values(form);
  const id = z.uuid().safeParse(typed["batchId"]);
  if (!id.success) return { error: "invalid", values: typed };
  const result = await repo.countersignBatch(ctx.viewer.db, id.data);
  if (!result.ok) return errorState(result.error, typed);
  refresh(ctx);
  const refused = result.data.refused[0];
  // A row that could not be countersigned stays Signed; the rest of the batch went through.
  return refused
    ? errorState({ kind: "refusal", rule: refused.code, message: refused.code }, typed)
    : { ok: true };
};

// Generating ----------------------------------------------------------------------------------------------------------

export interface PreviewState {
  readonly rows?: readonly repo.PreviewRow[];
  readonly batchId?: string;
  readonly created?: readonly repo.BatchEntryResult[];
  readonly sent?: number;
  readonly error?: string;
  readonly rule?: string;
}

const generateSchema = z.object({
  projectId: z.uuid(),
  templateId: z.uuid(),
  requirementId: z.union([z.uuid(), z.literal("")]).default(""),
  engagementIds: z.array(z.uuid()).min(1).max(500),
});

function generateInput(form: FormData) {
  return generateSchema.safeParse({
    projectId: form.get("projectId"),
    templateId: form.get("templateId"),
    requirementId: form.get("requirementId") ?? "",
    engagementIds: String(form.get("engagementIds") ?? "")
      .split(",")
      .filter((v) => v !== ""),
  });
}

async function mergedRows(ctx: OrgContext, input: z.infer<typeof generateSchema>) {
  const templates = await repo.listTemplates(ctx.viewer.db, ctx.org.id);
  if (!templates.ok) return templates;
  const template = templates.data.find((x) => x.id === input.templateId);
  if (!template) return { ok: false as const, error: { kind: "not-found" as const } };
  const labels = (await getTranslations({
    locale: template.locale as Locale,
    namespace: "opportunities.payBases",
  })) as unknown as ((key: string) => string) & { has: (key: string) => boolean };
  return repo.previewBatch(ctx.viewer.db, {
    projectId: input.projectId,
    template,
    engagementIds: input.engagementIds,
    payBasisLabel: (basis) =>
      labels.has(basis.replace(/[^A-Za-z]/g, "")) ? labels(basis.replace(/[^A-Za-z]/g, "")) : basis,
  });
}

function failed(error: DataError): PreviewState {
  return error.kind === "refusal" ? { error: "refusal", rule: error.rule } : { error: error.kind };
}

export async function previewAgreementBatchAction(
  _: PreviewState,
  form: FormData,
): Promise<PreviewState> {
  const ctx = await contextFor(form);
  const input = generateInput(form);
  if (!input.success) return { error: "input" };
  const rows = await mergedRows(ctx, input.data);
  return rows.ok ? { rows: rows.data } : failed(rows.error);
}

export async function createAgreementBatchAction(
  _: PreviewState,
  form: FormData,
): Promise<PreviewState> {
  const ctx = await contextFor(form);
  const input = generateInput(form);
  if (!input.success) return { error: "input" };
  const rows = await mergedRows(ctx, input.data);
  if (!rows.ok) return failed(rows.error);
  // A person with a missing field is held back: their text would still hold a merge field.
  const ready = rows.data.filter((r) => r.missing.length === 0);
  if (ready.length === 0) return { rows: rows.data, error: "noneReady" };
  const result = await repo.createBatch(ctx.viewer.db, {
    projectId: input.data.projectId,
    templateId: input.data.templateId,
    requirementId: input.data.requirementId || null,
    documents: ready.map((r) => ({ engagementId: r.engagementId, title: r.title, body: r.body })),
  });
  if (!result.ok) return { rows: rows.data, ...failed(result.error) };
  refresh(ctx);
  return { rows: rows.data, batchId: result.data.batchId, created: result.data.results };
}

export async function sendGeneratedBatchAction(
  state: PreviewState,
  form: FormData,
): Promise<PreviewState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("batchId"));
  if (!id.success) return { ...state, error: "input" };
  const result = await repo.sendBatch(ctx.viewer.db, id.data);
  if (!result.ok) return { ...state, ...failed(result.error) };
  refresh(ctx);
  const { error: _e, rule: _r, ...rest } = state;
  return { ...rest, sent: result.data.sent };
}
