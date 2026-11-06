import type { XosClient } from "./client.ts";
import { fillPersonNames } from "./person-names.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/**
 * What stands behind a budget line's Actual and Committed (G-210, ADR 0152), read as the viewer so
 * each section obeys its capability: a section the viewer cannot read is withheld, never partial.
 * Actual = Expenses + Labor, Committed = the purchase order lines app.budget_line_commitments counts,
 * and vendor invoice lines are shown on their own because they post to the ledger, not to Actual.
 */

export interface LineExpense {
  readonly id: string;
  readonly incurredOn: string;
  readonly description: string;
  readonly submitter: string | null;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface LineLaborPerson {
  readonly postingId: string;
  readonly person: string | null;
  readonly teamKind: string;
  readonly teamName: string | null;
  readonly roleCode: string | null;
  readonly workDate: string;
  readonly minutes: number;
  readonly segment: string;
  /** Null when masked (no data.restricted.read.payroll) or unpriced; the flags say which. */
  readonly amountMinor: number | null;
  readonly isMasked: boolean;
  readonly isUnpriced: boolean;
}

export interface LinePoLine {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly poKey: string | null;
  readonly vendor: string | null;
  readonly description: string;
  readonly amountMinor: number | null;
}

export interface LineVendorInvoice {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly description: string | null;
  readonly amountMinor: number | null;
}

export interface LineTransactions {
  /** Null when the section is withheld from the viewer. */
  readonly expenses: readonly LineExpense[] | null;
  readonly expenseTotalMinor: number | null;
  /** Per-person rows, for readers who hold crew.timesheet.read; null otherwise. */
  readonly laborRows: readonly LineLaborPerson[] | null;
  readonly laborActualMinor: number;
  readonly laborUnpricedMinutes: number;
  readonly committed: readonly LinePoLine[] | null;
  readonly committedMinor: number | null;
  readonly invoices: readonly LineVendorInvoice[] | null;
  readonly invoiceTotalMinor: number | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);

/** Permission refusals read as a withheld section; anything else fails the read. */
async function section<T>(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
  map: (row: Raw) => T,
): Promise<Result<T[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(((data as Raw[] | null) ?? []).map(map));
}

export interface LineTransactionAccess {
  readonly expenses: boolean;
  readonly labor: boolean;
  readonly purchaseOrders: boolean;
  readonly invoices: boolean;
}

/** Sums priced amounts, or null by the silence rule when any amount is unknown. */
function subtotal(amounts: readonly (number | null)[]): number | null {
  let total = 0;
  for (const a of amounts) {
    if (a === null) return null;
    total += a;
  }
  return total;
}

/**
 * A line's transactions. `access` says which sections the viewer's capabilities open: row level
 * security would answer an unreadable section with no rows, which would read as zero.
 */
export async function getBudgetLineTransactions(
  db: XosClient,
  lineId: string,
  access: LineTransactionAccess,
): Promise<Result<LineTransactions>> {
  const [amounts, expenses, labor, po, invoices] = await Promise.all([
    section(
      db
        .from("budget_line_amounts")
        .select("labor_actual_minor, labor_unpriced_minutes")
        .eq("budget_line_id", lineId),
      (r) => r,
    ),
    access.expenses
      ? section(
          db
            .from("expenses")
            .select(
              "id, incurred_on, description, submitter_person_id, amount_minor, currency_code",
            )
            .eq("budget_line_id", lineId)
            .is("deleted_at", null)
            .in("expense_state", ["Approved", "Paid"])
            .order("incurred_on", { ascending: false }),
          (r) => ({
            row: {
              id: str(r["id"]),
              incurredOn: str(r["incurred_on"]),
              description: str(r["description"]),
              submitter: null as string | null,
              amountMinor: num(r["amount_minor"]),
              currency: str(r["currency_code"]),
            },
            person: strOrNull(r["submitter_person_id"]),
          }),
        )
      : null,
    access.labor
      ? section(
          db
            .from("labor_cost_posting_details")
            .select(
              "posting_id, person_name, team_kind, team_name, role_code, work_date, minutes, segment, amount_minor, is_masked, is_unpriced",
            )
            .eq("budget_line_id", lineId)
            .order("work_date", { ascending: false }),
          (r): LineLaborPerson => ({
            postingId: str(r["posting_id"]),
            person: strOrNull(r["person_name"]),
            teamKind: str(r["team_kind"]),
            teamName: strOrNull(r["team_name"]),
            roleCode: strOrNull(r["role_code"]),
            workDate: str(r["work_date"]),
            minutes: num(r["minutes"]),
            segment: str(r["segment"]),
            amountMinor: numOrNull(r["amount_minor"]),
            isMasked: r["is_masked"] === true,
            isUnpriced: r["is_unpriced"] === true,
          }),
        )
      : null,
    access.purchaseOrders
      ? section(
          db
            .from("po_lines")
            .select(
              "id, purchase_order_id, description, quantity, unit_price_minor, purchase_orders!inner(po_number, po_state, deleted_at, currency_code, project:projects(project_key), vendor:vendors(counterparty:counterparties(counterparty_name)))",
            )
            .eq("budget_line_id", lineId)
            .is("deleted_at", null)
            .is("purchase_orders.deleted_at", null)
            .in("purchase_orders.po_state", ["Approved", "Sent", "Closed"]),
          (r) => r,
        )
      : null,
    access.invoices
      ? section(
          db
            .from("invoice_lines")
            .select(
              "id, invoice_id, description, quantity, unit_price_minor, invoices!inner(invoice_number, direction, deleted_at)",
            )
            .eq("budget_line_id", lineId)
            .is("deleted_at", null)
            .is("invoices.deleted_at", null)
            .eq("invoices.direction", "Payable"),
          (r) => r,
        )
      : null,
  ]);
  if (!amounts.ok) return amounts;
  if (expenses && !expenses.ok) return expenses;
  if (labor && !labor.ok) return labor;
  if (po && !po.ok) return po;
  if (invoices && !invoices.ok) return invoices;
  const head = amounts.data[0] ?? {};

  let expenseRows: LineExpense[] | null = null;
  if (expenses) {
    const named = await fillPersonNames(
      db,
      expenses.data,
      (e) => e.person,
      (e) => e.row.submitter,
      (e, name) => ({ ...e, row: { ...e.row, submitter: name } }),
    );
    expenseRows = named.map((e) => e.row);
  }
  const committed = po
    ? po.data.map((r): LinePoLine => {
        const price = numOrNull(r["unit_price_minor"]);
        const order = r["purchase_orders"] as {
          po_number?: number | null;
          project?: { project_key?: string | null } | null;
          vendor?: { counterparty?: { counterparty_name?: string | null } | null } | null;
        } | null;
        return {
          id: str(r["id"]),
          purchaseOrderId: str(r["purchase_order_id"]),
          poKey:
            order?.project?.project_key && order.po_number !== null && order.po_number !== undefined
              ? `${order.project.project_key}-PO-${order.po_number}`
              : null,
          vendor: order?.vendor?.counterparty?.counterparty_name ?? null,
          description: str(r["description"]),
          amountMinor: price === null ? null : Math.round(num(r["quantity"]) * price),
        };
      })
    : null;
  const vendorInvoices = invoices
    ? invoices.data.map((r): LineVendorInvoice => {
        const price = numOrNull(r["unit_price_minor"]);
        const invoice = r["invoices"] as Raw | null;
        return {
          id: str(r["id"]),
          invoiceId: str(r["invoice_id"]),
          invoiceNumber: strOrNull(invoice?.["invoice_number"]),
          description: strOrNull(r["description"]),
          amountMinor: price === null ? null : Math.round(num(r["quantity"]) * price),
        };
      })
    : null;
  return ok({
    expenses: expenseRows,
    expenseTotalMinor: expenseRows ? subtotal(expenseRows.map((e) => e.amountMinor)) : null,
    laborRows: labor ? labor.data : null,
    laborActualMinor: num(head["labor_actual_minor"]),
    laborUnpricedMinutes: num(head["labor_unpriced_minutes"]),
    committed,
    committedMinor: committed ? subtotal(committed.map((c) => c.amountMinor)) : null,
    invoices: vendorInvoices,
    invoiceTotalMinor: vendorInvoices ? subtotal(vendorInvoices.map((i) => i.amountMinor)) : null,
  });
}
