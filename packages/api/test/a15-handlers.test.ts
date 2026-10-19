/**
 * Contract tests for A15's Finance and Reports handlers (Section 18, gate 5). Requests run through
 * `contractApp` against the in-memory client and every response is checked against openapi/v1.json
 * with `expectContract`. The lifecycle and approval RPCs are stand-ins that refuse the way the
 * database does (XR001 with the rule), so refusals (422), compare-and-set conflicts (409), hidden
 * rows (404) and stale If-Match (412) are covered too. The built-in report queries and the posting
 * line read are A15's repository functions, tested in packages/data; here they are stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { handlers as finance } from "../src/handlers/finance.ts";
import { handlers as reports } from "../src/handlers/reports.ts";
import { moneyTotal } from "../src/handlers/finance.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";
import type * as FinanceData from "@xos/data/finance";
import type * as ReportsData from "@xos/data/reports";

type FinanceModule = typeof FinanceData;
type ReportsModule = typeof ReportsData;

const stubs = vi.hoisted(() => ({
  postings: [] as unknown[],
  bva: { rows: [] as unknown[], totals: [] as unknown[] },
  finalCost: { hasBaseline: true, rows: [] as unknown[] },
  exposure: [] as unknown[],
}));

vi.mock("@xos/data/finance", async (original) => ({
  ...(await original<FinanceModule>()),
  listPostingLines: vi.fn(async () => ({ ok: true, data: stubs.postings })),
}));

vi.mock("@xos/data/reports", async (original) => ({
  ...(await original<ReportsModule>()),
  budgetVersusActual: vi.fn(async () => ({ ok: true, data: stubs.bva })),
  finalCostReport: vi.fn(async () => ({ ok: true, data: stubs.finalCost })),
  purchaseOrderExposure: vi.fn(async () => ({ ok: true, data: stubs.exposure })),
}));

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;

const PROJECT = id(1001);
const BUDGET = id(1101);
const LINE = id(1201);
const CONTINGENCY = id(1202);
const CENTER = id(1301);
const EXPENSE = id(1401);
const DRAW = id(1501);
const CO = id(1601);
const CO_LINE = id(1701);
const PERIOD = id(1801);
const ENTRY = id(1901);
const JLINE = id(2001);
const POSTING = id(2101);
const INVOICE = id(2201);
const ILINE = id(2301);
const PAYMENT = id(2401);
const APPLICATION = id(2501);
const BILLING = id(2601);
const JURISDICTION = id(2701);
const RATE = id(2801);
const FX = id(2901);
const PARTY = id(3001);
const PO = id(3101);
const MEMBERSHIP = id(3201);
const REPORT = id(3301);
const RUN = id(3401);
const SCHEDULE = id(3501);
const RECIPIENT = id(3502);
const DELIVERY = id(3503);
const DASHBOARD = id(3601);
const TILE = id(3602);
const MISSING = id(9999);

function setState(db: MemoryDb, table: string, key: string, column: string, value: string) {
  const row = db.tables[table]?.find((r) => r["id"] === key) as Row;
  row[column] = value;
}

function stateOf(db: MemoryDb, table: string, key: string, column: string): unknown {
  return db.tables[table]?.find((r) => r["id"] === key)?.[column];
}

/** A lifecycle RPC stand-in: compare-and-set on the expected state, then the rule's own checks. */
function transitionRpc(table: string, column: string, keyArg: string, lifecycle: string) {
  return (args: Row, db: MemoryDb) => {
    const key = String(args[keyArg]);
    if (stateOf(db, table, key, column) !== args["p_expected"])
      throw refusal(`${lifecycle}_state_conflict`);
    if (args["p_next"] === "Audited") throw refusal(`${lifecycle}_transition_not_allowed`);
    setState(db, table, key, column, String(args["p_next"]));
    return id(7000);
  };
}

function world() {
  const db = memoryDb(
    {
      budgets: [
        tenantRow(BUDGET, ORG, {
          project_id: PROJECT,
          name: "Working Budget",
          currency_code: "USD",
          is_baseline: false,
        }),
      ],
      budget_lines: [
        tenantRow(LINE, ORG, {
          budget_id: BUDGET,
          line_number: 1,
          description: "Stage deck rental",
          line_type: "Cost",
          urid: "4000.01.01",
          cost_center_id: CENTER,
          grade_code: "base",
          element_id: "4000.01.01-XPMS-001",
          quantity: 24,
          unit_basis: "each",
          unit_price_minor: 4500,
          xyz: "X",
          xyz_basis: "Category",
        }),
        tenantRow(CONTINGENCY, ORG, {
          budget_id: BUDGET,
          line_number: 2,
          description: "Contingency",
          line_type: "Contingency",
          urid: "0000.01",
          cost_center_id: null,
          grade_code: null,
          element_id: null,
          quantity: 1,
          unit_basis: null,
          unit_price_minor: null,
          xyz: "Z",
          xyz_basis: "Declared",
        }),
      ],
      budget_line_facts: [
        { budget_line_id: LINE, budget_id: BUDGET, extended_minor: 108000, actual_minor: 14388 },
        { budget_line_id: CONTINGENCY, budget_id: BUDGET, extended_minor: null, actual_minor: 0 },
      ],
      po_lines: [
        tenantRow(id(3111), ORG, {
          purchase_order_id: PO,
          budget_line_id: LINE,
          quantity: 10,
          unit_price_minor: 4500,
        }),
        tenantRow(id(3112), ORG, {
          purchase_order_id: PO,
          budget_line_id: LINE,
          quantity: 2,
          unit_price_minor: null,
        }),
      ],
      purchase_orders: [tenantRow(PO, ORG, { po_state: "Approved", currency_code: "USD" })],
      cost_centers: [
        tenantRow(CENTER, ORG, {
          code: "CC-VENUE",
          name: "Venue",
          kind: "Standing",
          scope_node_id: null,
          template_id: "CC-VENUE",
        }),
      ],
      expenses: [
        tenantRow(EXPENSE, ORG, {
          budget_line_id: LINE,
          counterparty_id: null,
          submitter_person_id: ME,
          description: "Gaffer tape, 12 rolls",
          incurred_on: "2026-09-14",
          amount_minor: 14388,
          currency_code: "USD",
          expense_state: "Rejected",
        }),
      ],
      contingency_draws: [
        tenantRow(DRAW, ORG, {
          from_budget_line_id: CONTINGENCY,
          to_budget_line_id: LINE,
          amount_minor: 250000,
          reason: "Added wind bracing after the engineering review.",
        }),
      ],
      change_orders: [
        tenantRow(CO, ORG, {
          project_id: PROJECT,
          budget_id: BUDGET,
          change_order_number: 1,
          title: "Add Second Bar",
          order_type_enum_id: null,
          reason: "Client added a second bar at the north lawn.",
          requested_by: ME,
          priced_by: null,
          change_order_state: "Proposed",
        }),
      ],
      change_order_lines: [
        tenantRow(CO_LINE, ORG, {
          change_order_id: CO,
          budget_line_id: LINE,
          description: "Bar build",
          urid: "4000.01.01",
          quantity: 1,
          unit_price_minor: null,
          is_no_cost: false,
        }),
      ],
      accounting_periods: [
        tenantRow(PERIOD, ORG, {
          starts_on: "2026-09-01",
          ends_on: "2026-09-30",
          period_state: "Open",
        }),
      ],
      journal_entries: [
        tenantRow(ENTRY, ORG, {
          accounting_period_id: PERIOD,
          project_id: PROJECT,
          entry_date: "2026-09-15",
          memo: "Reclass staging rental",
          journal_state: "Proposed",
          prepared_by: ME,
          posted_by: null,
          posted_at: null,
          source_table: null,
          source_id: null,
        }),
      ],
      journal_lines: [
        tenantRow(JLINE, ORG, {
          journal_entry_id: ENTRY,
          line_number: 1,
          account_code: "5400",
          cost_center_id: CENTER,
          urid: "4000.01.01",
          counterparty_id: null,
          element_id: null,
          description: "Staging rental",
          quantity: null,
          unit_basis: null,
          debit_minor: 45000,
          credit_minor: 0,
          currency_code: "USD",
        }),
      ],
      posting_lines: [
        {
          posting_line_id: POSTING,
          org_id: ORG,
          project_id: PROJECT,
          date: "2026-09-15",
          account_code: "5400",
          cost_center_id: "CC-VENUE",
          urid: "4000.01.01",
          vendor_id: null,
          item_id: null,
          description: "Stage deck rental for opening weekend.",
          quantity: null,
          unit_basis: null,
          amount_minor: 45000,
          tax_type: "None",
          currency: "USD",
          external_ref: null,
          line_state: "Complete",
        },
      ],
      invoices: [
        tenantRow(INVOICE, ORG, {
          project_id: PROJECT,
          direction: "Payable",
          counterparty_id: PARTY,
          invoice_number: "INV-2026-0042",
          issued_on: "2026-09-10",
          due_on: "2026-10-10",
          currency_code: "USD",
          invoice_state: "Proposed",
        }),
      ],
      invoice_lines: [
        tenantRow(ILINE, ORG, {
          invoice_id: INVOICE,
          line_number: 1,
          description: "Stage deck rental",
          quantity: 24,
          unit_price_minor: 4500,
          budget_line_id: LINE,
          tax_rate_id: null,
          urid: "4000.01.01",
        }),
      ],
      payments: [
        tenantRow(PAYMENT, ORG, {
          paid_on: "2026-09-20",
          currency_code: "USD",
          reference_identifier: "ACH-77812",
        }),
      ],
      payment_applications: [
        tenantRow(APPLICATION, ORG, {
          payment_id: PAYMENT,
          invoice_id: INVOICE,
          amount_minor: 108000,
        }),
      ],
      billing_draws: [
        tenantRow(BILLING, ORG, {
          project_id: PROJECT,
          draw_number: 1,
          period_end: "2026-09-30",
          amount_requested_minor: 5000000,
          currency_code: "USD",
          invoice_id: null,
        }),
      ],
      tax_jurisdictions: [
        tenantRow(JURISDICTION, ORG, { jurisdiction_id: "US-FL", name: "Florida Sales Tax" }),
      ],
      tax_rates: [
        tenantRow(RATE, ORG, {
          tax_jurisdiction_id: JURISDICTION,
          tax_type: "Tax on Purchases",
          rate_percent: 7,
          effective_from: "2026-01-01",
          effective_to: null,
        }),
      ],
      fx_rates: [
        tenantRow(FX, ORG, {
          base_currency: "USD",
          quote_currency: "EUR",
          rate: 0.9213,
          effective_on: "2026-09-30",
          source: "ECB",
        }),
      ],
      currencies: [{ currency_code: "USD", minor_unit_exponent: 2 }],
      "xpms.dim_upl_field": [
        { field: "date", rule: "Date the cost is recognized.", ordinal: 1 },
        { field: "xero", rule: "date → Date; amount → Amount", ordinal: 15 },
      ],
      report_definitions: [
        tenantRow(REPORT, ORG, {
          membership_id: MEMBERSHIP,
          name: "Labor by Department",
          source_code: "crew",
          custom_object_type_id: null,
          chart: "Bar",
          group_by_field: "dept_code",
          shared: true,
        }),
      ],
      report_runs: [
        tenantRow(RUN, ORG, {
          report_definition_id: REPORT,
          run_for_membership_id: MEMBERSHIP,
          export_format: "CSV",
          run_status: "Succeeded",
          started_at: "2026-10-01T12:00:00.000Z",
          finished_at: "2026-10-01T12:00:05.000Z",
          row_count: 12,
          unpriced_count: 0,
          last_error: null,
        }),
      ],
      memberships: [
        tenantRow(MEMBERSHIP, ORG, { person_id: ME, valid_from: "2026-01-01T00:00:00.000Z" }),
      ],
      report_schedules: [
        tenantRow(SCHEDULE, ORG, {
          report_definition_id: REPORT,
          cadence: "Weekly",
          local_hour: 8,
          weekday: 1,
          month_day: null,
          time_zone: "America/New_York",
          export_format: "PDF",
          next_run_at: "2026-10-19T12:00:00.000Z",
          paused_at: null,
        }),
      ],
      report_schedule_recipients: [
        tenantRow(RECIPIENT, ORG, { report_schedule_id: SCHEDULE, membership_id: MEMBERSHIP }),
      ],
      report_deliveries: [
        tenantRow(DELIVERY, ORG, {
          report_schedule_id: SCHEDULE,
          membership_id: MEMBERSHIP,
          report_run_id: RUN,
          scheduled_for: "2026-10-12T12:00:00.000Z",
          delivery_status: "Sent",
          sent_at: "2026-10-12T12:01:00.000Z",
          last_error: null,
        }),
      ],
      dashboards: [
        tenantRow(DASHBOARD, ORG, { name: "Show Week", membership_id: MEMBERSHIP, team_id: null }),
      ],
      dashboard_tiles: [
        tenantRow(TILE, ORG, {
          dashboard_id: DASHBOARD,
          report_definition_id: REPORT,
          grid_column: 1,
          grid_row: 1,
          column_span: 6,
          row_span: 1,
        }),
      ],
    },
    {
      approve_expense: (args, self) => {
        setState(self, "expenses", String(args["p_expense_id"]), "expense_state", "Approved");
        return true;
      },
      transition_expense: transitionRpc("expenses", "expense_state", "p_expense_id", "expense"),
      price_change_order: (args, self) => {
        const key = String(args["p_change_order_id"]);
        const unpriced = self.tables["change_order_lines"]?.some(
          (l) => l["change_order_id"] === key && l["unit_price_minor"] === null,
        );
        if (unpriced) throw refusal("change_order_unpriced");
        setState(self, "change_orders", key, "change_order_state", "Priced");
        return null;
      },
      approve_change_order: (args, self) => {
        const key = String(args["p_change_order_id"]);
        if (stateOf(self, "change_orders", key, "change_order_state") !== "Priced")
          throw refusal("change_order_transition_not_allowed");
        setState(self, "change_orders", key, "change_order_state", "Approved");
        return true;
      },
      transition_change_order: transitionRpc(
        "change_orders",
        "change_order_state",
        "p_change_order_id",
        "change_order",
      ),
      transition_accounting_period: transitionRpc(
        "accounting_periods",
        "period_state",
        "p_accounting_period_id",
        "accounting_period",
      ),
      post_journal_entry: (args, self) => {
        const key = String(args["p_journal_entry_id"]);
        setState(self, "journal_entries", key, "journal_state", "Posted");
        const entry = self.tables["journal_entries"]?.find((r) => r["id"] === key) as Row;
        entry["posted_at"] = "2026-10-02T09:00:00.000Z";
        entry["posted_by"] = id(4001);
        return null;
      },
      issue_invoice: (args, self) => {
        setState(self, "invoices", String(args["p_invoice_id"]), "invoice_state", "Issued");
        return null;
      },
      approve_invoice: (args, self) => {
        setState(self, "invoices", String(args["p_invoice_id"]), "invoice_state", "Approved");
        return true;
      },
      transition_invoice: transitionRpc("invoices", "invoice_state", "p_invoice_id", "invoice"),
      form_1099_nec_rows: () => [
        {
          payee_person_id: id(4101),
          payee_organization_id: null,
          payee_name: "Ivy Marchetti",
          tax_form_id: id(4102),
          w9_on_file: true,
          tin_type: 2,
          tin_last4: "6789",
          tin: null,
          street_address: "1 Pier Way",
          locality: "Miami",
          region_code: "FL",
          postal_code: "33101",
          address_complete: true,
          amount_minor: 75000,
          payment_count: 2,
        },
      ],
      record_invoice_payment: (args, self) => {
        if (stateOf(self, "invoices", String(args["p_invoice_id"]), "invoice_state") !== "Approved")
          throw refusal("invoice_payment_state");
        return id(2402);
      },
      run_report: (args, self) => {
        const run = tenantRow(id(3402), ORG, {
          report_definition_id: args["p_report_definition_id"],
          run_for_membership_id: MEMBERSHIP,
          export_format: args["p_format"],
          run_status: "Queued",
          started_at: null,
          finished_at: null,
          row_count: null,
          unpriced_count: null,
          last_error: null,
        });
        self.tables["report_runs"]?.push(run);
        return run["id"];
      },
    },
    {
      budgets: { is_baseline: false },
      budget_lines: { line_type: "Cost", quantity: 1 },
      expenses: { expense_state: "Proposed", submitter_person_id: ME },
      change_orders: {
        change_order_state: "Proposed",
        change_order_number: 2,
        requested_by: ME,
        priced_by: null,
      },
      change_order_lines: { quantity: 1, is_no_cost: false },
      accounting_periods: { period_state: "Open" },
      journal_entries: { journal_state: "Proposed", prepared_by: ME },
      journal_lines: { debit_minor: 0, credit_minor: 0 },
      invoices: { invoice_state: "Proposed" },
      invoice_lines: { quantity: 1 },
    },
  );
  const app = contractApp({ handlers: [finance, reports], db });
  return { db, http: requests(app) };
}

type Http = ReturnType<typeof world>["http"];

interface Crud {
  readonly path: string;
  readonly op: string;
  readonly key: string;
  readonly create?: Row;
  readonly update?: Row;
  readonly remove?: boolean;
}

/**
 * Lists, reads, creates, edits (with a stale If-Match) and deletes one resource, returning each
 * success for the caller to check against its operation.
 */
async function crud(http: Http, c: Crud) {
  const out: Record<"list" | "get" | "create" | "update" | "remove", Response | undefined> = {
    list: await success(http.get(c.path)),
    get: await success(http.get(`${c.path}/${c.key}`)),
    create: undefined,
    update: undefined,
    remove: undefined,
  };
  expect((await http.get(`${c.path}/${MISSING}`)).status).toBe(404);
  if (c.create !== undefined) {
    out.create = await http.post(c.path, c.create);
    expect(out.create.status).toBe(201);
  }
  if (c.update !== undefined) {
    out.update = await success(http.patch(`${c.path}/${c.key}`, c.update));
    const stale = await http.patch(`${c.path}/${c.key}`, c.update, 'W/"MjAyMC0wMS0wMQ"');
    expect(stale.status).toBe(412);
  }
  if (c.remove === true) {
    out.remove = await success(http.delete(`${c.path}/${c.key}`));
    expect((await http.get(`${c.path}/${c.key}`)).status).toBe(404);
  }
  return out as Record<"list" | "get", Response> & typeof out;
}

/** The response of a step that ran. */
const step = (r: Response | undefined): Response => {
  if (r === undefined) throw new Error("step did not run");
  return r;
};

describe("MoneyTotal", () => {
  it("sums the priced inputs, counts the unpriced ones and never coerces them to zero", () => {
    expect(moneyTotal([100, null, 50], "USD ")).toEqual({
      total_minor: 150,
      currency: "USD",
      unpriced_count: 1,
    });
    expect(moneyTotal([null, null], "USD")).toEqual({
      total_minor: null,
      currency: "USD",
      unpriced_count: 2,
    });
    expect(moneyTotal([], "EUR")).toEqual({ total_minor: 0, currency: "EUR", unpriced_count: 0 });
  });
});

describe("budgets and budget lines", () => {
  it("serves budgets with their NULL-aware summary", async () => {
    const { http } = world();
    const budgetsR = await crud(http, {
      path: "/budgets",
      op: "budgets",
      key: BUDGET,
      create: { project_id: PROJECT, name: "Gate 3 Budget", currency_code: "USD" },
      update: { name: "Working Budget Rev B" },
    });
    await expectContract(budgetsR.list, "budgets.list");
    await expectContract(budgetsR.get, "budgets.get");
    await expectContract(step(budgetsR.create), "budgets.create");
    await expectContract(step(budgetsR.update), "budgets.update");
    const summary = (await expectContract(
      await success(http.get(`/budgets/${BUDGET}/summary`)),
      "budgets.summary",
    )) as Record<string, { total_minor: number | null; unpriced_count: number }>;
    expect(summary["estimate"]).toMatchObject({ total_minor: 108000, unpriced_count: 1 });
    expect(summary["committed"]).toMatchObject({ total_minor: 45000, unpriced_count: 1 });
    expect(summary["actual"]).toMatchObject({ total_minor: 14388 });
    expect(summary["variance"]).toMatchObject({ total_minor: 93612, unpriced_count: 1 });
    await expectContract(await success(http.delete(`/budgets/${BUDGET}`)), "budgets.delete");
    expect((await http.get(`/budgets/${BUDGET}/summary`)).status).toBe(404);
  });

  it("serves budget lines with the derived line total, blank for an unpriced line", async () => {
    const { http } = world();
    const line = (await expectContract(
      await success(http.get(`/budget-lines/${LINE}`)),
      "budgetLines.get",
    )) as Row;
    expect(line["line_total_minor"]).toBe(108000);
    const blank = (await expectContract(
      await success(http.get(`/budget-lines/${CONTINGENCY}`)),
      "budgetLines.get",
    )) as Row;
    expect(blank["line_total_minor"]).toBeNull();
    const budgetLinesR = await crud(http, {
      path: "/budget-lines",
      op: "budgetLines",
      key: LINE,
      create: {
        budget_id: BUDGET,
        line_number: 3,
        description: "Front of house console",
        urid: "4000.01.01",
        xyz: "X",
        xyz_basis: "Category",
      },
      update: { unit_price_minor: 5000 },
      remove: true,
    });
    await expectContract(budgetLinesR.list, "budgetLines.list");
    await expectContract(budgetLinesR.get, "budgetLines.get");
    await expectContract(step(budgetLinesR.create), "budgetLines.create");
    await expectContract(step(budgetLinesR.update), "budgetLines.update");
    await expectContract(step(budgetLinesR.remove), "budgetLines.delete");
  });

  it("serves contingency draws and cost centers", async () => {
    const { http } = world();
    const contingencyDrawsR = await crud(http, {
      path: "/contingency-draws",
      op: "contingencyDraws",
      key: DRAW,
      create: {
        from_budget_line_id: CONTINGENCY,
        to_budget_line_id: LINE,
        amount_minor: 1000,
        reason: "Rain cover for the console.",
      },
    });
    await expectContract(contingencyDrawsR.list, "contingencyDraws.list");
    await expectContract(contingencyDrawsR.get, "contingencyDraws.get");
    await expectContract(step(contingencyDrawsR.create), "contingencyDraws.create");
    const costCentersR = await crud(http, {
      path: "/cost-centers",
      op: "costCenters",
      key: CENTER,
      create: { code: "CC-NWS-S01", name: "Show 1", kind: "Event" },
      update: { name: "Venue Operations" },
      remove: true,
    });
    await expectContract(costCentersR.list, "costCenters.list");
    await expectContract(costCentersR.get, "costCenters.get");
    await expectContract(step(costCentersR.create), "costCenters.create");
    await expectContract(step(costCentersR.update), "costCenters.update");
    await expectContract(step(costCentersR.remove), "costCenters.delete");
  });
});

describe("expenses", () => {
  it("serves expenses, resubmits a rejected one and approves it", async () => {
    const { db, http } = world();
    const expensesR = await crud(http, {
      path: "/expenses",
      op: "expenses",
      key: EXPENSE,
      create: {
        budget_line_id: LINE,
        description: "Cable ties",
        amount_minor: 2400,
        currency_code: "USD",
        incurred_on: "2026-09-16",
      },
      update: { description: "Gaffer tape, 14 rolls" },
    });
    await expectContract(expensesR.list, "expenses.list");
    await expectContract(expensesR.get, "expenses.get");
    await expectContract(step(expensesR.create), "expenses.create");
    await expectContract(step(expensesR.update), "expenses.update");
    const submitted = (await expectContract(
      await success(http.post(`/expenses/${EXPENSE}/submit`)),
      "expenses.submit",
    )) as Row;
    expect(submitted["expense_state"]).toBe("Proposed");
    expect((await http.post(`/expenses/${EXPENSE}/submit`)).status).toBe(409);
    const approved = (await expectContract(
      await success(http.post(`/expenses/${EXPENSE}/approve`)),
      "expenses.approve",
    )) as Row;
    expect(approved["expense_state"]).toBe("Approved");
    db.fail("rpc:approve_expense", refusal("sod_approval_requester"));
    const refused = await http.post(`/expenses/${EXPENSE}/approve`);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Row)["rule"]).toBe("sod_approval_requester");
    expect((await http.post(`/expenses/${MISSING}/approve`)).status).toBe(404);
  });
});

describe("change orders", () => {
  it("serves change orders with an unpriced total and their lines", async () => {
    const { http } = world();
    const read = (await expectContract(
      await success(http.get(`/change-orders/${CO}`)),
      "changeOrders.get",
    )) as Row;
    expect(read["total"]).toEqual({ total_minor: null, currency: "USD", unpriced_count: 1 });
    const changeOrdersR = await crud(http, {
      path: "/change-orders",
      op: "changeOrders",
      key: CO,
      create: { project_id: PROJECT, budget_id: BUDGET, title: "Extend Load-Out" },
      update: { title: "Add Second Bar And Shade" },
    });
    await expectContract(changeOrdersR.list, "changeOrders.list");
    await expectContract(changeOrdersR.get, "changeOrders.get");
    await expectContract(step(changeOrdersR.create), "changeOrders.create");
    await expectContract(step(changeOrdersR.update), "changeOrders.update");
    const changeOrderLinesR = await crud(http, {
      path: "/change-order-lines",
      op: "changeOrderLines",
      key: CO_LINE,
      create: { change_order_id: CO, urid: "4000.01.01", description: "Shade sails" },
      update: { unit_price_minor: 1200000 },
      remove: true,
    });
    await expectContract(changeOrderLinesR.list, "changeOrderLines.list");
    await expectContract(changeOrderLinesR.get, "changeOrderLines.get");
    await expectContract(step(changeOrderLinesR.create), "changeOrderLines.create");
    await expectContract(step(changeOrderLinesR.update), "changeOrderLines.update");
    await expectContract(step(changeOrderLinesR.remove), "changeOrderLines.delete");
  });

  it("refuses to price an unpriced change order, then prices and approves it", async () => {
    const { db, http } = world();
    const unpriced = await http.post(`/change-orders/${CO}/transitions`, {
      expected_state: "Proposed",
      to_state: "Priced",
    });
    expect(unpriced.status).toBe(422);
    expect(((await unpriced.json()) as Row)["rule"]).toBe("change_order_unpriced");
    const line = db.tables["change_order_lines"]?.[0] as Row;
    line["unit_price_minor"] = 1200000;
    const sent1 = await success(
      http.post(`/change-orders/${CO}/transitions`, {
        expected_state: "Proposed",
        to_state: "Priced",
      }),
    );
    const priced = (await expectContract(sent1, "changeOrders.transition")) as Row;
    expect(priced["change_order_state"]).toBe("Priced");
    expect(priced["total"]).toEqual({ total_minor: 1200000, currency: "USD", unpriced_count: 0 });
    const stale = await http.post(`/change-orders/${CO}/transitions`, {
      expected_state: "Proposed",
      to_state: "Canceled",
    });
    expect(stale.status).toBe(409);
    const approved = (await expectContract(
      await success(http.post(`/change-orders/${CO}/approve`)),
      "changeOrders.approve",
    )) as Row;
    expect(approved["change_order_state"]).toBe("Approved");
  });

  it("routes approval and other transitions to their RPCs", async () => {
    const { db, http } = world();
    setState(db, "change_orders", CO, "change_order_state", "Priced");
    const sent2 = await success(
      http.post(`/change-orders/${CO}/transitions`, {
        expected_state: "Priced",
        to_state: "Approved",
      }),
    );
    await expectContract(sent2, "changeOrders.transition");
    setState(db, "change_orders", CO, "change_order_state", "Proposed");
    const sent3 = await success(
      http.post(`/change-orders/${CO}/transitions`, {
        expected_state: "Proposed",
        to_state: "Canceled",
        reason: "Client withdrew the request.",
      }),
    );
    const canceled = (await expectContract(sent3, "changeOrders.transition")) as Row;
    expect(canceled["change_order_state"]).toBe("Canceled");
    expect(db.calls.map((c) => c.name)).toEqual([
      "approve_change_order",
      "transition_change_order",
    ]);
  });
});

describe("accounting periods, journal entries and posting lines", () => {
  it("serves periods and refuses Audited straight from Open", async () => {
    const { http } = world();
    const accountingPeriodsR = await crud(http, {
      path: "/accounting-periods",
      op: "accountingPeriods",
      key: PERIOD,
      create: { starts_on: "2026-10-01", ends_on: "2026-10-31" },
    });
    await expectContract(accountingPeriodsR.list, "accountingPeriods.list");
    await expectContract(accountingPeriodsR.get, "accountingPeriods.get");
    await expectContract(step(accountingPeriodsR.create), "accountingPeriods.create");
    const sent4 = await success(
      http.post(`/accounting-periods/${PERIOD}/transitions`, {
        expected_state: "Open",
        to_state: "Closing",
      }),
    );
    const closing = (await expectContract(sent4, "accountingPeriods.transition")) as Row;
    expect(closing["period_state"]).toBe("Closing");
    const skipped = await http.post(`/accounting-periods/${PERIOD}/transitions`, {
      expected_state: "Closing",
      to_state: "Audited",
    });
    expect(skipped.status).toBe(422);
    expect(((await skipped.json()) as Row)["rule"]).toBe(
      "accounting_period_transition_not_allowed",
    );
    const stale = await http.post(`/accounting-periods/${PERIOD}/transitions`, {
      expected_state: "Open",
      to_state: "Closing",
    });
    expect(stale.status).toBe(409);
  });

  it("serves journal entries and lines and posts an entry", async () => {
    const { db, http } = world();
    const journalEntriesR = await crud(http, {
      path: "/journal-entries",
      op: "journalEntries",
      key: ENTRY,
      create: { accounting_period_id: PERIOD, entry_date: "2026-09-20", memo: "Accrue power" },
      update: { memo: "Reclass staging rental to rigging" },
    });
    await expectContract(journalEntriesR.list, "journalEntries.list");
    await expectContract(journalEntriesR.get, "journalEntries.get");
    await expectContract(step(journalEntriesR.create), "journalEntries.create");
    await expectContract(step(journalEntriesR.update), "journalEntries.update");
    const journalLinesR = await crud(http, {
      path: "/journal-lines",
      op: "journalLines",
      key: JLINE,
      create: {
        journal_entry_id: ENTRY,
        line_number: 2,
        account_code: "2000",
        description: "Accrued liabilities",
        credit_minor: 45000,
        currency_code: "USD",
      },
      update: { description: "Staging rental reclass" },
      remove: true,
    });
    await expectContract(journalLinesR.list, "journalLines.list");
    await expectContract(journalLinesR.get, "journalLines.get");
    await expectContract(step(journalLinesR.create), "journalLines.create");
    await expectContract(step(journalLinesR.update), "journalLines.update");
    await expectContract(step(journalLinesR.remove), "journalLines.delete");
    db.fail("rpc:post_journal_entry", refusal("sod_journal_preparer"));
    const own = await http.post(`/journal-entries/${ENTRY}/post`);
    expect(own.status).toBe(422);
    const posted = (await expectContract(
      await success(http.post(`/journal-entries/${ENTRY}/post`)),
      "journalEntries.post",
    )) as Row;
    expect(posted["journal_state"]).toBe("Posted");
    expect(posted["posted_at"]).not.toBeNull();
  });

  it("serves posting lines and exports a period through the canon mapping", async () => {
    const { http } = world();
    const postingLinesR = await crud(http, {
      path: "/posting-lines",
      op: "postingLines",
      key: POSTING,
    });
    await expectContract(postingLinesR.list, "postingLines.list");
    await expectContract(postingLinesR.get, "postingLines.get");
    stubs.postings = [
      {
        id: POSTING,
        projectId: PROJECT,
        date: "2026-09-15",
        accountCode: "5400",
        costCenterCode: "CC-VENUE",
        urid: "4000.01.01",
        vendorId: null,
        itemId: null,
        description: "Stage deck rental, opening weekend",
        quantity: null,
        unitBasis: null,
        amountMinor: 45000,
        taxType: "None",
        currency: "USD",
        externalRef: "",
        lineState: "Complete",
      },
    ];
    const sent5 = await success(
      http.post("/posting-lines/exports", { target: "xero", accounting_period_id: PERIOD }),
    );
    const exported = (await expectContract(sent5, "postingLines.export")) as Row;
    expect(exported["row_count"]).toBe(1);
    expect(exported["filename"]).toBe("upl-xero-2026-09-01-2026-09-30.csv");
    expect((exported["header"] as string[]).slice(0, 2)).toEqual(["Date", "account_code"]);
    expect(String(exported["csv"])).toContain('"Stage deck rental, opening weekend"');
    expect(String(exported["csv"])).toContain("450.00");
    const unmapped = await http.post("/posting-lines/exports", {
      target: "netsuite",
      accounting_period_id: PERIOD,
    });
    expect(unmapped.status).toBe(422);
    expect(((await unmapped.json()) as Row)["refusal"]).toBe("NO_ANSWER");
    const hidden = await http.post("/posting-lines/exports", {
      target: "xero",
      accounting_period_id: MISSING,
    });
    expect(hidden.status).toBe(404);
  });
});

describe("invoices and payments", () => {
  it("serves invoices with their total, lines and payment applications", async () => {
    const { http } = world();
    const read = (await expectContract(
      await success(http.get(`/invoices/${INVOICE}`)),
      "invoices.get",
    )) as Row;
    expect(read["total"]).toEqual({ total_minor: 108000, currency: "USD", unpriced_count: 0 });
    const invoicesR = await crud(http, {
      path: "/invoices",
      op: "invoices",
      key: INVOICE,
      create: {
        project_id: PROJECT,
        direction: "Receivable",
        counterparty_id: PARTY,
        currency_code: "USD",
      },
      update: { due_on: "2026-10-20" },
    });
    await expectContract(invoicesR.list, "invoices.list");
    await expectContract(invoicesR.get, "invoices.get");
    await expectContract(step(invoicesR.create), "invoices.create");
    await expectContract(step(invoicesR.update), "invoices.update");
    const invoiceLinesR = await crud(http, {
      path: "/invoice-lines",
      op: "invoiceLines",
      key: ILINE,
      create: { invoice_id: INVOICE, line_number: 2, description: "Delivery" },
      update: { unit_price_minor: 4800 },
      remove: true,
    });
    await expectContract(invoiceLinesR.list, "invoiceLines.list");
    await expectContract(invoiceLinesR.get, "invoiceLines.get");
    await expectContract(step(invoiceLinesR.create), "invoiceLines.create");
    await expectContract(step(invoiceLinesR.update), "invoiceLines.update");
    await expectContract(step(invoiceLinesR.remove), "invoiceLines.delete");
    const applied = (await expectContract(
      await success(http.get(`/payment-applications/${APPLICATION}`)),
      "paymentApplications.get",
    )) as Row;
    expect(applied).toMatchObject({
      paid_on: "2026-09-20",
      currency_code: "USD",
      external_ref: "ACH-77812",
    });
    const paymentApplicationsR = await crud(http, {
      path: "/payment-applications",
      op: "paymentApplications",
      key: APPLICATION,
      create: { payment_id: PAYMENT, invoice_id: INVOICE, amount_minor: 1000 },
    });
    await expectContract(paymentApplicationsR.list, "paymentApplications.list");
    await expectContract(paymentApplicationsR.get, "paymentApplications.get");
    await expectContract(step(paymentApplicationsR.create), "paymentApplications.create");
  });

  it("issues, approves and refuses invoice transitions by rule", async () => {
    const { db, http } = world();
    setState(db, "invoices", INVOICE, "direction", "Receivable");
    const sent6 = await success(
      http.post(`/invoices/${INVOICE}/transitions`, {
        expected_state: "Proposed",
        to_state: "Issued",
      }),
    );
    const issued = (await expectContract(sent6, "invoices.transition")) as Row;
    expect(issued["invoice_state"]).toBe("Issued");
    const sent7 = await success(
      http.post(`/invoices/${INVOICE}/transitions`, {
        expected_state: "Issued",
        to_state: "Disputed",
        reason: "Client queried the delivery line.",
      }),
    );
    const disputed = (await expectContract(sent7, "invoices.transition")) as Row;
    expect(disputed["invoice_state"]).toBe("Disputed");
    setState(db, "invoices", INVOICE, "invoice_state", "Proposed");
    const sent8 = await success(
      http.post(`/invoices/${INVOICE}/transitions`, {
        expected_state: "Proposed",
        to_state: "Approved",
      }),
    );
    await expectContract(sent8, "invoices.transition");
    setState(db, "invoices", INVOICE, "invoice_state", "Proposed");
    db.fail("rpc:approve_invoice", refusal("sod_vendor_bank_editor"));
    const blocked = await http.post(`/invoices/${INVOICE}/approve`);
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as Row)["rule"]).toBe("sod_vendor_bank_editor");
    const approved = (await expectContract(
      await success(http.post(`/invoices/${INVOICE}/approve`)),
      "invoices.approve",
    )) as Row;
    expect(approved["invoice_state"]).toBe("Approved");
    const stale = await http.post(`/invoices/${INVOICE}/transitions`, {
      expected_state: "Proposed",
      to_state: "Canceled",
    });
    expect(stale.status).toBe(409);
  });

  it("serves dashboards, tiles, report schedules, recipients and deliveries (A38-004)", async () => {
    const { http } = world();
    const schedulesR = await crud(http, {
      path: "/report-schedules",
      op: "reportSchedules",
      key: SCHEDULE,
      create: {
        report_definition_id: REPORT,
        cadence: "Monthly",
        local_hour: 7,
        month_day: 1,
        time_zone: "America/New_York",
        export_format: "XLSX",
      },
      update: { local_hour: 9 },
    });
    await expectContract(schedulesR.list, "reportSchedules.list");
    await expectContract(schedulesR.get, "reportSchedules.get");
    await expectContract(step(schedulesR.create), "reportSchedules.create");
    await expectContract(step(schedulesR.update), "reportSchedules.update");
    const scheduleGone = await success(http.delete(`/report-schedules/${SCHEDULE}`));
    await expectContract(scheduleGone, "reportSchedules.delete");

    const dashboardsR = await crud(http, {
      path: "/dashboards",
      op: "dashboards",
      key: DASHBOARD,
      create: { name: "Finance Week" },
      update: { name: "Show Week Two" },
    });
    await expectContract(dashboardsR.list, "dashboards.list");
    await expectContract(dashboardsR.get, "dashboards.get");
    const createdDashboard = (await expectContract(
      step(dashboardsR.create),
      "dashboards.create",
    )) as Row;
    expect(createdDashboard["membership_id"]).toBe(MEMBERSHIP);
    await expectContract(step(dashboardsR.update), "dashboards.update");

    const tilesR = await crud(http, {
      path: "/dashboard-tiles",
      op: "dashboardTiles",
      key: TILE,
      create: {
        dashboard_id: DASHBOARD,
        report_definition_id: REPORT,
        grid_column: 7,
        grid_row: 1,
        column_span: 6,
        row_span: 1,
      },
      update: { column_span: 5 },
      remove: true,
    });
    await expectContract(tilesR.list, "dashboardTiles.list");
    await expectContract(tilesR.get, "dashboardTiles.get");
    await expectContract(step(tilesR.create), "dashboardTiles.create");
    await expectContract(step(tilesR.update), "dashboardTiles.update");
    await expectContract(step(tilesR.remove), "dashboardTiles.delete");
    const dashboardGone = await success(http.delete(`/dashboards/${DASHBOARD}`));
    await expectContract(dashboardGone, "dashboards.delete");

    const recipientsR = await crud(http, {
      path: "/report-schedule-recipients",
      op: "reportScheduleRecipients",
      key: RECIPIENT,
      create: { report_schedule_id: SCHEDULE, membership_id: MEMBERSHIP },
      remove: true,
    });
    await expectContract(recipientsR.list, "reportScheduleRecipients.list");
    await expectContract(recipientsR.get, "reportScheduleRecipients.get");
    await expectContract(step(recipientsR.create), "reportScheduleRecipients.create");
    await expectContract(step(recipientsR.remove), "reportScheduleRecipients.delete");

    const deliveriesList = await success(http.get("/report-deliveries"));
    await expectContract(deliveriesList, "reportDeliveries.list");
    const deliveryOne = await success(http.get(`/report-deliveries/${DELIVERY}`));
    const delivery = (await expectContract(deliveryOne, "reportDeliveries.get")) as Row;
    expect(delivery["delivery_status"]).toBe("Sent");
  });

  it("lists the 1099-NEC payees of a tax year without full TINs (A38-006)", async () => {
    const { db, http } = world();
    const sent = await success(http.get("/form-1099-nec/rows?year=2025"));
    const page = (await expectContract(sent, "form1099Nec.rows")) as { data: Row[] };
    expect(page.data[0]).toMatchObject({ payee_name: "Ivy Marchetti", amount_minor: 75000 });
    expect(page.data[0]).not.toHaveProperty("tin");
    expect(db.calls.findLast((c) => c.name === "form_1099_nec_rows")?.args).toEqual({
      p_org_id: ORG,
      p_year: 2025,
      p_include_tin: false,
    });
  });

  it("records a payment against an approved invoice (A38-007)", async () => {
    const { db, http } = world();
    const early = await http.post(`/invoices/${INVOICE}/record-payment`, { paid_on: "2026-10-12" });
    expect(early.status).toBe(422);
    expect(((await early.json()) as Row)["rule"]).toBe("invoice_payment_state");
    setState(db, "invoices", INVOICE, "invoice_state", "Approved");
    const sent = await success(
      http.post(`/invoices/${INVOICE}/record-payment`, {
        paid_on: "2026-10-12",
        reference: "ACH-2027-0042",
      }),
    );
    const paid = (await expectContract(sent, "invoices.recordPayment")) as Row;
    expect(paid["id"]).toBe(INVOICE);
    expect(db.calls.findLast((c) => c.name === "record_invoice_payment")?.args).toEqual({
      p_invoice_id: INVOICE,
      p_paid_on: "2026-10-12",
      p_reference: "ACH-2027-0042",
    });
    const missing = await http.post(`/invoices/${MISSING}/record-payment`, {
      paid_on: "2026-10-12",
    });
    expect(missing.status).toBe(404);
  });

  it("serves billing draws, tax jurisdictions, tax rates and FX rates", async () => {
    const { http } = world();
    const billingDrawsR = await crud(http, {
      path: "/billing-draws",
      op: "billingDraws",
      key: BILLING,
      create: {
        project_id: PROJECT,
        draw_number: 2,
        period_end: "2026-10-31",
        amount_requested_minor: 2500000,
        currency_code: "USD",
      },
      update: { amount_requested_minor: 2600000 },
      remove: true,
    });
    await expectContract(billingDrawsR.list, "billingDraws.list");
    await expectContract(billingDrawsR.get, "billingDraws.get");
    await expectContract(step(billingDrawsR.create), "billingDraws.create");
    await expectContract(step(billingDrawsR.update), "billingDraws.update");
    await expectContract(step(billingDrawsR.remove), "billingDraws.delete");
    const taxJurisdictionsR = await crud(http, {
      path: "/tax-jurisdictions",
      op: "taxJurisdictions",
      key: JURISDICTION,
      create: { jurisdiction_id: "US-NY", name: "New York Sales Tax" },
      update: { name: "Florida State Sales Tax" },
      remove: true,
    });
    await expectContract(taxJurisdictionsR.list, "taxJurisdictions.list");
    await expectContract(taxJurisdictionsR.get, "taxJurisdictions.get");
    await expectContract(step(taxJurisdictionsR.create), "taxJurisdictions.create");
    await expectContract(step(taxJurisdictionsR.update), "taxJurisdictions.update");
    await expectContract(step(taxJurisdictionsR.remove), "taxJurisdictions.delete");
    const taxRatesR = await crud(http, {
      path: "/tax-rates",
      op: "taxRates",
      key: RATE,
      create: {
        tax_jurisdiction_id: JURISDICTION,
        tax_type: "Tax on Purchases",
        rate_percent: 6,
        effective_from: "2027-01-01",
      },
      update: { effective_to: "2026-12-31" },
      remove: true,
    });
    await expectContract(taxRatesR.list, "taxRates.list");
    await expectContract(taxRatesR.get, "taxRates.get");
    await expectContract(step(taxRatesR.create), "taxRates.create");
    await expectContract(step(taxRatesR.update), "taxRates.update");
    await expectContract(step(taxRatesR.remove), "taxRates.delete");
    const rates = (await expectContract(await success(http.get("/fx-rates")), "fxRates.list")) as {
      data: Row[];
    };
    expect(rates.data[0]).toMatchObject({ quote_currency: "EUR", effective_on: "2026-09-30" });
  });
});

describe("reports", () => {
  it("reads saved report definitions and runs, and queues a run", async () => {
    const { db, http } = world();
    const reportDefinitionsR = await crud(http, {
      path: "/report-definitions",
      op: "reportDefinitions",
      key: REPORT,
      create: { name: "Labor by Department", source_code: "crew", chart: "Table", shared: false },
      update: { name: "Labor by Discipline" },
      remove: true,
    });
    await expectContract(reportDefinitionsR.list, "reportDefinitions.list");
    await expectContract(reportDefinitionsR.get, "reportDefinitions.get");
    const createdDefinition = (await expectContract(
      step(reportDefinitionsR.create),
      "reportDefinitions.create",
    )) as Row;
    expect(createdDefinition["membership_id"]).toBe(MEMBERSHIP);
    await expectContract(step(reportDefinitionsR.update), "reportDefinitions.update");
    await expectContract(step(reportDefinitionsR.remove), "reportDefinitions.delete");
    // The source is fixed: its fields and filters name that source's columns.
    expect(
      (await http.patch(`/report-definitions/${REPORT}`, { source_code: "finance" })).status,
    ).toBe(422);
    const reportRunsR = await crud(http, { path: "/report-runs", op: "reportRuns", key: RUN });
    await expectContract(reportRunsR.list, "reportRuns.list");
    await expectContract(reportRunsR.get, "reportRuns.get");
    const queued = await http.post("/report-runs", {
      report_definition_id: REPORT,
      export_format: "PDF",
    });
    expect(queued.status).toBe(201);
    const run = (await expectContract(queued, "reportRuns.create")) as Row;
    expect(run).toMatchObject({ run_status: "Queued", export_format: "PDF" });
    db.fail("rpc:run_report", { code: "42501", message: "report not found" });
    expect(
      (await http.post("/report-runs", { report_definition_id: MISSING, export_format: "CSV" }))
        .status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("answers budget versus actual with MoneyTotal rows", async () => {
    const { http } = world();
    stubs.bva = {
      rows: [
        {
          key: "5400",
          currency: "USD",
          budgetMinor: null,
          unpricedCount: 1,
          approvedChangeMinor: 250,
          revisedMinor: null,
          pricedRevisedMinor: 1250,
          actualMinor: 400,
          varianceMinor: null,
          budgetLineIds: [LINE],
        },
        {
          key: "",
          currency: "USD",
          budgetMinor: 0,
          unpricedCount: 0,
          approvedChangeMinor: 0,
          revisedMinor: 0,
          pricedRevisedMinor: 0,
          actualMinor: 0,
          varianceMinor: 0,
          budgetLineIds: [],
        },
      ],
      totals: [],
    };
    const page = (await expectContract(
      await success(http.get(`/reports/budget-vs-actual?dimension=account&project_id=${PROJECT}`)),
      "reports.budgetVsActual",
    )) as { data: Row[] };
    expect(page.data[0]).toEqual({
      dimension: "5400",
      budget: { total_minor: 1250, currency: "USD", unpriced_count: 1 },
      actual: { total_minor: 400, currency: "USD", unpriced_count: 0 },
    });
    expect(page.data[1]?.["dimension"]).toBe("unassigned");
    expect((await http.get("/reports/budget-vs-actual?dimension=vendor")).status).toBe(422);
  });

  it("answers the final cost report, NO_ANSWER without a baseline", async () => {
    const { http } = world();
    stubs.finalCost = {
      hasBaseline: true,
      rows: [
        {
          accountCode: "5400",
          currency: "USD",
          baselineMinor: 10000,
          baselineUnpricedCount: 0,
          approvedChangeMinor: 2500,
          revisedMinor: 12500,
          pricedRevisedMinor: 12500,
          actualMinor: 9000,
          varianceMinor: 3500,
          budgetLineIds: [LINE],
        },
        {
          accountCode: "",
          currency: "USD",
          baselineMinor: null,
          baselineUnpricedCount: 2,
          approvedChangeMinor: 0,
          revisedMinor: null,
          pricedRevisedMinor: null,
          actualMinor: 0,
          varianceMinor: null,
          budgetLineIds: [],
        },
      ],
    };
    const page = (await expectContract(
      await success(http.get(`/reports/final-cost-report?project_id=${PROJECT}`)),
      "reports.finalCostReport",
    )) as { data: Row[] };
    expect(page.data[0]?.["budget"]).toEqual({
      total_minor: 12500,
      currency: "USD",
      unpriced_count: 0,
    });
    expect(page.data[1]).toMatchObject({
      dimension: "unassigned",
      budget: { total_minor: null, unpriced_count: 2 },
    });
    expect((await http.get("/reports/final-cost-report")).status).toBe(422);
    stubs.finalCost = { hasBaseline: false, rows: [] };
    const none = await http.get(`/reports/final-cost-report?project_id=${PROJECT}`);
    expect(none.status).toBe(422);
    expect(((await none.json()) as Row)["refusal"]).toBe("NO_ANSWER");
  });

  it("answers purchase order exposure by vendor", async () => {
    const { http } = world();
    const order = (over: Row) => ({
      purchaseOrderId: PO,
      poNumber: 1,
      projectId: PROJECT,
      projectKey: "NWL",
      vendorName: "Stageworks",
      state: "Approved",
      currency: "USD",
      unpricedCount: 0,
      committedMinor: 50000,
      receivedMinor: 20000,
      exposureMinor: 30000,
      ...over,
    });
    stubs.exposure = [
      order({}),
      order({ poNumber: 2, committedMinor: null, unpricedCount: 1, receivedMinor: 0 }),
      order({ poNumber: 3, vendorName: null }),
    ];
    const page = (await expectContract(
      await success(http.get(`/reports/po-exposure?project_id=${PROJECT}`)),
      "reports.poExposure",
    )) as { data: Row[] };
    expect(page.data.map((r) => r["dimension"])).toEqual(["Stageworks", "unassigned"]);
    expect(page.data[0]).toMatchObject({
      budget: { total_minor: 50000, unpriced_count: 1 },
      actual: { total_minor: 20000, unpriced_count: 0 },
    });
  });
});
