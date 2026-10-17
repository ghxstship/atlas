"use server";

import type { DataError, Result } from "@xos/data";
import * as finance from "@xos/data/finance";
import * as settlements from "@xos/data/settlements";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { exponentOf, getExponents } from "@/lib/finance/money";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * Finance mutations (A15). Every action resolves the viewer's org context again (404 when it is
 * gone), validates its input with Zod, and calls the repository; row level security and A03's RPCs
 * decide every write. Database refusals (SQLSTATE XR001) come back with their rule code, which the
 * page turns into catalog copy under `finance.refusals`, so spend authority and separation of
 * duties refusals name their rule (Sections 8.1 and 8.2). Money arrives as typed major units and is
 * parsed to minor units with the currency's exponent; a blank price stays NULL (Section 3.7).
 */

export type ActionError =
  | { readonly kind: "refusal"; readonly rule: string; readonly message: string }
  | { readonly kind: "not-found" | "conflict" | "invalid" | "unexpected" | "input" };

export interface ActionState {
  readonly ok?: boolean;
  readonly error?: ActionError;
  /** Approval recorded, but a second approver is still needed (Section 8.1 dual threshold). */
  readonly pending?: boolean;
  readonly id?: string;
  readonly ids?: readonly string[];
  /** The line as someone else saved it, when a save started from an older version. */
  readonly conflict?: finance.BudgetLine;
  /** The line as saved, with its new version. */
  readonly line?: finance.BudgetLine;
  readonly csv?: string;
  readonly filename?: string;
  /** Field name to catalog key under `finance.errors`. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Increments on every completed submit, so forms can react to repeated successes. */
  readonly at?: number;
}

function toActionError(error: DataError): ActionError {
  if (error.kind === "refusal") return error;
  if (error.kind === "unexpected") {
    console.error("finance action failed", error);
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

const text = (max = 500) => z.string().trim().min(1).max(max);
const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === "" ? null : s));
const optionalId = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s))
  .pipe(z.uuid().nullable());
const isoDate = z.iso.date();
const optionalDate = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s))
  .pipe(isoDate.nullable());
const currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);
const quantity = z.coerce.number().min(0).max(1e9);
const reason = text(500);

function fields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

/** Parses a major-unit amount; blank is null (unpriced) unless `required`. */
async function money(
  ctx: OrgContext,
  value: string | undefined,
  code: string,
  required: boolean,
): Promise<number | null | "invalid"> {
  const parsed = finance.parseMoney(value ?? "", exponentOf(await getExponents(ctx), code));
  if (parsed === null && required) return "invalid";
  return parsed;
}

function inputError(field: string, key = field): ActionState {
  return { error: { kind: "input" }, fieldErrors: { [field]: key }, at: Date.now() };
}

// Budgets ------------------------------------------------------------------------------------------

export async function saveBudgetAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const name = text(200).safeParse(f["name"]);
  if (!name.success) return inputError("name");
  const isBaseline = f["isBaseline"] === "on" || f["isBaseline"] === "true";
  if (f["id"]) {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(
      ctx,
      await finance.updateBudget(ctx.viewer.db, id.data, { name: name.data, isBaseline }),
    );
  }
  const projectId = z.uuid().safeParse(f["projectId"]);
  if (!projectId.success) return inputError("projectId");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return inputError("currency");
  const result = await finance.createBudget(ctx.viewer.db, ctx.org.id, {
    projectId: projectId.data,
    name: name.data,
    currency: code.data,
    isBaseline,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function deleteBudgetAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: { kind: "not-found" } };
  return finish(ctx, await finance.deleteBudget(ctx.viewer.db, id.data));
}

const LineSchema = z.object({
  description: text(500),
  lineType: z.enum(["Cost", "Labor", "Fee", "Contingency"]),
  urid: z.string().regex(/^\d{4}\.\d{2}(\.\d{2})?$/),
  costCenterId: z.uuid().nullable(),
  gradeCode: z.string().min(1).nullable(),
  elementId: z.string().min(1).nullable(),
  quantity: z.number().min(0).max(1e9),
  unitBasis: z.string().min(1).nullable(),
  unitPriceMinor: z.number().int().min(0).nullable(),
  xyz: z.enum(["X", "Y", "Z"]),
  xyzBasis: z.enum(["Category", "Declared"]),
});

/** Appends one or many lines (single add, catalog picks or a spreadsheet paste) as one batch. */
export async function addBudgetLinesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const budgetId = z.uuid().safeParse(form.get("budgetId"));
  if (!budgetId.success) return { error: { kind: "not-found" } };
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("lines") ?? "[]"));
  } catch (error) {
    console.error("budget lines payload is not JSON", error);
    return inputError("lines");
  }
  const lines = z.array(LineSchema).min(1).max(1000).safeParse(raw);
  if (!lines.success) return inputError("lines");
  const result = await finance.addBudgetLines(ctx.viewer.db, ctx.org.id, budgetId.data, lines.data);
  return finish(ctx, result, result.ok ? { ids: result.data.ids } : {});
}

/** Saves one line against the version it was read at; a newer save comes back as a conflict. */
export async function updateBudgetLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  const expected = z.string().min(1).safeParse(form.get("expectedUpdatedAt"));
  if (!id.success || !expected.success) return { error: { kind: "not-found" } };
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("line") ?? "{}"));
  } catch (error) {
    console.error("budget line payload is not JSON", error);
    return inputError("line");
  }
  const line = LineSchema.safeParse(raw);
  if (!line.success) return inputError("line");
  const result = await finance.updateBudgetLine(ctx.viewer.db, id.data, expected.data, line.data);
  if (!result.ok && result.error.kind === "line-conflict") {
    return { error: { kind: "conflict" }, conflict: result.error.current, at: Date.now() };
  }
  if (!result.ok) return finish(ctx, result as Result<unknown>);
  return finish(ctx, result, { line: result.data });
}

export async function deleteBudgetLinesAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const ids = z
    .array(z.uuid())
    .min(1)
    .safeParse(String(form.get("ids") ?? "").split(","));
  if (!ids.success) return { error: { kind: "not-found" } };
  const restore = form.get("restore") === "1";
  const result = restore
    ? await finance.restoreBudgetLines(ctx.viewer.db, ids.data)
    : await finance.deleteBudgetLines(ctx.viewer.db, ids.data);
  return finish(ctx, result, { ids: ids.data });
}

export async function drawContingencyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const ids = z.object({ fromLineId: z.uuid(), toLineId: z.uuid() }).safeParse(f);
  if (!ids.success) return inputError("toLineId");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return { error: { kind: "invalid" } };
  const amount = await money(ctx, f["amount"], code.data, true);
  if (amount === "invalid" || amount === null || amount <= 0) return inputError("amount");
  const why = reason.safeParse(f["reason"]);
  if (!why.success) return inputError("reason");
  return finish(
    ctx,
    await finance.drawContingency(ctx.viewer.db, ctx.org.id, {
      ...ids.data,
      amountMinor: amount,
      reason: why.data,
    }),
  );
}

// Expenses -----------------------------------------------------------------------------------------

export async function saveExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const description = text(500).safeParse(f["description"]);
  if (!description.success) return inputError("description");
  const incurredOn = isoDate.safeParse(f["incurredOn"]);
  if (!incurredOn.success) return inputError("incurredOn", "date");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return inputError("budgetLineId");
  const amount = await money(ctx, f["amount"], code.data, true);
  if (amount === "invalid" || amount === null || amount <= 0) return inputError("amount");
  const counterparty = optionalId.safeParse(f["counterpartyId"] ?? "");
  if (!counterparty.success) return inputError("counterpartyId");
  const common = {
    counterpartyId: counterparty.data,
    description: description.data,
    incurredOn: incurredOn.data,
    amountMinor: amount,
    currency: code.data,
  };
  if (f["id"]) {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.updateExpense(ctx.viewer.db, id.data, common));
  }
  const line = z.uuid().safeParse(f["budgetLineId"]);
  if (!line.success) return inputError("budgetLineId");
  const result = await finance.createExpense(ctx.viewer.db, ctx.org.id, {
    ...common,
    budgetLineId: line.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

// Change orders ------------------------------------------------------------------------------------

export async function saveChangeOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const title = text(200).safeParse(f["title"]);
  if (!title.success) return inputError("title");
  const orderType = z
    .string()
    .trim()
    .transform((s) => (s === "" ? null : s))
    .safeParse(f["orderTypeId"] ?? "");
  const why = optionalText(2000).safeParse(f["reason"] ?? "");
  if (!orderType.success || !why.success) return inputError("reason");
  if (f["id"]) {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(
      ctx,
      await finance.updateChangeOrder(ctx.viewer.db, id.data, {
        title: title.data,
        orderTypeId: orderType.data,
        reason: why.data,
      }),
    );
  }
  const budget = z.uuid().safeParse(f["budgetId"]);
  const project = z.uuid().safeParse(f["projectId"]);
  if (!budget.success || !project.success) return inputError("budgetId");
  const result = await finance.createChangeOrder(ctx.viewer.db, ctx.org.id, {
    projectId: project.data,
    budgetId: budget.data,
    title: title.data,
    orderTypeId: orderType.data,
    reason: why.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function saveChangeOrderLineAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  if (f["delete"] === "1") {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.deleteChangeOrderLine(ctx.viewer.db, id.data));
  }
  const description = text(500).safeParse(f["description"]);
  if (!description.success) return inputError("description");
  const urid = z
    .string()
    .regex(/^\d{4}\.\d{2}(\.\d{2})?$/)
    .safeParse(f["urid"]);
  if (!urid.success) return inputError("urid");
  const qty = quantity.safeParse(f["quantity"] || "1");
  if (!qty.success) return inputError("quantity");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return { error: { kind: "invalid" } };
  const isNoCost = f["isNoCost"] === "on";
  const price = isNoCost ? 0 : await money(ctx, f["unitPrice"], code.data, false);
  if (price === "invalid" || (price !== null && price < 0)) return inputError("unitPrice");
  if (price === 0 && !isNoCost) return inputError("unitPrice", "zeroNeedsNoCost");
  const budgetLine = optionalId.safeParse(f["budgetLineId"] ?? "");
  if (!budgetLine.success) return inputError("budgetLineId");
  const input = {
    budgetLineId: budgetLine.data,
    description: description.data,
    urid: urid.data,
    quantity: qty.data,
    unitPriceMinor: price,
    isNoCost,
  };
  if (f["id"]) {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.updateChangeOrderLine(ctx.viewer.db, id.data, input));
  }
  const order = z.uuid().safeParse(f["changeOrderId"]);
  if (!order.success) return { error: { kind: "not-found" } };
  return finish(
    ctx,
    await finance.addChangeOrderLine(ctx.viewer.db, ctx.org.id, order.data, input),
  );
}

// Invoices and payments ------------------------------------------------------------------------------

export async function saveInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const number = optionalText(100).safeParse(f["number"] ?? "");
  const issuedOn = optionalDate.safeParse(f["issuedOn"] ?? "");
  const dueOn = optionalDate.safeParse(f["dueOn"] ?? "");
  if (!number.success) return inputError("number");
  if (!issuedOn.success) return inputError("issuedOn", "date");
  if (!dueOn.success) return inputError("dueOn", "date");
  const dates = { number: number.data, issuedOn: issuedOn.data, dueOn: dueOn.data };
  if (f["id"]) {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.updateInvoice(ctx.viewer.db, id.data, dates));
  }
  const project = z.uuid().safeParse(f["projectId"]);
  if (!project.success) return inputError("projectId");
  const counterparty = z.uuid().safeParse(f["counterpartyId"]);
  if (!counterparty.success) return inputError("counterpartyId");
  const direction = z.enum(["Receivable", "Payable"]).safeParse(f["direction"]);
  if (!direction.success) return inputError("direction");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return inputError("currency");
  const result = await finance.createInvoice(ctx.viewer.db, ctx.org.id, {
    ...dates,
    projectId: project.data,
    counterpartyId: counterparty.data,
    direction: direction.data,
    currency: code.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function saveInvoiceLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  if (f["delete"] === "1") {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.deleteInvoiceLine(ctx.viewer.db, id.data));
  }
  const invoice = z.uuid().safeParse(f["invoiceId"]);
  if (!invoice.success) return { error: { kind: "not-found" } };
  const description = text(500).safeParse(f["description"]);
  if (!description.success) return inputError("description");
  const qty = quantity.safeParse(f["quantity"] || "1");
  if (!qty.success) return inputError("quantity");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return { error: { kind: "invalid" } };
  const price = await money(ctx, f["unitPrice"], code.data, false);
  if (price === "invalid" || (price !== null && price < 0)) return inputError("unitPrice");
  const budgetLine = optionalId.safeParse(f["budgetLineId"] ?? "");
  if (!budgetLine.success) return inputError("budgetLineId");
  return finish(
    ctx,
    await finance.addInvoiceLine(ctx.viewer.db, ctx.org.id, invoice.data, {
      description: description.data,
      quantity: qty.data,
      unitPriceMinor: price,
      budgetLineId: budgetLine.data,
    }),
  );
}

export async function savePaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const counterparty = z.uuid().safeParse(f["counterpartyId"]);
  if (!counterparty.success) return inputError("counterpartyId");
  const direction = z.enum(["Receivable", "Payable"]).safeParse(f["direction"]);
  if (!direction.success) return inputError("direction");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return inputError("currency");
  const amount = await money(ctx, f["amount"], code.data, true);
  if (amount === "invalid" || amount === null || amount <= 0) return inputError("amount");
  const paidOn = isoDate.safeParse(f["paidOn"]);
  if (!paidOn.success) return inputError("paidOn", "date");
  const reference = optionalText(200).safeParse(f["reference"] ?? "");
  if (!reference.success) return inputError("reference");
  const result = await finance.createPayment(ctx.viewer.db, ctx.org.id, {
    counterpartyId: counterparty.data,
    direction: direction.data,
    amountMinor: amount,
    currency: code.data,
    paidOn: paidOn.data,
    reference: reference.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function applyPaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  if (f["remove"]) {
    const id = z.uuid().safeParse(f["remove"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.removePaymentApplication(ctx.viewer.db, id.data));
  }
  const ids = z.object({ paymentId: z.uuid(), invoiceId: z.uuid() }).safeParse(f);
  if (!ids.success) return inputError("invoiceId");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return { error: { kind: "invalid" } };
  const amount = await money(ctx, f["amount"], code.data, true);
  if (amount === "invalid" || amount === null || amount <= 0) return inputError("amount");
  return finish(
    ctx,
    await finance.applyPayment(ctx.viewer.db, ctx.org.id, { ...ids.data, amountMinor: amount }),
  );
}

/**
 * Records that an approved payable (or issued receivable) was paid, as a Proposed payment of the
 * invoice's payee applied to it (A38-007). A blank amount pays the whole balance. Money moves on the
 * org's own rails; the reference is the remittance the bank or payout provider gave.
 */
export async function recordInvoicePaymentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const invoice = z.uuid().safeParse(f["invoiceId"]);
  if (!invoice.success) return { error: { kind: "not-found" } };
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return { error: { kind: "invalid" } };
  const amount = await money(ctx, f["amount"], code.data, false);
  if (amount === "invalid" || (amount !== null && amount <= 0)) return inputError("amount");
  const paidOn = isoDate.safeParse(f["paidOn"]);
  if (!paidOn.success) return inputError("paidOn", "date");
  const reference = optionalText(200).safeParse(f["reference"] ?? "");
  if (!reference.success) return inputError("reference");
  const result = await finance.payInvoice(ctx.viewer.db, finance.manualPayout(reference.data), {
    invoiceId: invoice.data,
    amountMinor: amount,
    currency: code.data,
    paidOn: paidOn.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

// Periods, journal, cost centers and rates ---------------------------------------------------------------

export async function createPeriodAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const startsOn = isoDate.safeParse(f["startsOn"]);
  const endsOn = isoDate.safeParse(f["endsOn"]);
  if (!startsOn.success) return inputError("startsOn", "date");
  if (!endsOn.success || endsOn.data < startsOn.data) return inputError("endsOn", "endBeforeStart");
  const result = await finance.createPeriod(ctx.viewer.db, ctx.org.id, {
    startsOn: startsOn.data,
    endsOn: endsOn.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

const JournalLineSchema = z.object({
  accountCode: z.string().regex(/^\d{4}$/),
  costCenterId: z.uuid().nullable(),
  urid: z
    .string()
    .regex(/^\d{4}\.\d{2}(\.\d{2})?$/)
    .nullable(),
  description: text(500),
  debit: z.string(),
  credit: z.string(),
});

export async function createJournalEntryAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const period = z.uuid().safeParse(f["periodId"]);
  if (!period.success) return inputError("periodId");
  const entryDate = isoDate.safeParse(f["entryDate"]);
  if (!entryDate.success) return inputError("entryDate", "date");
  const memo = text(500).safeParse(f["memo"]);
  if (!memo.success) return inputError("memo");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return inputError("currency");
  const project = optionalId.safeParse(f["projectId"] ?? "");
  if (!project.success) return inputError("projectId");
  let raw: unknown;
  try {
    raw = JSON.parse(f["lines"] ?? "[]");
  } catch (error) {
    console.error("journal lines payload is not JSON", error);
    return inputError("lines");
  }
  const parsed = z.array(JournalLineSchema).min(2).max(200).safeParse(raw);
  if (!parsed.success) return inputError("lines");
  const lines: finance.JournalLineInput[] = [];
  for (const l of parsed.data) {
    const debit = (await money(ctx, l.debit, code.data, false)) ?? 0;
    const credit = (await money(ctx, l.credit, code.data, false)) ?? 0;
    if (debit === "invalid" || credit === "invalid" || debit < 0 || credit < 0)
      return inputError("lines", "lineAmount");
    if ((debit === 0) === (credit === 0)) return inputError("lines", "oneSide");
    lines.push({
      accountCode: l.accountCode,
      costCenterId: l.costCenterId,
      urid: l.urid,
      description: l.description,
      debitMinor: debit,
      creditMinor: credit,
    });
  }
  const debits = lines.reduce((s, l) => s + l.debitMinor, 0);
  const credits = lines.reduce((s, l) => s + l.creditMinor, 0);
  if (debits !== credits) return inputError("lines", "unbalanced");
  const result = await finance.createJournalEntry(ctx.viewer.db, ctx.org.id, {
    periodId: period.data,
    projectId: project.data,
    entryDate: entryDate.data,
    memo: memo.data,
    currency: code.data,
    lines,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function saveCostCenterAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  if (f["delete"] === "1") {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.deleteCostCenter(ctx.viewer.db, id.data));
  }
  const code = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^CC-[A-Z0-9-]{1,32}$/)
    .safeParse(f["code"]);
  if (!code.success) return inputError("code", "costCenterCode");
  const name = text(200).safeParse(f["name"]);
  if (!name.success) return inputError("name");
  const kind = z.enum(["Standing", "Overhead", "Event"]).safeParse(f["kind"]);
  if (!kind.success) return inputError("kind");
  const scope = optionalId.safeParse(f["scopeNodeId"] ?? "");
  if (!scope.success || (kind.data === "Event" && !scope.data))
    return inputError("scopeNodeId", "eventScope");
  const input = { code: code.data, name: name.data, kind: kind.data, scopeNodeId: scope.data };
  if (f["id"]) {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await finance.updateCostCenter(ctx.viewer.db, id.data, input));
  }
  const result = await finance.createCostCenter(ctx.viewer.db, ctx.org.id, input);
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function createFxRateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const base = currency.safeParse(f["base"]);
  const quote = currency.safeParse(f["quote"]);
  if (!base.success) return inputError("base", "currency");
  if (!quote.success || quote.data === base.data) return inputError("quote", "currency");
  const rate = z.coerce.number().positive().max(1e9).safeParse(f["rate"]);
  if (!rate.success) return inputError("rate");
  const effectiveOn = isoDate.safeParse(f["effectiveOn"]);
  if (!effectiveOn.success) return inputError("effectiveOn", "date");
  const source = text(200).safeParse(f["source"]);
  if (!source.success) return inputError("source");
  return finish(
    ctx,
    await finance.createFxRate(ctx.viewer.db, {
      orgId: ctx.org.id,
      base: base.data,
      quote: quote.data,
      rate: rate.data,
      effectiveOn: effectiveOn.data,
      source: source.data,
    }),
  );
}

// Lifecycle transitions ----------------------------------------------------------------------------------

const TransitionSchema = z.object({
  lifecycle: z.enum([
    "expense",
    "change_order",
    "invoice",
    "payment",
    "journal",
    "accounting_period",
    "settlement",
  ]),
  id: z.uuid(),
  expected: z.string().min(1),
  next: z.string().min(1),
  reason,
});

/**
 * Moves a finance document along its lifecycle. Approvals go through the approval RPCs, which apply
 * spend authority and separation of duties and may record an approval that still needs a second
 * approver; everything else goes through the compare-and-set transition RPCs.
 */
export async function transitionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = TransitionSchema.safeParse(fields(form));
  if (!parsed.success) return inputError("reason");
  const { lifecycle, id, expected, next, reason: why } = parsed.data;
  const db = ctx.viewer.db;
  const pending = (r: Result<finance.ApprovalOutcome>) =>
    finish(ctx, r, r.ok && !r.data.complete ? { pending: true } : {});
  switch (lifecycle) {
    case "expense":
      if (next === "Approved") return pending(await finance.approveExpense(db, id, why));
      if (next === "Rejected") return finish(ctx, await finance.rejectExpense(db, id, why));
      return finish(
        ctx,
        await finance.transitionExpense(db, {
          id,
          expected: expected as finance.ExpenseState,
          next: next as finance.ExpenseState,
          reason: why,
        }),
      );
    case "change_order":
      if (next === "Priced") return finish(ctx, await finance.priceChangeOrder(db, id, why));
      if (next === "Approved") return pending(await finance.approveChangeOrder(db, id, why));
      return finish(
        ctx,
        await finance.transitionChangeOrder(db, {
          id,
          expected: expected as finance.ChangeOrderState,
          next: next as finance.ChangeOrderState,
          reason: why,
        }),
      );
    case "invoice":
      if (next === "Issued" && expected === "Proposed")
        return finish(ctx, await finance.issueInvoice(db, id, why));
      if (next === "Approved") return pending(await finance.approveInvoice(db, id, why));
      return finish(
        ctx,
        await finance.transitionInvoice(db, {
          id,
          expected: expected as finance.InvoiceState,
          next: next as finance.InvoiceState,
          reason: why,
        }),
      );
    case "payment":
      if (next === "Approved") return finish(ctx, await finance.approvePayment(db, id, why));
      return finish(ctx, await finance.cancelPayment(db, id, why));
    case "journal":
      if (next === "Posted") return finish(ctx, await finance.postJournalEntry(db, id, why));
      return finish(ctx, await finance.cancelJournalEntry(db, id, why));
    case "settlement":
      if (next === "Submitted") return pending(await settlements.submitSettlement(db, id, why));
      return finish(
        ctx,
        await settlements.transitionSettlement(db, {
          id,
          expected: expected as settlements.SettlementState,
          next: next as settlements.SettlementState,
          reason: why,
        }),
      );
    case "accounting_period":
      return finish(
        ctx,
        await finance.transitionPeriod(db, {
          id,
          expected: expected as finance.PeriodState,
          next: next as finance.PeriodState,
          reason: why,
        }),
      );
  }
}

// Universal Posting Line export ----------------------------------------------------------------------------

/**
 * Builds the UPL export for a date range as CSV: the one UPL shape, or its projection to one of the
 * canon accounting mappings. Needs finance.upl.export; the file is generated on demand and never
 * stored (Section 8.6: Internal data, exported by members who hold the capability).
 */
export async function exportUplAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const from = isoDate.safeParse(f["from"]);
  const to = isoDate.safeParse(f["to"]);
  if (!from.success) return inputError("from", "date");
  if (!to.success || to.data < from.data) return inputError("to", "endBeforeStart");
  const target = z
    .string()
    .regex(/^[a-z]+$/)
    .safeParse(f["target"] || "upl");
  if (!target.success) return inputError("target");
  const project = optionalId.safeParse(f["projectId"] ?? "");
  if (!project.success) return inputError("projectId");
  const [lines, mappings, exponents] = await Promise.all([
    finance.listPostingLines(ctx.viewer.db, {
      orgId: ctx.org.id,
      from: from.data,
      to: to.data,
      projectId: project.data,
    }),
    finance.listUplMappings(ctx.viewer.db),
    getExponents(ctx),
  ]);
  if (!lines.ok) return { error: toActionError(lines.error) };
  if (!mappings.ok) return { error: toActionError(mappings.error) };
  const mapping =
    target.data === "upl" ? null : (mappings.data.find((m) => m.target === target.data) ?? null);
  if (target.data !== "upl" && !mapping) return inputError("target");
  const rows = lines.data.map((l) => finance.toUplRow(l, exponentOf(exponents, l.currency)));
  const { header, body } = finance.projectUpl(rows, mapping);
  return {
    ok: true,
    at: Date.now(),
    csv: finance.toCsv(header, body),
    filename: `upl-${target.data}-${from.data}-to-${to.data}.csv`,
  };
}

// Catalog search -----------------------------------------------------------------------------------------

export interface CatalogSearchState {
  readonly elements?: readonly finance.CatalogElement[];
  readonly error?: ActionError;
}

/** Searches catalog elements with their price per grade for the budget's add-from-catalog sheet. */
export async function searchCatalogAction(
  _: CatalogSearchState,
  form: FormData,
): Promise<CatalogSearchState> {
  const ctx = await contextFor(form);
  const search = z
    .string()
    .trim()
    .max(100)
    .safeParse(form.get("search") ?? "");
  if (!search.success) return { error: { kind: "input" } };
  const result = await finance.searchCatalogElements(ctx.viewer.db, { search: search.data });
  return result.ok ? { elements: result.data } : { error: toActionError(result.error) };
}

// Settlements and self-billing ---------------------------------------------------------------------------

export async function saveSettlementAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const engagement = z.uuid().safeParse(f["engagementId"]);
  if (!engagement.success) return inputError("engagementId");
  const title = text(200).safeParse(f["title"]);
  if (!title.success) return inputError("title");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return inputError("currency");
  const settledOn = optionalDate.safeParse(f["settledOn"] ?? "");
  if (!settledOn.success) return inputError("settledOn", "date");
  const result = await settlements.createSettlement(ctx.viewer.db, ctx.org.id, {
    engagementId: engagement.data,
    title: title.data,
    currency: code.data,
    settledOn: settledOn.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}

export async function saveSettlementLineAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  if (f["delete"] === "1") {
    const id = z.uuid().safeParse(f["id"]);
    if (!id.success) return { error: { kind: "not-found" } };
    return finish(ctx, await settlements.deleteSettlementLine(ctx.viewer.db, id.data));
  }
  const settlement = z.uuid().safeParse(f["settlementId"]);
  if (!settlement.success) return { error: { kind: "not-found" } };
  const kind = z.enum(settlements.SETTLEMENT_LINE_KINDS).safeParse(f["kind"]);
  if (!kind.success) return inputError("kind");
  const description = text(500).safeParse(f["description"]);
  if (!description.success) return inputError("description");
  const code = currency.safeParse(f["currency"]);
  if (!code.success) return { error: { kind: "invalid" } };
  const amount = await money(ctx, f["amount"], code.data, false);
  if (amount === "invalid" || (amount !== null && amount < 0))
    return inputError("amount", "unitPrice");
  return finish(
    ctx,
    await settlements.addSettlementLine(ctx.viewer.db, ctx.org.id, settlement.data, {
      kind: kind.data,
      description: description.data,
      amountMinor: amount,
    }),
  );
}

/** Generates a self-billed payable invoice from approved timesheets (Section 4.4.5). */
export async function selfBillAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const f = fields(form);
  const engagement = z.uuid().safeParse(f["engagementId"]);
  if (!engagement.success) return inputError("engagementId");
  const start = isoDate.safeParse(f["periodStart"]);
  const end = isoDate.safeParse(f["periodEnd"]);
  if (!start.success) return inputError("periodStart", "date");
  if (!end.success || end.data < start.data) return inputError("periodEnd", "endBeforeStart");
  const result = await settlements.generateSelfBilledInvoice(ctx.viewer.db, {
    engagementId: engagement.data,
    periodStart: start.data,
    periodEnd: end.data,
  });
  return finish(ctx, result, result.ok ? { id: result.data.id } : {});
}
