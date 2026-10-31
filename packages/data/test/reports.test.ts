import { describe, expect, it } from "vitest";
import {
  budgetVersusActual,
  coordinateMatrix,
  finalCostReport,
  gateReadiness,
  incidentsReport,
  laborReport,
  listMyRuns,
  listSavedReports,
  listSharedReports,
  purchaseOrderExposure,
  revokeSharedReport,
  runReport,
  shareReport,
  workingBudgetIds,
} from "../src/reports.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const project = { id: "p1", project_key: "NWL", name: "Summer", current_phase_code: "ADV" };

const fact = (over: Record<string, unknown>) => ({
  budget_line_id: "l1",
  budget_id: "work",
  project_id: "p1",
  is_baseline: false,
  currency_code: "USD",
  line_type: "Cost",
  urid: "5000.04.02",
  dept_code: "5000",
  account_code: "5500",
  cost_center_code: "CC-VENUE",
  extended_minor: 1000,
  actual_minor: 400,
  ...over,
});

describe("working budgets", () => {
  it("counts the working budgets and falls back to the baseline only when it is alone", () => {
    const ids = workingBudgetIds([
      { budgetId: "base", projectId: "p1", isBaseline: true },
      { budgetId: "work", projectId: "p1", isBaseline: false },
      { budgetId: "only", projectId: "p2", isBaseline: true },
    ]);
    expect([...ids].sort()).toEqual(["only", "work"]);
  });
});

describe("budget versus actual", () => {
  it("groups by account with NULL-aware budgets and applies approved changes", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [
        okResponse([
          fact({}),
          fact({ budget_line_id: "l2", extended_minor: null, actual_minor: 0 }),
          fact({ budget_line_id: "l3", account_code: "5600", urid: "6000.01", dept_code: "6000" }),
          fact({ budget_line_id: "lb", budget_id: "base", is_baseline: true }),
        ]),
      ],
      "from:change_order_line_facts": [
        okResponse([
          {
            budget_id: "work",
            project_id: "p1",
            change_order_state: "Approved",
            urid: "6000.01",
            dept_code: "6000",
            account_code: "5600",
            cost_center_id: null,
            extended_minor: 250,
          },
        ]),
      ],
    });
    const result = await budgetVersusActual(db, { orgId: "o1", dimension: "account" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toEqual([
      expect.objectContaining({
        key: "5500",
        budgetMinor: null,
        pricedRevisedMinor: 1000,
        unpricedCount: 1,
        actualMinor: 400,
        varianceMinor: null,
        budgetLineIds: ["l1", "l2"],
      }),
      expect.objectContaining({
        key: "5600",
        budgetMinor: 1000,
        approvedChangeMinor: 250,
        revisedMinor: 1250,
        pricedRevisedMinor: 1250,
        varianceMinor: 850,
      }),
    ]);
    expect(result.data.totals[0]).toMatchObject({
      budgetMinor: null,
      unpricedCount: 1,
      actualMinor: 800,
    });
  });

  it("sums committed per group, blank when any line is withheld or unpriced", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [
        okResponse([
          fact({ committed_minor: 600, other_currency_po_line_count: 1 }),
          fact({ budget_line_id: "l2", committed_minor: 0 }),
          fact({
            budget_line_id: "l3",
            account_code: "5600",
            committed_minor: null,
            is_committed_withheld: true,
          }),
          fact({ budget_line_id: "l4", account_code: "5700", committed_minor: null }),
        ]),
      ],
      "from:change_order_line_facts": [okResponse([])],
    });
    const result = await budgetVersusActual(db, { orgId: "o1", dimension: "account" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toEqual([
      expect.objectContaining({
        key: "5500",
        committedMinor: 600,
        committedWithheldCount: 0,
        committedOtherCurrencyCount: 1,
      }),
      expect.objectContaining({ key: "5600", committedMinor: null, committedWithheldCount: 1 }),
      expect.objectContaining({ key: "5700", committedMinor: null, committedWithheldCount: 0 }),
    ]);
    expect(result.data.totals[0]).toMatchObject({
      committedMinor: null,
      committedWithheldCount: 1,
      committedOtherCurrencyCount: 1,
    });
  });

  it("totals committed when every line is readable", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [
        okResponse([
          fact({ committed_minor: 600 }),
          fact({ budget_line_id: "l2", account_code: "5600", committed_minor: 150 }),
        ]),
      ],
      "from:change_order_line_facts": [okResponse([])],
    });
    const result = await budgetVersusActual(db, { orgId: "o1", dimension: "account" });
    expect(result.ok && result.data.totals[0]).toMatchObject({
      committedMinor: 750,
      committedWithheldCount: 0,
    });
  });

  it("groups by every dimension, resolving change cost centers", async () => {
    for (const dimension of ["costCenter", "urid", "department", "project"] as const) {
      const { db } = fakeClient({
        "from:projects": [okResponse([project])],
        "from:budget_line_facts": [okResponse([fact({ cost_center_code: null })])],
        "from:change_order_line_facts": [
          okResponse([
            {
              budget_id: "work",
              project_id: "p1",
              change_order_state: "Approved",
              urid: "5000.04.02",
              dept_code: "5000",
              account_code: null,
              cost_center_id: "cc1",
              extended_minor: 5,
            },
          ]),
        ],
        "from:cost_centers": [okResponse([{ id: "cc1", code: "CC-E01" }])],
      });
      const result = await budgetVersusActual(db, { orgId: "o1", dimension, projectId: "p1" });
      expect(result.ok, dimension).toBe(true);
    }
  });

  it("answers an empty report for an org without projects and surfaces read errors", async () => {
    const empty = fakeClient({ "from:projects": [okResponse([])] });
    const result = await budgetVersusActual(empty.db, { orgId: "o1", dimension: "account" });
    expect(result.ok && result.data.rows).toEqual([]);
    const broken = fakeClient({
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [errorResponse("42501", "denied")],
      "from:change_order_line_facts": [okResponse([])],
    });
    expect((await budgetVersusActual(broken.db, { orgId: "o1", dimension: "urid" })).ok).toBe(
      false,
    );
    const noProjects = fakeClient({ "from:projects": [errorResponse("08006", "down")] });
    expect((await budgetVersusActual(noProjects.db, { orgId: "o1", dimension: "urid" })).ok).toBe(
      false,
    );
  });
});

describe("final cost report", () => {
  it("compares the baseline with changes and posted actuals by account", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [
        okResponse([
          fact({
            budget_line_id: "b1",
            budget_id: "base",
            is_baseline: true,
            extended_minor: 10000,
          }),
          fact({
            budget_line_id: "b2",
            budget_id: "base",
            is_baseline: true,
            account_code: "5600",
            extended_minor: null,
          }),
        ]),
      ],
      "from:change_order_line_facts": [
        okResponse([
          {
            budget_id: "base",
            project_id: "p1",
            change_order_state: "Approved",
            urid: "5000.04.02",
            dept_code: "5000",
            account_code: "5500",
            cost_center_id: null,
            extended_minor: 2500,
          },
        ]),
      ],
      "from:posting_lines": [
        okResponse([
          { account_code: "5500", amount_minor: 9000, currency: "USD" },
          { account_code: "2000", amount_minor: -9000, currency: "USD" },
        ]),
      ],
    });
    const result = await finalCostReport(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hasBaseline).toBe(true);
    expect(result.data.rows[0]).toMatchObject({
      accountCode: "5500",
      baselineMinor: 10000,
      revisedMinor: 12500,
      actualMinor: 9000,
      varianceMinor: 3500,
    });
    expect(result.data.rows[1]).toMatchObject({
      accountCode: "5600",
      baselineMinor: null,
      pricedRevisedMinor: null,
      varianceMinor: null,
    });
    expect(result.data.totals[0]).toMatchObject({
      baselineMinor: null,
      pricedRevisedMinor: 12500,
      baselineUnpricedCount: 1,
      actualMinor: 9000,
    });
  });

  it("answers not-found for a hidden project and reports a missing baseline", async () => {
    const hidden = fakeClient({ "from:projects": [okResponse([])] });
    expect(await finalCostReport(hidden.db, { orgId: "o1", projectId: "zz" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const none = fakeClient({
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [okResponse([])],
      "from:change_order_line_facts": [okResponse([])],
      "from:posting_lines": [okResponse([])],
    });
    const result = await finalCostReport(none.db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data.hasBaseline).toBe(false);
  });
});

describe("gate readiness", () => {
  it("finds the next gate and its unmet blocking criteria", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse([project])],
      "from:gate_criteria_status": [
        okResponse([
          {
            project_id: "p1",
            gate: 1,
            criterion_id: "G1-01",
            is_blocking: true,
            evidence_count: 1,
            gate_passed: true,
          },
          {
            project_id: "p1",
            gate: 2,
            criterion_id: "G2-02",
            is_blocking: true,
            evidence_count: 0,
            gate_passed: false,
          },
          {
            project_id: "p1",
            gate: 2,
            criterion_id: "G2-01",
            is_blocking: true,
            evidence_count: 2,
            gate_passed: false,
          },
          {
            project_id: "p1",
            gate: 2,
            criterion_id: "G2-03",
            is_blocking: false,
            evidence_count: 1,
            gate_passed: false,
          },
        ]),
      ],
    });
    const result = await gateReadiness(db, { orgId: "o1" });
    expect(result.ok && result.data[0]).toMatchObject({
      nextGate: 2,
      blockingTotal: 2,
      blockingMet: 1,
      otherMet: 1,
      ready: false,
      unmetBlocking: ["G2-02"],
    });
    const empty = fakeClient({ "from:projects": [okResponse([])] });
    expect(await gateReadiness(empty.db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
  });
});

describe("coordinate matrix", () => {
  const canon = () => ({
    "from:xpms.dim_department": [okResponse([{ dept_code: "5000", department: "Production" }])],
    "from:xpms.dim_phase": [
      okResponse([
        { phase_code: "SCP", gate: 1, phase: "Scope" },
        { phase_code: "DIS", gate: null, phase: "Discover" },
      ]),
    ],
  });

  it("counts records by department class and phase", async () => {
    const { db } = fakeClient({
      ...canon(),
      "from:records": [
        okResponse([
          { urid: "5000.04.02", phase_code: "SCP" },
          { urid: "5000.01", phase_code: "SCP" },
        ]),
      ],
    });
    const result = await coordinateMatrix(db, { orgId: "o1", projectId: "p1", source: "records" });
    expect(result.ok && result.data.cells).toEqual({ "5000|SCP": 2 });
    expect(result.ok && result.data.phases).toHaveLength(1);
  });

  it("places the scope's catalog elements by their phases", async () => {
    const { db, calls } = fakeClient({
      ...canon(),
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [
        okResponse([fact({ element_id: "E1" }), fact({ budget_line_id: "l2", element_id: null })]),
      ],
      "from:xpms.bridge_element_phase": [
        okResponse([{ phase_code: "SCP", element: { urid: "5000.04.02" } }]),
      ],
    });
    const result = await coordinateMatrix(db, { orgId: "o1" });
    expect(result.ok && result.data.total).toBe(1);
    expect(calls.find((c) => c.target === "from:xpms.bridge_element_phase")?.steps).toContainEqual([
      "in",
      ["element_id", ["E1"]],
    ]);
  });

  it("covers the whole catalog, and an empty scope stays empty", async () => {
    const whole = fakeClient({
      ...canon(),
      "from:xpms.bridge_element_phase": [
        okResponse([{ phase_code: "SCP", element: [{ urid: "5000.01.01" }] }]),
      ],
    });
    const all = await coordinateMatrix(whole.db, { orgId: "o1", source: "catalog" });
    expect(all.ok && all.data.cells).toEqual({ "5000|SCP": 1 });
    const empty = fakeClient({ ...canon(), "from:projects": [okResponse([])] });
    const none = await coordinateMatrix(empty.db, { orgId: "o1", source: "scope" });
    expect(none.ok && none.data.total).toBe(0);
  });
});

describe("labor", () => {
  it("reports labor budget, worked time and masked payroll", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse([project])],
      "from:budget_line_facts": [okResponse([fact({ line_type: "Labor", extended_minor: 5000 })])],
      "from:timesheet_hours": [
        okResponse([
          { timesheet_id: "t1", project_id: "p1", worked_minutes: 480, has_open_entry: false },
          { timesheet_id: "t2", project_id: "p1", worked_minutes: 120, has_open_entry: true },
        ]),
      ],
      "from:payroll_line_amounts": [
        okResponse([
          { payroll_run_id: "r1", hours: 8, amount_minor: null, is_masked: true },
          { payroll_run_id: "r2", hours: 4, amount_minor: 1000, is_masked: false },
        ]),
      ],
      "from:payroll_runs": [okResponse([{ id: "r2", currency_code: "USD" }])],
    });
    const result = await laborReport(db, { orgId: "o1" });
    expect(result.ok && result.data.projects[0]).toMatchObject({
      budgetMinor: 5000,
      workedMinutes: 600,
      openEntryCount: 1,
    });
    expect(result.ok && result.data.payrollRuns).toEqual([
      {
        payrollRunId: "r1",
        currency: null,
        hours: 8,
        amountMinor: null,
        isMasked: true,
        lineCount: 1,
      },
      {
        payrollRunId: "r2",
        currency: "USD",
        hours: 4,
        amountMinor: 1000,
        isMasked: false,
        lineCount: 1,
      },
    ]);
  });

  it("skips payroll for one project and handles an org without projects", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse([project]), okResponse([])],
      "from:budget_line_facts": [okResponse([])],
      "from:timesheet_hours": [okResponse([])],
      "from:payroll_line_amounts": [okResponse([])],
    });
    const one = await laborReport(db, { orgId: "o1", projectId: "p1" });
    expect(one.ok && one.data.projects[0]?.budgetMinor).toBeNull();
    const none = await laborReport(db, { orgId: "o1" });
    expect(none.ok && none.data.projects).toEqual([]);
  });
});

describe("purchase order exposure", () => {
  it("derives committed, received and exposure, keeping unpriced commitments blank", async () => {
    const { db } = fakeClient({
      "from:purchase_orders": [
        okResponse([
          {
            id: "po1",
            po_number: 7,
            project_id: "p1",
            po_state: "Sent",
            currency_code: "USD",
            project: { project_key: "NWL" },
            vendor: { counterparty: { counterparty_name: "Pier Rigging" } },
          },
          {
            id: "po2",
            po_number: 8,
            project_id: "p1",
            po_state: "Proposed",
            currency_code: "USD",
            project: null,
            vendor: null,
          },
        ]),
        okResponse([]),
      ],
      "from:purchase_order_totals": [
        okResponse([
          {
            purchase_order_id: "po1",
            unpriced_count: 0,
            lines_total_minor: 10000,
            approved_changes_minor: 500,
          },
          {
            purchase_order_id: "po2",
            unpriced_count: 1,
            lines_total_minor: null,
            approved_changes_minor: null,
          },
        ]),
      ],
      "from:receipt_lines": [
        okResponse([
          { quantity_received: 2, po_line: { purchase_order_id: "po1", unit_price_minor: 1000 } },
        ]),
      ],
    });
    const result = await purchaseOrderExposure(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data[0]).toMatchObject({
      vendorName: "Pier Rigging",
      committedMinor: 10500,
      receivedMinor: 2000,
      exposureMinor: 8500,
    });
    expect(result.ok && result.data[1]).toMatchObject({
      committedMinor: null,
      receivedMinor: 0,
      exposureMinor: null,
    });
    expect(await purchaseOrderExposure(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
  });
});

describe("incidents", () => {
  it("counts by canon severity and state", async () => {
    const { db } = fakeClient({
      "from:incidents": [
        okResponse([
          { id: "i1", severity_enum_id: "ENM-098", incident_state: "Closed" },
          { id: "i2", severity_enum_id: "ENM-097", incident_state: "Reported" },
          { id: "i3", severity_enum_id: null, incident_state: "Reported" },
        ]),
      ],
      "from:xpms.std_enumeration": [
        okResponse([
          { record_id: "ENM-097", enum_label: "Level 1 - Critical" },
          { record_id: "ENM-098", enum_label: "Level 2 - Major" },
        ]),
      ],
    });
    const result = await incidentsReport(db, {
      orgId: "o1",
      projectId: "p1",
      from: "2027-01-01",
      to: "2027-12-31",
    });
    expect(result.ok && result.data.rows.map((r) => r.severityId)).toEqual([
      "ENM-097",
      "ENM-098",
      null,
    ]);
    expect(result.ok && result.data.open).toBe(2);
  });
});

describe("saved reports", () => {
  it("marks the viewer's own definitions", async () => {
    const { db } = fakeClient({
      "from:report_definitions": [
        okResponse([
          {
            id: "r1",
            name: "Spend",
            source_code: "finance",
            chart: "Bar",
            shared: true,
            membership_id: "m1",
            updated_at: "x",
          },
        ]),
        errorResponse("08006", "down"),
      ],
    });
    const result = await listSavedReports(db, { orgId: "o1", membershipId: "m1" });
    expect(result.ok && result.data[0]?.mine).toBe(true);
    expect((await listSavedReports(db, { orgId: "o1", membershipId: "m1" })).ok).toBe(false);
  });
});

describe("shared reports", () => {
  it("lists runs to share and shares, keeping revoked shares as evidence", async () => {
    const { db, calls } = fakeClient({
      "from:report_runs": [
        okResponse([
          {
            id: "run1",
            export_format: "PDF",
            finished_at: "x",
            row_count: 3,
            definition: { name: "Spend" },
          },
        ]),
        errorResponse("08006", "down"),
      ],
      "from:shared_reports": [
        okResponse([
          {
            id: "sh1",
            engagement_id: "e1",
            project_id: "p1",
            report_run_id: "run1",
            title: "Spend",
            expires_at: null,
            revoked_at: "y",
            created_at: "x",
          },
        ]),
        errorResponse("08006", "down"),
      ],
      "rpc:share_report": [
        okResponse("sh2"),
        errorResponse("XR001", "report_run_unfinished: wait.", "report_run_unfinished"),
      ],
      "rpc:revoke_shared_report": [
        okResponse("sh1"),
        errorResponse("XR001", "share_already_revoked: no.", "share_already_revoked"),
      ],
    });
    const runs = await listMyRuns(db, { orgId: "o1", membershipId: "m1" });
    expect(runs.ok && runs.data[0]?.reportName).toBe("Spend");
    expect((await listMyRuns(db, { orgId: "o1", membershipId: "m1" })).ok).toBe(false);
    const shares = await listSharedReports(db, { orgId: "o1", projectId: "p1" });
    expect(shares.ok && shares.data[0]?.revokedAt).toBe("y");
    expect(calls[2]?.steps).toContainEqual(["eq", ["project_id", "p1"]]);
    expect((await listSharedReports(db, { orgId: "o1" })).ok).toBe(false);
    const input = { reportRunId: "run1", engagementId: "e1", title: " Spend ", expiresAt: null };
    expect(await shareReport(db, input)).toEqual({ ok: true, data: { id: "sh2" } });
    const unfinished = await shareReport(db, input);
    expect(unfinished.ok === false && unfinished.error.kind).toBe("refusal");
    expect((await revokeSharedReport(db, "sh1")).ok).toBe(true);
    expect((await revokeSharedReport(db, "sh1")).ok).toBe(false);
  });
});

describe("report runs", () => {
  it("queues a run or returns the error", async () => {
    const { db } = fakeClient({
      "rpc:run_report": [okResponse("run9"), errorResponse("42501", "report not found")],
    });
    expect(await runReport(db, { reportDefinitionId: "r1", format: "PDF" })).toEqual({
      ok: true,
      data: { id: "run9" },
    });
    expect(await runReport(db, { reportDefinitionId: "r1", format: "CSV" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});
