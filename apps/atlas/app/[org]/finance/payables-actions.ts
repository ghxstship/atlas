"use server";

import type { DataError, Result } from "@xos/data";
import { recordPerDiemPayments } from "@xos/data/crew";
import * as finance from "@xos/data/finance";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exponentOf, getExponents } from "@/lib/finance/money";
import { observability } from "@/lib/observability";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import type { ActionError, ActionState } from "./actions";

/**
 * The payables recordings of B12 (RRR-236): credits, reimbursements and per diem payments, and the look-alike check an
 * expense runs before saving. XOS records each payment with its date and reference and moves no money (decision 20,
 * ADR 0029 item 3). Row level security and the RPCs of 3010 to 3016 decide every write and refuse with their rule.
 */

function toActionError(error: DataError): ActionError {
  if (error.kind === "refusal") return error;
  if (error.kind === "unexpected") {
    observability.logger.error("payables action failed", { error });
    return { kind: "unexpected" };
  }
  return { kind: error.kind };
}

async function contextFor(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function finish(ctx: OrgContext, result: Result<unknown>, extra: ActionState = {}): ActionState {
  if (!result.ok) return { error: toActionError(result.error), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, at: Date.now(), ...extra };
}

function inputError(field: string, key = field): ActionState {
  return { error: { kind: "input" }, fieldErrors: { [field]: key }, at: Date.now() };
}

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};
const required = z.string().trim().min(1).max(500);
const reference = z
  .string()
  .trim()
  .max(200)
  .transform((s) => (s === "" ? null : s));
const ids = (form: FormData, key: string) =>
  z.array(z.uuid()).min(1).safeParse(form.getAll(key));

export async function recordReimbursementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const payee = z.uuid().safeParse(text(form, "payeePersonId"));
  if (!payee.success) return { error: { kind: "not-found" }, at: Date.now() };
  const expenses = ids(form, "expenseIds");
  if (!expenses.success) return inputError("expenseIds");
  const paidOn = z.iso.date().safeParse(text(form, "paidOn"));
  if (!paidOn.success) return inputError("paidOn", "date");
  const ref = reference.safeParse(text(form, "reference"));
  if (!ref.success) return inputError("reference");
  return finish(
    ctx,
    await finance.recordExpenseReimbursement(ctx.viewer.db, {
      payeePersonId: payee.data,
      expenseIds: expenses.data,
      paidOn: paidOn.data,
      reference: ref.data,
    }),
  );
}

export async function voidReimbursementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(text(form, "id"));
  if (!id.success) return { error: { kind: "not-found" }, at: Date.now() };
  const reason = required.safeParse(text(form, "reason"));
  if (!reason.success) return inputError("reason");
  return finish(
    ctx,
    await finance.voidExpenseReimbursement(ctx.viewer.db, { id: id.data, reason: reason.data }),
  );
}

export async function recordPerDiemPaymentsAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const perDiems = ids(form, "perDiemIds");
  if (!perDiems.success) return inputError("perDiemIds");
  const paidOn = z.iso.date().safeParse(text(form, "paidOn"));
  if (!paidOn.success) return inputError("paidOn", "date");
  const ref = reference.safeParse(text(form, "reference"));
  if (!ref.success) return inputError("reference");
  return finish(
    ctx,
    await recordPerDiemPayments(ctx.viewer.db, {
      perDiemIds: perDiems.data,
      paidOn: paidOn.data,
      reference: ref.data,
    }),
  );
}

/** Parses a positive major-unit amount in the currency, or null. */
async function positiveAmount(
  ctx: OrgContext,
  value: string,
  currency: string,
): Promise<number | null> {
  const exponent = exponentOf(await getExponents(ctx), currency);
  const parsed = finance.parseMoney(value, exponent);
  return parsed === null || parsed <= 0 ? null : parsed;
}

export async function saveExpenseCreditAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const original = z.uuid().safeParse(text(form, "originalId"));
  if (!original.success) return { error: { kind: "not-found" }, at: Date.now() };
  const description = required.safeParse(text(form, "description"));
  if (!description.success) return inputError("description");
  const incurredOn = z.iso.date().safeParse(text(form, "incurredOn"));
  if (!incurredOn.success) return inputError("incurredOn", "date");
  const amount = await positiveAmount(ctx, text(form, "amount"), text(form, "currency"));
  if (amount === null) return inputError("amount");
  const creditId = text(form, "id");
  if (creditId) {
    const id = z.uuid().safeParse(creditId);
    if (!id.success) return { error: { kind: "not-found" }, at: Date.now() };
    return finish(
      ctx,
      await finance.updateExpenseCredit(ctx.viewer.db, id.data, {
        amountMinor: amount,
        incurredOn: incurredOn.data,
        description: description.data,
      }),
    );
  }
  const result = await finance.createExpenseCredit(ctx.viewer.db, ctx.org.id, {
    originalId: original.data,
    amountMinor: amount,
    incurredOn: incurredOn.data,
    description: description.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

/**
 * The look-alike check of an expense not yet saved (3016): how many others look like it. A warning, so any failure
 * reads as none and never stops the save.
 */
export async function findExpenseLookAlikesAction(form: FormData): Promise<number> {
  const ctx = await contextFor(form);
  const line = z.uuid().safeParse(text(form, "budgetLineId"));
  const incurredOn = z.iso.date().safeParse(text(form, "incurredOn"));
  const counterparty = text(form, "counterpartyId");
  if (!line.success || !incurredOn.success) return 0;
  const amount = await positiveAmount(ctx, text(form, "amount"), text(form, "currency"));
  if (amount === null) return 0;
  const found = await finance.findExpenseDuplicates(ctx.viewer.db, {
    budgetLineId: line.data,
    counterpartyId: counterparty === "" ? null : counterparty,
    amountMinor: amount,
    incurredOn: incurredOn.data,
    excludeExpenseId: text(form, "id") || null,
  });
  return found.ok ? found.data.length : 0;
}
