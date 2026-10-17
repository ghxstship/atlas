/**
 * Finance handlers (A15). Every read and write runs as the caller, so row level security decides
 * every row; the lifecycle RPCs, spend authority and separation of duties (Section 8.1) decide every
 * transition and approval, and their refusals return 422 with the rule. Shapes are the corrected
 * ones of catalog/modules/finance.ts (ADR 0023): column names throughout, totals as `MoneyTotal`
 * (the priced inputs summed, the unpriced ones counted, never coerced to zero, Section 3.7).
 *
 * An approval that needs a second approver (an amount above the dual threshold) answers 200 with the
 * document still in its prior state; the second approver's call completes it.
 */
import type { XosClient } from "@xos/data";
import {
  approveChangeOrder,
  approveExpense,
  approveInvoice,
  extendedMinor,
  issueInvoice,
  recordInvoicePayment,
  listCurrencies,
  listPostingLines,
  listUplMappings,
  postJournalEntry,
  priceChangeOrder,
  projectUpl,
  toCsv,
  toUplRow,
  transitionChangeOrder,
  transitionExpense,
  transitionInvoice,
  transitionPeriod,
  type ChangeOrderState,
  type ExpenseState,
  type InvoiceState,
  type PeriodState,
} from "@xos/data/finance";
import { conflict, refused } from "../problem.ts";
import type { RequestContext } from "../runtime/context.ts";
import { requireOrg } from "../runtime/context.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { from, handlersFor, run, tableResource, unwrap } from "./support/table.ts";
import type { Row, TableResource } from "./support/table.ts";

interface MoneyTotal {
  total_minor: number | null;
  currency: string;
  unpriced_count: number;
}

/** The API's MoneyTotal: priced amounts summed, unpriced counted; zero for no inputs. */
export function moneyTotal(amounts: readonly (number | null)[], currency: string): MoneyTotal {
  const priced = amounts.filter((a): a is number => a !== null);
  return {
    total_minor:
      priced.length === 0 && amounts.length > 0 ? null : priced.reduce((s, a) => s + a, 0),
    currency: currency.trim(),
    unpriced_count: amounts.length - priced.length,
  };
}

const live = (q: ReturnType<typeof from>) => q.is("deleted_at", null);

/** Extended amounts of a document's lines: quantity times unit price, null when unpriced. */
async function lineAmounts(db: XosClient, table: string, column: string, id: string) {
  const lines = await run<Row[]>(
    live(from(db, table).select("quantity, unit_price_minor").eq(column, id)),
  );
  return lines.map((l) =>
    extendedMinor(Number(l["quantity"] ?? 1), (l["unit_price_minor"] as number | null) ?? null),
  );
}

async function budgetCurrency(db: XosClient, budgetId: string): Promise<string> {
  const budget = await run<Row | null>(
    from(db, "budgets").select("currency_code").eq("id", budgetId).maybeSingle(),
  );
  return String(budget?.["currency_code"] ?? "");
}

/** Throws 409 unless the row is in the state the caller expects (compare-and-set). */
function expectState(current: Row, column: string, expected: string, label: string): void {
  if (current[column] !== expected) {
    throw conflict(
      `The ${label} is ${String(current[column])}, not ${expected}; read it again before changing it.`,
    );
  }
}

const reasonOf = (body: { reason?: string | undefined }) => body.reason ?? "";

// Resources --------------------------------------------------------------------------------------------

const budgets = tableResource("budgets");
const budgetLines = tableResource("budgetLines", {
  derived: ["line_total_minor"],
  toContract: (row) => ({
    ...row,
    line_total_minor: extendedMinor(
      Number(row["quantity"] ?? 1),
      (row["unit_price_minor"] as number | null) ?? null,
    ),
  }),
});
const expenses = tableResource("expenses");
const contingencyDraws = tableResource("contingencyDraws");
const changeOrders = tableResource("changeOrders", {
  derived: ["total"],
  toContract: async (row, { db }) => ({
    ...row,
    total: moneyTotal(
      await lineAmounts(db, "change_order_lines", "change_order_id", String(row["id"])),
      await budgetCurrency(db, String(row["budget_id"])),
    ),
  }),
});
const changeOrderLines = tableResource("changeOrderLines");
const accountingPeriods = tableResource("accountingPeriods");
const journalEntries = tableResource("journalEntries");
const journalLines = tableResource("journalLines");
const postingLines = tableResource("postingLines", { softDelete: false, key: "posting_line_id" });
const invoices = tableResource("invoices", {
  derived: ["total"],
  extraColumns: ["currency_code"],
  toContract: async (row, { db }) => ({
    ...row,
    total: moneyTotal(
      await lineAmounts(db, "invoice_lines", "invoice_id", String(row["id"])),
      String(row["currency_code"] ?? ""),
    ),
  }),
});
const invoiceLines = tableResource("invoiceLines");
const paymentApplications = tableResource("paymentApplications", {
  derived: ["paid_on", "currency_code", "external_ref"],
  extraColumns: ["payment_id"],
  toContract: async (row, { db }) => {
    const payment = await run<Row | null>(
      from(db, "payments")
        .select("paid_on, currency_code, reference_identifier")
        .eq("id", row["payment_id"])
        .maybeSingle(),
    );
    return {
      ...row,
      paid_on: payment?.["paid_on"] ?? null,
      currency_code: String(payment?.["currency_code"] ?? "").trim(),
      external_ref: payment?.["reference_identifier"] ?? null,
    };
  },
});
const billingDraws = tableResource("billingDraws");
const costCenters = tableResource("costCenters");
const taxJurisdictions = tableResource("taxJurisdictions");
const taxRates = tableResource("taxRates");
const fxRates = tableResource("fxRates", { key: "id" });

/** Reads after a write, as the corrected read shape of the resource. */
const reread = async (resource: TableResource, context: RequestContext, id: string) =>
  (await resource.read(context, id)) as never;

// Budget summary ---------------------------------------------------------------------------------------

const COMMITTED_PO_STATES = new Set(["Approved", "Sent", "Closed"]);

async function budgetSummary(context: RequestContext, budgetId: string) {
  const { db } = context;
  const budget = await budgets.read(context, budgetId, ["id", "currency_code"]);
  const currency = String(budget["currency_code"]);
  const facts = await run<Row[]>(
    from(db, "budget_line_facts")
      .select("budget_line_id, extended_minor, actual_minor")
      .eq("budget_id", budgetId),
  );
  const estimate = moneyTotal(
    facts.map((f) => (f["extended_minor"] as number | null) ?? null),
    currency,
  );
  const actualMinor = facts.reduce((s, f) => s + Number(f["actual_minor"] ?? 0), 0);
  const lineIds = facts.map((f) => String(f["budget_line_id"]));
  const poLines =
    lineIds.length === 0
      ? []
      : await run<Row[]>(
          live(
            from(db, "po_lines")
              .select("purchase_order_id, quantity, unit_price_minor")
              .in("budget_line_id", lineIds),
          ),
        );
  const orderIds = [...new Set(poLines.map((l) => String(l["purchase_order_id"])))];
  const orders =
    orderIds.length === 0
      ? []
      : await run<Row[]>(
          live(
            from(db, "purchase_orders").select("id, po_state, currency_code").in("id", orderIds),
          ),
        );
  const committedOrders = new Set(
    orders
      .filter(
        (o) =>
          COMMITTED_PO_STATES.has(String(o["po_state"])) &&
          String(o["currency_code"]).trim() === currency.trim(),
      )
      .map((o) => String(o["id"])),
  );
  const committed = moneyTotal(
    poLines
      .filter((l) => committedOrders.has(String(l["purchase_order_id"])))
      .map((l) =>
        extendedMinor(Number(l["quantity"] ?? 1), (l["unit_price_minor"] as number | null) ?? null),
      ),
    currency,
  );
  return {
    budget_id: budgetId,
    estimate,
    committed,
    actual: { total_minor: actualMinor, currency: currency.trim(), unpriced_count: 0 },
    variance: {
      total_minor: estimate.total_minor === null ? null : estimate.total_minor - actualMinor,
      currency: currency.trim(),
      unpriced_count: estimate.unpriced_count,
    },
  };
}

// UPL export ---------------------------------------------------------------------------------------------

async function exportPostings(
  context: RequestContext,
  body: { target: string; accounting_period_id: string },
) {
  const period = await accountingPeriods.read(context, body.accounting_period_id, [
    "id",
    "starts_on",
    "ends_on",
  ]);
  const from_ = String(period["starts_on"]);
  const to = String(period["ends_on"]);
  const [lines, mappings, currencies] = await Promise.all([
    listPostingLines(context.db, { orgId: requireOrg(context).id, from: from_, to }),
    listUplMappings(context.db),
    listCurrencies(context.db),
  ]);
  const mapping = unwrap(mappings).find((m) => m.target === body.target);
  if (mapping === undefined) {
    throw refused(
      "NO_ANSWER",
      `The canon has no field mapping for ${body.target}, so the lines cannot be projected to it.`,
      "upl_mapping_missing",
    );
  }
  const exponent = new Map(unwrap(currencies).map((c) => [c.code, c.exponent]));
  const rows = unwrap(lines).map((l) => toUplRow(l, exponent.get(l.currency) ?? 2));
  const { header, body: cells } = projectUpl(rows, mapping);
  return {
    target: body.target,
    accounting_period_id: body.accounting_period_id,
    filename: `upl-${body.target}-${from_}-${to}.csv`,
    content_type: "text/csv" as const,
    header,
    row_count: rows.length,
    csv: toCsv(header, cells),
  };
}

// Handlers -----------------------------------------------------------------------------------------------

export const handlers = defineHandlers("Finance", {
  ...handlersFor("Finance", budgets),
  ...handlersFor("Finance", budgetLines),
  ...handlersFor("Finance", expenses),
  ...handlersFor("Finance", contingencyDraws),
  ...handlersFor("Finance", changeOrders),
  ...handlersFor("Finance", changeOrderLines),
  ...handlersFor("Finance", accountingPeriods),
  ...handlersFor("Finance", journalEntries),
  ...handlersFor("Finance", journalLines),
  ...handlersFor("Finance", postingLines),
  ...handlersFor("Finance", invoices),
  ...handlersFor("Finance", invoiceLines),
  ...handlersFor("Finance", paymentApplications),
  ...handlersFor("Finance", billingDraws),
  ...handlersFor("Finance", costCenters),
  ...handlersFor("Finance", taxJurisdictions),
  ...handlersFor("Finance", taxRates),
  ...handlersFor("Finance", fxRates),

  "budgets.summary": async ({ params }, context) =>
    ok((await budgetSummary(context, params.id)) as never),

  // Expenses: created Proposed (submitted); submit resubmits a Rejected one.
  "expenses.submit": async ({ params }, context) => {
    const current = await expenses.read(context, params.id, ["id", "expense_state"]);
    if (current["expense_state"] === "Proposed") {
      throw conflict("The expense is already submitted and waiting for approval.");
    }
    unwrap(
      await transitionExpense(context.db, {
        id: params.id,
        expected: current["expense_state"] as ExpenseState,
        next: "Proposed",
        reason: "Resubmitted.",
      }),
    );
    return ok(await reread(expenses, context, params.id));
  },

  "expenses.approve": async ({ params }, context) => {
    await expenses.read(context, params.id, ["id"]);
    unwrap(await approveExpense(context.db, params.id, ""));
    return ok(await reread(expenses, context, params.id));
  },

  // Change orders: Priced through the pricing RPC, Approved under spend authority, the rest by rule.
  "changeOrders.transition": async ({ params, body }, context) => {
    const current = await changeOrders.read(context, params.id, ["id", "change_order_state"]);
    expectState(current, "change_order_state", body.expected_state, "change order");
    const result =
      body.to_state === "Priced"
        ? await priceChangeOrder(context.db, params.id, reasonOf(body))
        : body.to_state === "Approved"
          ? await approveChangeOrder(context.db, params.id, reasonOf(body))
          : await transitionChangeOrder(context.db, {
              id: params.id,
              expected: body.expected_state as ChangeOrderState,
              next: body.to_state as ChangeOrderState,
              reason: reasonOf(body),
            });
    unwrap(result as Parameters<typeof unwrap>[0]);
    return ok(await reread(changeOrders, context, params.id));
  },

  "changeOrders.approve": async ({ params }, context) => {
    await changeOrders.read(context, params.id, ["id"]);
    unwrap(await approveChangeOrder(context.db, params.id, ""));
    return ok(await reread(changeOrders, context, params.id));
  },

  // Accounting periods: a closed period refuses postings; Audited only through Closed (invariant 13).
  "accountingPeriods.transition": async ({ params, body }, context) => {
    const current = await accountingPeriods.read(context, params.id, ["id", "period_state"]);
    expectState(current, "period_state", body.expected_state, "accounting period");
    unwrap(
      await transitionPeriod(context.db, {
        id: params.id,
        expected: body.expected_state as PeriodState,
        next: body.to_state as PeriodState,
        reason: reasonOf(body),
      }),
    );
    return ok(await reread(accountingPeriods, context, params.id));
  },

  // Journal entries: the preparer cannot post; a closed period refuses the posting.
  "journalEntries.post": async ({ params }, context) => {
    await journalEntries.read(context, params.id, ["id"]);
    unwrap(await postJournalEntry(context.db, params.id, ""));
    return ok(await reread(journalEntries, context, params.id));
  },

  "postingLines.export": async ({ body }, context) =>
    ok((await exportPostings(context, body)) as never),

  // Invoices: Issued through the issue RPC (receivables post then), Approved under spend authority.
  "invoices.transition": async ({ params, body }, context) => {
    const current = await invoices.read(context, params.id, ["id", "invoice_state"]);
    expectState(current, "invoice_state", body.expected_state, "invoice");
    const result =
      body.to_state === "Issued"
        ? await issueInvoice(context.db, params.id, reasonOf(body))
        : body.to_state === "Approved"
          ? await approveInvoice(context.db, params.id, reasonOf(body))
          : await transitionInvoice(context.db, {
              id: params.id,
              expected: body.expected_state as InvoiceState,
              next: body.to_state as InvoiceState,
              reason: reasonOf(body),
            });
    unwrap(result as Parameters<typeof unwrap>[0]);
    return ok(await reread(invoices, context, params.id));
  },

  "invoices.approve": async ({ params }, context) => {
    await invoices.read(context, params.id, ["id"]);
    unwrap(await approveInvoice(context.db, params.id, ""));
    return ok(await reread(invoices, context, params.id));
  },

  // A payment made on the org's rails, recorded against the invoice's payee (A38-007, 1123).
  "invoices.recordPayment": async ({ params, body }, context) => {
    await invoices.read(context, params.id, ["id"]);
    unwrap(
      await recordInvoicePayment(context.db, {
        invoiceId: params.id,
        paidOn: body.paid_on,
        amountMinor: body.amount_minor ?? null,
        reference: body.reference ?? null,
      }),
    );
    return ok(await reread(invoices, context, params.id));
  },
});
