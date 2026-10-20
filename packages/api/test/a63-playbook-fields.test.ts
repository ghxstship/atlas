/**
 * Contract tests for the last Playbook field targets (A63, RRR-108, finding A54-002): the read-only fields filled
 * once per page from a view, ledger or sidecar, the columns added to custom handlers, and the three new resources
 * (cue calls, project authorities, canon emergency protocols). Requests run through `contractApp` against the
 * in-memory client, and every success is checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as activity } from "../src/handlers/activity.ts";
import { handlers as canon } from "../src/handlers/canon.ts";
import { handlers as crew } from "../src/handlers/crew.ts";
import { handlers as finance } from "../src/handlers/finance.ts";
import { handlers as opportunities } from "../src/handlers/opportunities.ts";
import { handlers as procurement } from "../src/handlers/procurement.ts";
import { handlers as projects } from "../src/handlers/projects.ts";
import { handlers as show } from "../src/handlers/show.ts";
import { handlers as vendors } from "../src/handlers/vendors.ts";
import { handlers as work } from "../src/handlers/work.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(63000 + n).padStart(12, "0")}`;
const T = "2026-10-15T12:00:00.000Z";
const LATER = "2026-10-16T09:30:00.000Z";

type Page = { data: Row[] };
const row = (component: string, n: number, extra: Row = {}): Row => ({
  ...sample(component),
  ...tenantRow(id(n), ORG),
  ...extra,
});

describe("Finance: budget line, change order and change order line facts", () => {
  it("reads a budget line's actual spend and GL account from app.budget_line_facts", async () => {
    const db = memoryDb({
      budget_lines: [row("BudgetLine", 1, { actual_minor: 1, account_code: "0000" })],
      budget_line_facts: [{ budget_line_id: id(1), actual_minor: 480000, account_code: "5400" }],
    });
    const http = requests(contractApp({ handlers: [finance], db }));
    const page = (await expectContract(
      await success(http.get("/budget-lines")),
      "budgetLines.list",
    )) as Page;
    expect(page.data[0]).toMatchObject({ actual_minor: 480000, account_code: "5400" });
    const one = (await expectContract(
      await success(http.get(`/budget-lines/${id(1)}`)),
      "budgetLines.get",
    )) as Row;
    expect(one).toMatchObject({ actual_minor: 480000, account_code: "5400" });
    // A sparse read that asks for no derived field never reads the view.
    db.tables["budget_line_facts"] = [];
    await success(http.get(`/budget-lines/${id(1)}?fields=description`));
  });

  it("reads a change order line's GL account and cost center, and who approved the order", async () => {
    const db = memoryDb({
      change_order_lines: [row("ChangeOrderLine", 2, { change_order_id: id(3) })],
      change_order_line_facts: [
        { change_order_line_id: id(2), account_code: "5500", cost_center_id: id(90) },
      ],
      change_orders: [row("ChangeOrder", 3), row("ChangeOrder", 4)],
      change_order_state_transitions: [
        tenantRow(id(10), ORG, {
          change_order_id: id(3),
          to_state: "Approved",
          created_at: T,
          created_by: ME,
        }),
        tenantRow(id(11), ORG, {
          change_order_id: id(4),
          to_state: "Priced",
          created_at: T,
          created_by: ME,
        }),
      ],
      budgets: [{ id: sample("ChangeOrder")["budget_id"], currency_code: "USD" }],
    });
    const http = requests(contractApp({ handlers: [finance], db }));
    const line = (await expectContract(
      await success(http.get(`/change-order-lines/${id(2)}`)),
      "changeOrderLines.get",
    )) as Row;
    expect(line).toMatchObject({ account_code: "5500", cost_center_id: id(90) });
    const orders = (await expectContract(
      await success(http.get("/change-orders")),
      "changeOrders.list",
    )) as Page;
    const approved = orders.data.find((o) => o["id"] === id(3));
    const priced = orders.data.find((o) => o["id"] === id(4));
    expect(approved).toMatchObject({ approved_at: T, approved_by: ME });
    expect(priced).toMatchObject({ approved_at: null, approved_by: null });
  });
});

describe("Procurement: a purchase order's issue date and invoicing", () => {
  it("reads sent_at from the ledger and sums the matched invoices NULL-aware", async () => {
    const db = memoryDb({
      purchase_orders: [
        row("PurchaseOrder", 20),
        row("PurchaseOrder", 21),
        row("PurchaseOrder", 22),
      ],
      purchase_order_state_transitions: [
        tenantRow(id(30), ORG, { purchase_order_id: id(20), to_state: "Sent", created_at: T }),
      ],
      invoice_matches: [
        tenantRow(id(31), ORG, { purchase_order_id: id(20), invoice_id: id(40) }),
        tenantRow(id(32), ORG, { purchase_order_id: id(20), invoice_id: id(41) }),
        // A second match of the same invoice (another receipt) counts it once.
        tenantRow(id(33), ORG, { purchase_order_id: id(20), invoice_id: id(41) }),
        tenantRow(id(34), ORG, { purchase_order_id: id(21), invoice_id: id(42) }),
      ],
      invoice_totals: [
        { invoice_id: id(40), subtotal_minor: 100000, applied_minor: 100000 },
        { invoice_id: id(41), subtotal_minor: 25000, applied_minor: 0 },
        { invoice_id: id(42), subtotal_minor: null, applied_minor: 0 },
      ],
    });
    const http = requests(contractApp({ handlers: [procurement], db }));
    const page = (await expectContract(
      await success(http.get("/purchase-orders")),
      "purchaseOrders.list",
    )) as Page;
    const byId = new Map(page.data.map((o) => [o["id"], o]));
    expect(byId.get(id(20))).toMatchObject({
      sent_at: T,
      invoiced_minor: 125000,
      paid_minor: 100000,
    });
    // One unpriced invoice leaves the invoiced amount unpriced, never zero.
    expect(byId.get(id(21))).toMatchObject({ sent_at: null, invoiced_minor: null, paid_minor: 0 });
    expect(byId.get(id(22))).toMatchObject({ invoiced_minor: null, paid_minor: null });
    await expectContract(
      await success(http.get(`/purchase-orders/${id(20)}`)),
      "purchaseOrders.get",
    );
  });
});

describe("Crew: a time entry's meal break", () => {
  it("reads the first Break Start and the last Break End punch", async () => {
    const punch = (n: number, kind: string, at: string, entry = id(50)) =>
      tenantRow(id(n), ORG, { time_entry_id: entry, punch_kind: kind, effective_at: at });
    const db = memoryDb({
      time_entries: [row("TimeEntry", 50), row("TimeEntry", 51)],
      clock_punches: [
        punch(52, "In", "2026-10-15T08:00:00.000Z"),
        punch(53, "Break Start", "2026-10-15T12:00:00.000Z"),
        punch(54, "Break End", "2026-10-15T12:30:00.000Z"),
        punch(55, "Break Start", "2026-10-15T15:00:00.000Z"),
        punch(56, "Break End", "2026-10-15T15:10:00.000Z"),
      ],
    });
    const http = requests(contractApp({ handlers: [crew], db }));
    const page = (await expectContract(
      await success(http.get("/time-entries")),
      "timeEntries.list",
    )) as Page;
    const byId = new Map(page.data.map((e) => [e["id"], e]));
    expect(byId.get(id(50))).toMatchObject({
      meal_out_at: "2026-10-15T12:00:00.000Z",
      meal_in_at: "2026-10-15T15:10:00.000Z",
    });
    expect(byId.get(id(51))).toMatchObject({ meal_out_at: null, meal_in_at: null });
    await expectContract(await success(http.get(`/time-entries/${id(50)}`)), "timeEntries.get");
  });
});

describe("Vendors: the last four digits of the bank account", () => {
  it("reads the most recent account through the masked view", async () => {
    const db = memoryDb({
      vendors: [row("Vendor", 60), row("Vendor", 61)],
      counterparties: [],
      vendor_bank_accounts_masked: [
        { id: id(62), vendor_id: id(60), account_last4: "1111" },
        { id: id(63), vendor_id: id(60), account_last4: "4321" },
      ],
    });
    const http = requests(contractApp({ handlers: [vendors], db }));
    const page = (await expectContract(
      await success(http.get("/vendors")),
      "vendors.list",
    )) as Page;
    const byId = new Map(page.data.map((v) => [v["id"], v]));
    expect(byId.get(id(60))?.["bank_account_last4"]).toBe("4321");
    expect(byId.get(id(61))?.["bank_account_last4"]).toBeNull();
  });
});

describe("Work: a record's assignees and subtype facts", () => {
  it("reads assignees, progress, permit identifier and inspection result once per page", async () => {
    const PROJECT = id(70);
    const record = (n: number) => ({
      ...row("Record", n, { project_id: PROJECT, record_number: n }),
      external_visibility: undefined,
    });
    const db = memoryDb({
      records: [record(71), record(72)],
      projects: [{ id: PROJECT, project_key: "MIA26" }],
      record_external_visibility: [],
      record_assignments: [
        tenantRow(id(73), ORG, { record_id: id(71), membership_id: id(80), created_at: T }),
        tenantRow(id(74), ORG, { record_id: id(71), membership_id: id(81), created_at: LATER }),
      ],
      record_task: [tenantRow(id(75), ORG, { record_id: id(71), progress_pct: 40 })],
      record_permit: [
        tenantRow(id(76), ORG, { record_id: id(72), permit_identifier: "BP-2027-0611" }),
      ],
      record_inspection: [tenantRow(id(77), ORG, { record_id: id(72), result_enum_id: id(82) })],
    });
    const http = requests(contractApp({ handlers: [work], db }));
    const page = (await expectContract(
      await success(http.get("/records")),
      "records.list",
    )) as Page;
    const byId = new Map(page.data.map((r) => [r["id"], r]));
    expect(byId.get(id(71))).toMatchObject({
      assignee_membership_ids: [id(80), id(81)],
      progress_pct: 40,
      permit_identifier: null,
      inspection_result_enum_id: null,
    });
    expect(byId.get(id(72))).toMatchObject({
      assignee_membership_ids: [],
      progress_pct: null,
      permit_identifier: "BP-2027-0611",
      inspection_result_enum_id: id(82),
    });
    const one = (await expectContract(
      await success(http.get(`/records/${id(71)}?fields=progress_pct`)),
      "records.get",
      { sparse: true },
    )) as Row;
    expect(one).toEqual({ id: id(71), progress_pct: 40 });
  });
});

describe("Activity and engagements", () => {
  it("names the domain event of each activity entry", async () => {
    const entry = {
      id: id(90),
      occurred_at: T,
      event_type: "project.state_changed",
      subject_table: "projects",
      subject_id: id(91),
      project_id: null,
      project_key: null,
      project_name: null,
      actor_person_id: ME,
      actor_name: "Alex Rivera",
      record_key: null,
      record_title: null,
      data: {},
      description: "Project state changed",
    };
    const db = memoryDb(
      { activity_events: [tenantRow(id(90), ORG, { domain_event_id: id(92) })] },
      { activity_feed: () => [entry] },
    );
    const http = requests(contractApp({ handlers: [activity], db }));
    const page = (await expectContract(
      await success(http.get("/activity-events")),
      "activityEvents.list",
    )) as Page;
    expect(page.data[0]?.["domain_event_id"]).toBe(id(92));
    const one = (await expectContract(
      await success(http.get(`/activity-events/${id(90)}`)),
      "activityEvents.get",
    )) as Row;
    expect(one["domain_event_id"]).toBe(id(92));
  });

  it("returns the counterparty an engagement runs through", async () => {
    const db = memoryDb({
      engagements: [
        tenantRow(id(95), ORG, {
          project_id: id(96),
          person_id: ME,
          role_type: "Contractor",
          engagement_state: "Active",
          application_id: null,
          worker_classification: "W2_Hourly",
          created_by: ME,
          updated_by: ME,
          pay_basis: null,
          arrangement: null,
          start_date: "2026-10-01",
          end_date: null,
          counterparty_id: id(97),
        }),
      ],
    });
    const http = requests(contractApp({ handlers: [opportunities], db }));
    const one = (await expectContract(
      await success(http.get(`/engagements/${id(95)}`)),
      "engagements.get",
    )) as Row;
    expect(one["counterparty_id"]).toBe(id(97));
  });
});

describe("Show: cue calls", () => {
  it("lists, reads, creates, updates and deletes a department's call on a cue", async () => {
    const db = memoryDb({
      cue_calls: [
        tenantRow(id(100), ORG, {
          cue_id: id(101),
          call_kind: "Lighting",
          instruction: "LX 14 GO.",
        }),
      ],
    });
    const http = requests(contractApp({ handlers: [show], db }));
    const page = (await expectContract(
      await success(http.get(`/cue-calls?filter[cue_id][eq]=${id(101)}`)),
      "cueCalls.list",
    )) as Page;
    expect(page.data.map((c) => c["instruction"])).toEqual(["LX 14 GO."]);
    await expectContract(await success(http.get(`/cue-calls/${id(100)}`)), "cueCalls.get");
    const posted = await success(
      http.post("/cue-calls", { cue_id: id(101), call_kind: "Audio", instruction: "Walk-in out." }),
    );
    const made = (await expectContract(posted, "cueCalls.create")) as Row;
    expect(made).toMatchObject({ call_kind: "Audio", org_id: ORG });
    const patched = await success(
      http.patch(`/cue-calls/${id(100)}`, { instruction: "LX 15 GO." }),
    );
    const changed = (await expectContract(patched, "cueCalls.update")) as Row;
    expect(changed["instruction"]).toBe("LX 15 GO.");
    const gone = await http.delete(`/cue-calls/${id(100)}`);
    expect(gone.status).toBe(204);
    await expectContract(gone, "cueCalls.delete");
    expect((await http.get(`/cue-calls/${id(100)}`)).status).toBe(404);
  });
});

describe("Projects: authorities having jurisdiction", () => {
  it("lists a project's responder agencies from app.project_authority", async () => {
    const authority = (service: string, agency: string, project = id(110)) => ({
      project_id: project,
      service,
      agency,
      contact: "911",
    });
    const db = memoryDb({
      project_authority: [
        authority("fire", "Miami Fire-Rescue"),
        authority("ems", "Miami Fire-Rescue"),
        authority("police", "Miami Police Department", id(111)),
      ],
    });
    const http = requests(contractApp({ handlers: [projects], db }));
    const page = (await expectContract(
      await success(http.get(`/project-authorities?filter[project_id][eq]=${id(110)}`)),
      "projectAuthorities.list",
    )) as Page;
    expect(page.data.map((a) => a["service"])).toEqual(["ems", "fire"]);
    expect(page.data[0]?.["agency"]).toBe("Miami Fire-Rescue");
  });
});

describe("Canon: Standard Library columns and emergency protocols", () => {
  it("reads emergency protocols with their numbered steps", async () => {
    const protocol = (key: string, domain: string) => ({
      record_key: key,
      code: "CODE_RED",
      domain,
      department: "Security & Safety",
      category: "Emergency Protocols",
      sub_category: "Incident Response",
    });
    const db = memoryDb({
      "xpms.emergency_protocol": [
        protocol("EMG-001", "Site Operations"),
        protocol("EMG-002", "Stage Operations"),
      ],
      "xpms.emergency_protocol_step": [
        { record_key: "EMG-001", step_no: 2, body: "Contact {fire}." },
        { record_key: "EMG-001", step_no: 1, body: "Activate the extinguishers." },
      ],
    });
    const http = requests(contractApp({ handlers: [canon], db }));
    const page = (await expectContract(
      await success(http.get("/canon/std/emergency-protocols")),
      "canonStdEmergencyProtocols.list",
    )) as Page;
    expect(page.data.map((p) => p["record_key"])).toEqual(["EMG-001", "EMG-002"]);
    expect(page.data[1]?.["steps"]).toEqual([]);
    const one = (await expectContract(
      await success(http.get("/canon/std/emergency-protocols/EMG-001")),
      "canonStdEmergencyProtocols.get",
    )) as Row;
    expect(one["steps"]).toEqual([
      { step_no: 1, body: "Activate the extinguishers." },
      { step_no: 2, body: "Contact {fire}." },
    ]);
  });

  it("reads the normal balance per account type and the category's default GL account", async () => {
    const db = memoryDb({
      "xpms.dim_gl_account": [
        { ...sample("CanonGlAccount"), account_code: "5400", account_type: "Expense" },
        { ...sample("CanonGlAccount"), account_code: "4100", account_type: "Revenue" },
      ],
      "xpms.dim_gl_account_type": [
        { account_type: "Expense", normal_balance: "Debit" },
        { account_type: "Revenue", normal_balance: "Credit" },
      ],
      "xpms.dim_category_gl": [{ cat_urid: "5000.05.02", default_cost_center: "Production" }],
      "xpms.v_category_gl": [{ cat_urid: "5000.05.02", account_code: "5500" }],
      "xpms.dim_category": [{ ...sample("CanonCategory"), xyz: "Y" }],
    });
    const http = requests(contractApp({ handlers: [canon], db }));
    const accounts = (await expectContract(
      await success(http.get("/canon/gl-accounts")),
      "canonGlAccounts.list",
    )) as Page;
    expect(accounts.data.map((a) => [a["account_code"], a["normal_balance"]])).toEqual([
      ["4100", "Credit"],
      ["5400", "Debit"],
    ]);
    const gl = (await expectContract(
      await success(http.get("/canon/category-gl/5000.05.02")),
      "canonCategoryGl.get",
    )) as Row;
    expect(gl).toMatchObject({ default_cost_center: "Production", account_code: "5500" });
    const categories = (await expectContract(
      await success(http.get("/canon/categories")),
      "canonCategories.list",
    )) as Page;
    expect(categories.data[0]?.["xyz"]).toBe("Y");
  });
});
