import { describe, expect, it } from "vitest";
import { getBudgetLineTransactions, lineTransactionScope } from "../src/budget-transactions.ts";
import type { XosClient } from "../src/client.ts";

/** B13 (RRR-237, G-210): a line's sections reconcile with its figures, and an unreadable one is withheld, not partial. */

function fake(
  tables: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  filters: [string, unknown][] = [],
): XosClient {
  const chain = (rows: readonly Record<string, unknown>[]) => {
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      in: (column: string, values: unknown) => {
        filters.push([column, values]);
        return query;
      },
      order: () => query,
      then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
    };
    return query;
  };
  return {
    from: (table: string) => chain(tables[table] ?? []),
    rpc: async () => ({ data: [], error: null }),
  } as unknown as XosClient;
}

const ALL = { expenses: true, labor: true, purchaseOrders: true, invoices: true };

describe("lineTransactionScope", () => {
  const scoped = (held: readonly string[], rows: readonly Record<string, unknown>[]) => {
    const calls: Record<string, unknown>[] = [];
    const single = { data: rows[0] ?? null, error: null };
    const query = { select: () => query, eq: () => query, maybeSingle: async () => single };
    const db = {
      from: () => query,
      rpc: async (_: string, args: Record<string, unknown>) => {
        calls.push(args);
        return { data: held, error: null };
      },
    } as unknown as XosClient;
    return { db, calls };
  };

  it("asks about the line's own project, so a capability held elsewhere reads as withheld", async () => {
    const { db, calls } = scoped(
      ["finance.expense.read"],
      [{ project_id: "project-1", currency_code: "EUR" }],
    );
    const result = await lineTransactionScope(db, "line");
    expect(calls[0]?.["p_project_id"]).toBe("project-1");
    expect(result.ok && result.data).toEqual({
      access: { expenses: true, labor: false, purchaseOrders: false, invoices: false },
      currency: "EUR",
    });
  });

  it("is null for a line the viewer cannot read", async () => {
    const { db } = scoped([], []);
    const result = await lineTransactionScope(db, "line");
    expect(result.ok && result.data).toBeNull();
  });
});

describe("getBudgetLineTransactions", () => {
  it("subtotals each section and leaves other-currency order lines out of Committed", async () => {
    const result = await getBudgetLineTransactions(
      fake({
        budget_line_amounts: [
          { labor_actual_minor: 6000, labor_unpriced_minutes: 90, labor_other_currency_count: 2 },
        ],
        expenses: [
          {
            id: "e1",
            incurred_on: "2027-06-01",
            description: "Per diem",
            amount_minor: 700,
            currency_code: "USD",
          },
        ],
        labor_cost_posting_details: [
          {
            posting_id: "p1",
            team_kind: "Own Team",
            work_date: "2027-06-01",
            minutes: 120,
            segment: "Regular",
            is_masked: true,
            is_unpriced: false,
          },
        ],
        po_lines: [
          {
            id: "l1",
            purchase_order_id: "o1",
            description: "Deck",
            quantity: 2,
            unit_price_minor: 400,
            purchase_orders: {
              currency_code: "USD",
              po_number: 12,
              project: { project_key: "NWF" },
              vendor: { counterparty: { counterparty_name: "Bayside" } },
            },
          },
          {
            id: "l2",
            purchase_order_id: "o2",
            description: "Euro deck",
            quantity: 1,
            unit_price_minor: 999,
            purchase_orders: { currency_code: "EUR" },
          },
        ],
        invoice_lines: [
          {
            id: "i1",
            invoice_id: "v1",
            description: "Rental",
            quantity: 1,
            unit_price_minor: 500,
            invoices: { invoice_number: "INV-1" },
          },
        ],
      }),
      "line",
      ALL,
      "USD",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.expenseTotalMinor).toBe(700);
    expect(result.data.laborActualMinor).toBe(6000);
    expect(result.data.laborUnpricedMinutes).toBe(90);
    expect(result.data.laborOtherCurrencyCount).toBe(2);
    expect(result.data.committedMinor).toBe(800);
    expect(result.data.committed?.map((c) => c.poKey)).toEqual(["NWF-PO-12"]);
    expect(result.data.invoiceTotalMinor).toBe(500);
    expect(result.data.laborRows?.[0]).toMatchObject({ isMasked: true, amountMinor: null });
  });

  it("lists only vendor invoices that stand posted, as the section's sentence says", async () => {
    const filters: [string, unknown][] = [];
    await getBudgetLineTransactions(fake({ invoice_lines: [] }, filters), "line", ALL, "USD");
    expect(filters).toContainEqual(["invoices.invoice_state", ["Approved", "Disputed"]]);
  });

  it("withholds a section the viewer cannot read, rather than showing zero", async () => {
    const result = await getBudgetLineTransactions(
      fake({ budget_line_amounts: [] }),
      "line",
      { expenses: false, labor: false, purchaseOrders: false, invoices: false },
      "USD",
    );
    expect(result.ok && result.data.expenses).toBeNull();
    expect(result.ok && result.data.expenseTotalMinor).toBeNull();
    expect(result.ok && result.data.laborRows).toBeNull();
    expect(result.ok && result.data.committed).toBeNull();
    expect(result.ok && result.data.invoices).toBeNull();
  });

  it("blanks a subtotal holding an unpriced line, never reading it as zero", async () => {
    const result = await getBudgetLineTransactions(
      fake({
        po_lines: [
          {
            id: "l1",
            purchase_order_id: "o1",
            description: "Deck",
            quantity: 2,
            unit_price_minor: null,
            purchase_orders: { currency_code: "USD" },
          },
        ],
      }),
      "line",
      ALL,
      "USD",
    );
    expect(result.ok && result.data.committedMinor).toBeNull();
  });
});
