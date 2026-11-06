"use server";

import type { DataError, Result } from "@xos/data";
import * as transactions from "@xos/data/budget-transactions";
import * as versions from "@xos/data/budget-versions";
import * as quotes from "@xos/data/quotes";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { gatewayUrl } from "@/lib/gateway-url";
import { observability } from "@/lib/observability";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import type { ActionError, ActionState } from "./actions";

/**
 * Quote and budget version mutations (B13, ADR 0152). As the other finance actions: the org context is
 * resolved again, input is validated with Zod, and the database's RPCs and row level security decide
 * every write. A signing link's token and code are returned once and never stored here.
 */

function toActionError(error: DataError): ActionError {
  if (error.kind === "refusal") return error;
  if (error.kind === "unexpected") {
    observability.logger.error("quote action failed", { error: error });
    return { kind: "unexpected" };
  }
  return { kind: error.kind };
}

async function contextOf(slug: unknown): Promise<OrgContext> {
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function finish(ctx: OrgContext, result: Result<unknown>, extra: ActionState = {}): ActionState {
  if (!result.ok) return { error: toActionError(result.error), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, at: Date.now(), ...extra };
}

function inputError(field: string): ActionState {
  return { error: { kind: "input" }, fieldErrors: { [field]: field }, at: Date.now() };
}

const isoDate = z.iso.date();

// Budget versions ---------------------------------------------------------------------------------------

export async function loadBudgetVersionsAction(
  org: string,
  budgetId: string,
): Promise<{ ok: true; versions: versions.BudgetVersion[] } | { ok: false }> {
  const ctx = await contextOf(org);
  const id = z.uuid().safeParse(budgetId);
  if (!id.success) return { ok: false };
  const result = await versions.listBudgetVersions(ctx.viewer.db, id.data);
  return result.ok ? { ok: true, versions: result.data } : { ok: false };
}

export async function takeSnapshotAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextOf(form.get("org"));
  const budgetId = z.uuid().safeParse(form.get("budgetId"));
  if (!budgetId.success) return { error: { kind: "not-found" } };
  const label = z.string().trim().min(1).max(120).safeParse(form.get("label"));
  if (!label.success) return inputError("label");
  const result = await versions.snapshotBudget(ctx.viewer.db, budgetId.data, label.data);
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function deleteBudgetVersionAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextOf(org);
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { error: { kind: "not-found" } };
  return finish(ctx, await versions.deleteBudgetVersion(ctx.viewer.db, parsed.data));
}

export async function restoreBudgetVersionAction(org: string, id: string): Promise<ActionState> {
  const ctx = await contextOf(org);
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { error: { kind: "not-found" } };
  return finish(ctx, await versions.restoreBudgetVersion(ctx.viewer.db, parsed.data));
}

export async function loadLineTransactionsAction(
  org: string,
  lineId: string,
  access: transactions.LineTransactionAccess,
  currency: string,
): Promise<{ ok: true; transactions: transactions.LineTransactions } | { ok: false }> {
  const ctx = await contextOf(org);
  const id = z.uuid().safeParse(lineId);
  if (!id.success) return { ok: false };
  // The flags only choose which sections to read; row level security still decides every row.
  const result = await transactions.getBudgetLineTransactions(
    ctx.viewer.db,
    id.data,
    access,
    currency,
  );
  return result.ok ? { ok: true, transactions: result.data } : { ok: false };
}

// Quotes ---------------------------------------------------------------------------------------------------

export async function saveQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextOf(form.get("org"));
  const budgetId = z.uuid().safeParse(form.get("budgetId"));
  if (!budgetId.success) return inputError("budgetId");
  const title = z.string().trim().min(1).max(200).safeParse(form.get("title"));
  if (!title.success) return inputError("title");
  const engagementText = String(form.get("engagementId") ?? "");
  const engagementId = engagementText === "" ? null : engagementText;
  if (engagementId !== null && !z.uuid().safeParse(engagementId).success) {
    return inputError("engagementId");
  }
  const validText = String(form.get("validUntil") ?? "");
  if (validText !== "" && !isoDate.safeParse(validText).success) return inputError("validUntil");
  const markupText = String(form.get("defaultMarkupPercent") ?? "").trim();
  if (markupText !== "") {
    const percent = Number(markupText);
    if (!(Number.isFinite(percent) && percent >= 0 && percent <= 1000)) {
      return inputError("defaultMarkupPercent");
    }
    const { error } = await ctx.viewer.db
      .from("budgets")
      .update({ default_markup_bp: Math.round(percent * 100) })
      .eq("id", budgetId.data);
    if (error) return { error: { kind: "unexpected" }, at: Date.now() };
  }
  const result = await quotes.createQuote(ctx.viewer.db, {
    budgetId: budgetId.data,
    title: title.data,
    engagementId,
    validUntil: validText === "" ? null : validText,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function saveQuoteDraftAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextOf(form.get("org"));
  const versionId = z.uuid().safeParse(form.get("versionId"));
  if (!versionId.success) return { error: { kind: "not-found" } };
  const validUntil = isoDate.safeParse(form.get("validUntil"));
  if (!validUntil.success) return inputError("validUntil");
  const termsText = String(form.get("terms") ?? "").trim();
  if (termsText.length > 4000) return inputError("terms");
  return finish(
    ctx,
    await quotes.updateQuoteDraft(ctx.viewer.db, versionId.data, {
      validUntil: validUntil.data,
      terms: termsText === "" ? null : termsText,
    }),
  );
}

export async function newQuoteVersionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextOf(form.get("org"));
  const quoteId = z.uuid().safeParse(form.get("quoteId"));
  if (!quoteId.success) return { error: { kind: "not-found" } };
  const result = await quotes.createQuoteVersion(ctx.viewer.db, quoteId.data);
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function withdrawQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextOf(form.get("org"));
  const versionId = z.uuid().safeParse(form.get("versionId"));
  if (!versionId.success) return { error: { kind: "not-found" } };
  return finish(
    ctx,
    await quotes.withdrawQuoteVersion(
      ctx.viewer.db,
      versionId.data,
      String(form.get("reason") ?? ""),
    ),
  );
}

export async function declineQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextOf(form.get("org"));
  const versionId = z.uuid().safeParse(form.get("versionId"));
  if (!versionId.success) return { error: { kind: "not-found" } };
  return finish(
    ctx,
    await quotes.declineQuoteVersion(
      ctx.viewer.db,
      versionId.data,
      String(form.get("reason") ?? ""),
    ),
  );
}

export async function deleteQuoteDraftAction(org: string, versionId: string): Promise<ActionState> {
  const ctx = await contextOf(org);
  const id = z.uuid().safeParse(versionId);
  if (!id.success) return { error: { kind: "not-found" } };
  return finish(ctx, await quotes.deleteQuoteDraft(ctx.viewer.db, id.data));
}

export async function restoreQuoteDraftAction(
  org: string,
  quoteId: string,
  versionId: string,
): Promise<ActionState> {
  const ctx = await contextOf(org);
  const ids = z
    .object({ quoteId: z.uuid(), versionId: z.uuid() })
    .safeParse({ quoteId, versionId });
  if (!ids.success) return { error: { kind: "not-found" } };
  // Deleting the only Draft of a quote never sent took the quote with it; restoring the quote restores the Draft.
  const db = ctx.viewer.db;
  const restored = await quotes.restoreQuote(db, ids.data.quoteId);
  if (!restored.ok) return finish(ctx, restored);
  return finish(ctx, await quotes.restoreQuoteDraft(db, ids.data.versionId));
}

export interface QuoteSendState {
  readonly ok?: boolean;
  readonly error?: ActionError;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly at?: number;
  /** Shown once: the token and code are never stored. */
  readonly link?: { readonly url: string; readonly accessCode: string; readonly expiresAt: string };
  /** The quote was sent but its link was not issued; the sender can retry. */
  readonly linkFailed?: boolean;
  /** Too little of valid until is left for a link: the client signs in Gateway. */
  readonly noLinkTime?: boolean;
}

async function issueLink(
  ctx: OrgContext,
  documentId: string,
  email: string,
  validUntil: string,
  timeZone: string,
): Promise<Pick<QuoteSendState, "link" | "linkFailed" | "noLinkTime">> {
  const hours = quotes.signingLinkHours(validUntil, timeZone);
  if (hours < 1) return { noLinkTime: true };
  const { data, error } = await ctx.viewer.db.rpc("issue_engagement_document_token", {
    p_document_id: documentId,
    p_recipient_email: email,
    p_valid_for: `${hours} hours`,
  });
  const row = (data as { token: string; access_code: string; expires_at: string }[] | null)?.[0];
  if (error || !row) {
    if (error) observability.logger.error("quote signing link failed", { error });
    return { linkFailed: true };
  }
  return {
    link: {
      url: gatewayUrl(`/sign/${row.token}`),
      accessCode: row.access_code,
      expiresAt: row.expires_at,
    },
  };
}

const SendInput = z.object({
  org: z.string(),
  versionId: z.uuid(),
  validUntil: isoDate,
  timeZone: z.string().min(1),
  reason: z.string().trim().max(500),
  email: z.union([z.literal(""), z.email().max(320)]),
});

/**
 * Send quote, then the signing link. Does not revalidate: the dialog holding the link and code stays
 * on screen until the sender closes it, and the page refreshes then. A failed link after a successful
 * send reports that the quote was sent and offers a retry; it never rolls back the send.
 */
export async function sendQuoteAction(_: QuoteSendState, form: FormData): Promise<QuoteSendState> {
  const parsed = SendInput.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      error: { kind: "input" },
      ...(field === "email" ? { fieldErrors: { email: "email" } } : {}),
      at: Date.now(),
    };
  }
  const v = parsed.data;
  const ctx = await contextOf(v.org);
  const sent = await quotes.sendQuoteVersion(ctx.viewer.db, v.versionId, v.reason || null);
  if (!sent.ok) return { error: toActionError(sent.error), at: Date.now() };
  const link =
    v.email === ""
      ? {}
      : await issueLink(ctx, sent.data.engagementDocumentId, v.email, v.validUntil, v.timeZone);
  return { ok: true, at: Date.now(), ...link };
}

const LinkInput = z.object({
  org: z.string(),
  documentId: z.uuid(),
  validUntil: isoDate,
  timeZone: z.string().min(1),
  email: z.email().max(320),
});

/** Signing link for a Sent quote: reissues and revokes earlier links. */
export async function quoteSigningLinkAction(
  _: QuoteSendState,
  form: FormData,
): Promise<QuoteSendState> {
  const parsed = LinkInput.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success)
    return { error: { kind: "input" }, fieldErrors: { email: "email" }, at: Date.now() };
  const v = parsed.data;
  const ctx = await contextOf(v.org);
  return {
    ok: true,
    at: Date.now(),
    ...(await issueLink(ctx, v.documentId, v.email, v.validUntil, v.timeZone)),
  };
}
