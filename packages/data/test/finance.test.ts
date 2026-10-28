import { describe, expect, it } from "vitest";
import * as finance from "../src/finance.ts";
import {
  accountForUrid,
  convertMinor,
  extendedMinor,
  findFxRate,
  nullAwareSum,
  parseMoney,
  parseUplMappings,
  projectUpl,
  toCsv,
  toMajor,
  toUplRow,
  xyzFor,
  type BudgetLineInput,
  type PostingLine,
} from "../src/finance.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const refusal = (rule: string, sentence: string) =>
  errorResponse("XR001", `${rule}: ${sentence}`, rule);

describe("money helpers", () => {
  it("keeps blanks blank in sums and counts them", () => {
    expect(nullAwareSum([100, null, 50])).toEqual({ total: null, priced: 150, unpricedCount: 1 });
    expect(nullAwareSum([100, 50])).toEqual({ total: 150, priced: 150, unpricedCount: 0 });
    expect(nullAwareSum([])).toEqual({ total: null, priced: null, unpricedCount: 0 });
    expect(nullAwareSum([null])).toEqual({ total: null, priced: null, unpricedCount: 1 });
  });

  it("extends quantity by price, rounding half away from zero, and never prices a blank", () => {
    expect(extendedMinor(2.5, 3)).toBe(8);
    expect(extendedMinor(-2.5, 3)).toBe(-8);
    expect(extendedMinor(3, null)).toBeNull();
  });

  it("converts between currencies with their exponents and leaves unpriced amounts blank", () => {
    expect(convertMinor(10000, 0.92, 2, 2)).toBe(9200);
    expect(convertMinor(10000, 150, 2, 0)).toBe(15000);
    expect(convertMinor(null, 0.92, 2, 2)).toBeNull();
    expect(toMajor(12345, 2)).toBe(123.45);
    expect(toMajor(null, 2)).toBeNull();
  });

  it("parses typed amounts to minor units", () => {
    expect(parseMoney("1,234.5", 2)).toBe(123450);
    expect(parseMoney("$12", 2)).toBe(1200);
    expect(parseMoney("-3.25", 2)).toBe(-325);
    expect(parseMoney("  ", 2)).toBeNull();
    expect(parseMoney("1.234", 2)).toBe("invalid");
    expect(parseMoney("abc", 2)).toBe("invalid");
    expect(parseMoney("7", 0)).toBe(7);
  });

  it("finds the latest rate on or before a day, inverting the opposite pair", () => {
    const rates = [
      { id: "1", base: "USD", quote: "EUR", rate: 0.9, effectiveOn: "2027-01-01", source: "Bank" },
      { id: "2", base: "USD", quote: "EUR", rate: 0.92, effectiveOn: "2027-02-01", source: "Bank" },
      { id: "3", base: "GBP", quote: "USD", rate: 1.25, effectiveOn: "2027-01-15", source: "Feed" },
    ];
    expect(findFxRate(rates, "USD", "EUR", "2027-01-20")?.rate).toBe(0.9);
    expect(findFxRate(rates, "USD", "EUR", "2027-03-01")?.effectiveOn).toBe("2027-02-01");
    expect(findFxRate(rates, "USD", "GBP", "2027-02-01")?.rate).toBeCloseTo(0.8);
    expect(findFxRate(rates, "USD", "JPY", "2027-02-01")).toBeNull();
    expect(findFxRate(rates, "USD", "USD", "2027-02-01")?.rate).toBe(1);
    expect(findFxRate(rates, "USD", "EUR", "2026-12-31")).toBeNull();
  });

  it("converts through EUR with ECB reference rates, dating a cross rate by its older leg (ADR 0053)", () => {
    const ecb = [
      { id: "a", base: "EUR", quote: "USD", rate: 1.08, effectiveOn: "2027-03-05", source: "ECB" },
      { id: "b", base: "EUR", quote: "GBP", rate: 0.84, effectiveOn: "2027-03-04", source: "ECB" },
      { id: "c", base: "EUR", quote: "GBP", rate: 0.85, effectiveOn: "2027-03-08", source: "ECB" },
    ];
    const cross = findFxRate(ecb, "USD", "GBP", "2027-03-06");
    expect(cross?.rate).toBeCloseTo(0.84 / 1.08, 10);
    expect(cross).toMatchObject({ effectiveOn: "2027-03-04", source: "ECB", via: "EUR" });
    // A direct pair as recent as the cross rate wins; an older one loses to it.
    const own = {
      id: "d",
      base: "USD",
      quote: "GBP",
      rate: 0.8,
      effectiveOn: "2027-03-04",
      source: "Bank",
    };
    expect(findFxRate([...ecb, own], "USD", "GBP", "2027-03-06")).toMatchObject({ rate: 0.8 });
    const older = { ...own, effectiveOn: "2027-02-01" };
    expect(findFxRate([...ecb, older], "USD", "GBP", "2027-03-06")?.via).toBe("EUR");
    // EUR itself never goes through EUR, and a missing leg means no rate.
    expect(findFxRate(ecb, "EUR", "USD", "2027-03-06")?.via).toBeUndefined();
    expect(findFxRate(ecb, "USD", "JPY", "2027-03-06")).toBeNull();
  });

  it("says how old a rate is on its business date and when it is stale", () => {
    expect(finance.fxRateAgeDays("2027-04-01", "2027-04-06")).toBe(5);
    expect(finance.isFxRateStale("2027-04-01", "2027-04-06")).toBe(false);
    expect(finance.isFxRateStale("2027-04-01", "2027-04-07")).toBe(true);
    expect(finance.fxRateAgeDays("2027-02-28", "2027-03-01")).toBe(1);
  });

  it("lists the latest rate of each pair, newest first", () => {
    const rows = [
      { id: "1", base: "EUR", quote: "USD", rate: 1.07, effectiveOn: "2027-03-04", source: "ECB" },
      { id: "2", base: "EUR", quote: "USD", rate: 1.08, effectiveOn: "2027-03-05", source: "ECB" },
      { id: "3", base: "USD", quote: "EUR", rate: 0.9, effectiveOn: "2027-01-01", source: "Bank" },
    ];
    expect(finance.latestFxRates(rows).map((r) => r.id)).toEqual(["2", "3"]);
  });

  it("reads the ECB feed's state", async () => {
    const { db } = fakeClient({
      "rpc:fx_feed_status": [
        okResponse([
          {
            last_success_at: "2027-03-05T15:31:00Z",
            last_rate_date: "2027-03-05",
            last_failure_at: null,
            last_error: null,
            failures_since_success: 0,
          },
        ]),
      ],
    });
    const status = await finance.getFxFeedStatus(db);
    expect(status).toEqual({
      ok: true,
      data: {
        lastSuccessAt: "2027-03-05T15:31:00Z",
        lastRateDate: "2027-03-05",
        lastFailureAt: null,
        lastError: null,
        failuresSinceSuccess: 0,
      },
    });
    const broken = fakeClient({
      "rpc:fx_feed_status": [errorResponse("42501", "permission denied")],
    });
    const failed = await finance.getFxFeedStatus(broken.db);
    expect(failed.ok).toBe(false);
  });
});

describe("canon helpers", () => {
  const options = [
    { urid: "5000.01", name: "Audio", xyz: null },
    { urid: "5000.01.01", name: "Speakers", xyz: "X" as const },
  ];

  it("takes a category's own tag and declares the rest", () => {
    expect(xyzFor("5000.01.01", options, null)).toEqual({ xyz: "X", xyzBasis: "Category" });
    expect(xyzFor("5000.01.01", options, "X")).toEqual({ xyz: "X", xyzBasis: "Category" });
    expect(xyzFor("5000.01.01", options, "Y")).toEqual({ xyz: "Y", xyzBasis: "Declared" });
    expect(xyzFor("5000.01", options, "Z")).toEqual({ xyz: "Z", xyzBasis: "Declared" });
    expect(xyzFor("5000.01", options, null)).toBeNull();
  });

  it("resolves a URID to its class account", () => {
    const accounts = [
      {
        code: "5500",
        name: "Expense",
        type: "Expense",
        classCode: "5000",
        taxType: "",
        description: null,
      },
      {
        code: "4000",
        name: "Revenue",
        type: "Revenue",
        classCode: "0000",
        taxType: "",
        description: null,
      },
    ];
    expect(accountForUrid("5000.04.02", accounts)?.code).toBe("5500");
    expect(accountForUrid("0000.01", accounts, "Revenue")?.code).toBe("4000");
    expect(accountForUrid("9000.01", accounts)).toBeNull();
  });
});

describe("universal posting line", () => {
  const line: PostingLine = {
    id: "l1",
    projectId: "p1",
    date: "2027-06-10",
    accountCode: "5500",
    costCenterCode: "CC-VENUE",
    urid: "5000.04.02",
    vendorId: null,
    itemId: null,
    description: 'Deck "A", rental',
    quantity: null,
    unitBasis: null,
    amountMinor: -40050,
    taxType: "Tax on Purchases",
    currency: "USD",
    externalRef: "e1",
    lineState: "Complete",
  };

  it("parses the canon mapping rules into column renames", () => {
    const mappings = parseUplMappings([
      { field: "date", rule: "ISO 8601 date" },
      { field: "xero", rule: "account_code → AccountCode; urid → TrackingCategory2; bogus → X" },
    ]);
    expect(mappings).toEqual([
      {
        target: "xero",
        columns: { account_code: "AccountCode", urid: "TrackingCategory2" },
        rule: "account_code → AccountCode; urid → TrackingCategory2; bogus → X",
      },
    ]);
  });

  it("projects rows in UPL order and writes RFC 4180 CSV", () => {
    const row = toUplRow(line, 2);
    expect(row.amount).toBe("-400.50");
    expect(row.vendor_id).toBe("");
    const plain = projectUpl([row], null);
    expect(plain.header[0]).toBe("date");
    const xero = projectUpl([row], {
      target: "xero",
      columns: { account_code: "AccountCode" },
      rule: "",
    });
    expect(xero.header[1]).toBe("AccountCode");
    const csv = toCsv(xero.header, xero.body);
    expect(csv).toContain('"Deck ""A"", rental"');
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(toUplRow({ ...line, quantity: 2, amountMinor: 5 }, 0).quantity).toBe("2");
  });

  it("lists posting lines and the canon mappings", async () => {
    const { db, calls } = fakeClient({
      "from:posting_lines": [
        okResponse([
          {
            posting_line_id: "l1",
            project_id: null,
            date: "2027-06-10",
            account_code: "5500",
            cost_center_id: null,
            urid: null,
            vendor_id: null,
            item_id: null,
            description: "d",
            quantity: 1,
            unit_basis: null,
            amount_minor: 100,
            tax_type: "None",
            currency: "USD",
            external_ref: "x",
            line_state: "Complete",
          },
        ]),
      ],
      "from:xpms.dim_upl_field": [okResponse([{ field: "ramp", rule: "urid → Class" }])],
    });
    const lines = await finance.listPostingLines(db, {
      orgId: "o1",
      from: "2027-06-01",
      to: "2027-06-30",
      projectId: "p1",
    });
    expect(lines.ok && lines.data[0]?.quantity).toBe(1);
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p1"]]);
    const mappings = await finance.listUplMappings(db);
    expect(mappings.ok && mappings.data[0]?.columns.urid).toBe("Class");
  });
});

describe("reference reads", () => {
  it("lists projects and finds one by key", async () => {
    const row = {
      id: "p1",
      project_key: "NWL",
      name: "Summer",
      production_state: "Active",
      currency: "USD",
    };
    const { db } = fakeClient({
      "from:projects": [okResponse([row]), okResponse(row), okResponse(null)],
    });
    expect((await finance.listProjects(db, "o1")).ok).toBe(true);
    expect(await finance.getProjectByKey(db, "o1", "NWL")).toEqual({
      ok: true,
      data: { id: "p1", key: "NWL", name: "Summer", productionState: "Active", currency: "USD" },
    });
    expect(await finance.getProjectByKey(db, "o1", "ZZZ")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("lists counterparties by name and survives a hidden organization", async () => {
    const { db } = fakeClient({
      "from:counterparties": [
        okResponse([
          { id: "c2", counterparty_type: "Vendor", counterparty_name: "Pier Rigging" },
          { id: "c1", counterparty_type: null, counterparty_name: null },
        ]),
      ],
    });
    const result = await finance.listCounterparties(db, "o1");
    expect(result.ok && result.data.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("merges disciplines and categories in numeric order", async () => {
    const { db } = fakeClient({
      "from:xpms.dim_discipline": [okResponse([{ disc_code: "5000.10", discipline: "Ten" }])],
      "from:xpms.dim_category": [
        okResponse([
          { cat_urid: "5000.02.01", category: "Two", xyz: "Y" },
          { cat_urid: "5000.10.01", category: "Ten one", xyz: null },
        ]),
      ],
    });
    const result = await finance.listUridOptions(db);
    expect(result.ok && result.data.map((o) => o.urid)).toEqual([
      "5000.02.01",
      "5000.10",
      "5000.10.01",
    ]);
  });

  it("surfaces a failed canon read", async () => {
    const { db } = fakeClient({
      "from:xpms.dim_discipline": [errorResponse("08006", "down")],
      "from:xpms.dim_category": [okResponse([])],
    });
    expect((await finance.listUridOptions(db)).ok).toBe(false);
    const second = fakeClient({
      "from:xpms.dim_discipline": [okResponse([])],
      "from:xpms.dim_category": [errorResponse("08006", "down")],
    });
    expect((await finance.listUridOptions(second.db)).ok).toBe(false);
  });

  it("reads the chart, order types, grades, scope nodes, currencies and rates", async () => {
    const { db } = fakeClient({
      "from:xpms.dim_gl_account": [
        okResponse([
          {
            account_code: "5500",
            account_name: "Expense · Production",
            account_type: "Expense",
            class_code: "5000",
            tax_type: "Tax on Purchases",
            description: null,
          },
        ]),
      ],
      "from:xpms.std_enumeration": [
        okResponse([{ record_id: "ENM-092", enum_code: "ORD", enum_label: "Scope Expansion" }]),
      ],
      "from:xpms.grade": [okResponse([{ code: "base", label: "Base" }])],
      "from:scope_nodes": [
        okResponse([{ id: "s1", project_id: "p1", scope_code: "NWL", name: "Root" }]),
      ],
      "from:currencies": [okResponse([{ currency_code: "USD", minor_unit_exponent: 2 }])],
      "from:fx_rates": [
        okResponse([
          {
            id: "f1",
            base_currency: "USD",
            quote_currency: "EUR",
            rate: "0.92",
            effective_on: "2027-01-01",
            source: "Bank",
          },
        ]),
        okResponse(null),
      ],
    });
    expect((await finance.listGlAccounts(db)).ok).toBe(true);
    expect((await finance.listOrderTypes(db)).ok).toBe(true);
    expect((await finance.listGrades(db)).ok).toBe(true);
    expect((await finance.listScopeNodes(db, "o1")).ok).toBe(true);
    const currencies = await finance.listCurrencies(db);
    expect(currencies.ok && currencies.data[0]).toEqual({ code: "USD", exponent: 2 });
    const rates = await finance.listFxRates(db, "o1");
    expect(rates.ok && rates.data[0]?.rate).toBe(0.92);
    expect(
      (
        await finance.createFxRate(db, {
          orgId: "o1",
          base: "USD",
          quote: "EUR",
          rate: 0.9,
          effectiveOn: "2027-02-01",
          source: " Bank ",
        })
      ).ok,
    ).toBe(true);
  });

  it("prices catalog elements per grade and leaves missing grades unpriced", async () => {
    const { db, calls } = fakeClient({
      "from:xpms.elements": [
        okResponse([
          {
            element_id: "E1",
            urid: "5000.04.02",
            item: "Ramp",
            common_name: null,
            unit_basis: "each",
            xyz: "X",
          },
        ]),
        okResponse([]),
      ],
      "from:xpms.element_price_bands": [
        okResponse([
          {
            element_id: "E1",
            grade_code: "base",
            amount_minor: 1000,
            currency_code: "USD",
            valid_from: null,
            valid_to: null,
          },
          {
            element_id: "E1",
            grade_code: "premium",
            amount_minor: 5000,
            currency_code: "USD",
            valid_from: "2030-01-01",
            valid_to: null,
          },
        ]),
      ],
    });
    const result = await finance.searchCatalogElements(db, { search: "ramp", on: "2027-01-01" });
    expect(result.ok && result.data[0]?.prices).toEqual({ base: 1000 });
    expect(result.ok && result.data[0]?.name).toBe("Ramp");
    expect(calls[0]?.steps.some(([m]) => m === "or")).toBe(true);
    const empty = await finance.searchCatalogElements(db, { search: "" });
    expect(empty).toEqual({ ok: true, data: [] });
  });
});

describe("cost centers", () => {
  it("lists in code order and writes uppercase codes", async () => {
    const { db, calls } = fakeClient({
      "from:cost_centers": [
        okResponse([
          {
            id: "2",
            code: "CC-E10",
            name: "Ten",
            kind: "Event",
            scope_node_id: "s",
            template_id: null,
          },
          {
            id: "1",
            code: "CC-E2",
            name: "Two",
            kind: "Event",
            scope_node_id: "s",
            template_id: null,
          },
        ]),
        okResponse({ id: "3" }),
        okResponse(null),
        okResponse(null),
      ],
    });
    const list = await finance.listCostCenters(db, "o1");
    expect(list.ok && list.data.map((c) => c.code)).toEqual(["CC-E2", "CC-E10"]);
    const input = {
      code: " cc-venue ",
      name: " Venue ",
      kind: "Standing" as const,
      scopeNodeId: "s1",
    };
    expect(await finance.createCostCenter(db, "o1", input)).toEqual({
      ok: true,
      data: { id: "3" },
    });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { org_id: "o1", code: "CC-VENUE", name: "Venue", kind: "Standing", scope_node_id: null },
    ]);
    expect((await finance.updateCostCenter(db, "3", { ...input, kind: "Event" })).ok).toBe(true);
    expect((await finance.deleteCostCenter(db, "3")).ok).toBe(true);
  });
});

describe("budgets", () => {
  const budgetRow = {
    id: "b1",
    project_id: "p1",
    name: "Gate 3 Budget",
    currency_code: "USD",
    is_baseline: true,
    updated_at: "2027-01-01T00:00:00Z",
    project: { project_key: "NWL", name: "Summer" },
  };
  const totalRow = {
    budget_id: "b1",
    line_count: 2,
    unpriced_count: 1,
    priced_total_minor: 500,
    total_minor: null,
    approved_change_count: 0,
    approved_change_minor: 0,
    revised_total_minor: null,
    actual_minor: 0,
  };
  const lineRow = {
    id: "l1",
    budget_id: "b1",
    line_number: 1,
    description: "Sound",
    line_type: "Cost",
    urid: "5000.01",
    cost_center_id: null,
    grade_code: null,
    element_id: null,
    quantity: 1,
    unit_basis: null,
    unit_price_minor: null,
    xyz: "X",
    xyz_basis: "Declared",
    updated_at: "2027-01-01T00:00:00Z",
  };
  const input: BudgetLineInput = {
    description: " Sound ",
    lineType: "Cost",
    urid: "5000.01",
    costCenterId: null,
    gradeCode: null,
    elementId: null,
    quantity: 1,
    unitBasis: null,
    unitPriceMinor: null,
    xyz: "X",
    xyzBasis: "Declared",
  };

  it("lists budgets with revised NULL-aware totals", async () => {
    const { db } = fakeClient({
      "from:budgets": [okResponse([budgetRow]), okResponse([])],
      "from:budget_revised_totals": [okResponse([totalRow])],
    });
    const result = await finance.listBudgets(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data[0]).toMatchObject({
      projectKey: "NWL",
      totalMinor: null,
      unpricedCount: 1,
      pricedTotalMinor: 500,
    });
    expect(await finance.listBudgets(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
  });

  it("reads one budget with its lines and keeps unpriced lines blank", async () => {
    const { db } = fakeClient({
      "from:budgets": [okResponse({ id: "b1", project_id: "p1" }), okResponse([budgetRow])],
      "from:budget_revised_totals": [okResponse([totalRow])],
      "from:budget_lines": [okResponse([lineRow])],
      "from:budget_line_amounts": [
        okResponse([
          { budget_line_id: "l1", extended_minor: null, account_code: "5500", actual_minor: 0 },
        ]),
      ],
      "from:budget_line_commitments": [okResponse([])],
    });
    const result = await finance.getBudget(db, "o1", "b1");
    expect(result.ok && result.data.lines[0]).toMatchObject({
      extendedMinor: null,
      accountCode: "5500",
    });
  });

  it("reads each line's committed amount, or that it is withheld", async () => {
    const { db } = fakeClient({
      "from:budgets": [okResponse({ id: "b1", project_id: "p1" }), okResponse([budgetRow])],
      "from:budget_revised_totals": [okResponse([totalRow])],
      "from:budget_lines": [okResponse([lineRow, { ...lineRow, id: "l2", line_number: 2 }])],
      "from:budget_line_amounts": [okResponse([])],
      "from:budget_line_commitments": [
        okResponse([
          {
            budget_line_id: "l1",
            committed_minor: 53000,
            po_line_count: 3,
            other_currency_po_line_count: 1,
            is_committed_withheld: false,
          },
          {
            budget_line_id: "l2",
            committed_minor: null,
            po_line_count: 0,
            other_currency_po_line_count: 0,
            is_committed_withheld: true,
          },
        ]),
      ],
    });
    const result = await finance.getBudget(db, "o1", "b1");
    expect(result.ok && result.data.lines).toEqual([
      expect.objectContaining({
        id: "l1",
        committedMinor: 53000,
        poLineCount: 3,
        otherCurrencyPoLineCount: 1,
        committedWithheld: false,
      }),
      expect.objectContaining({ id: "l2", committedMinor: null, committedWithheld: true }),
    ]);
  });

  it("merges a saved line onto the line it replaces, keeping the derived amounts", () => {
    const previous: finance.BudgetLine = {
      id: "l1",
      budgetId: "b1",
      lineNumber: 1,
      description: "Sound",
      lineType: "Cost",
      urid: "5000.01",
      costCenterId: null,
      gradeCode: null,
      elementId: null,
      quantity: 1,
      unitBasis: null,
      unitPriceMinor: 1000,
      xyz: "X",
      xyzBasis: "Declared",
      extendedMinor: 1000,
      accountCode: "5500",
      actualMinor: 400,
      drawnInMinor: 0,
      drawnOutMinor: 0,
      committedMinor: 900,
      committedWithheld: false,
      poLineCount: 1,
      otherCurrencyPoLineCount: 0,
      updatedAt: "2027-01-01T00:00:00Z",
    };
    const saved = {
      ...previous,
      description: "Sound package",
      quantity: 2,
      accountCode: null,
      actualMinor: 0,
      committedMinor: null,
      poLineCount: 0,
      extendedMinor: null,
      updatedAt: "2027-01-02T00:00:00Z",
    };
    expect(finance.mergeSavedLine(previous, saved)).toEqual({
      ...previous,
      description: "Sound package",
      quantity: 2,
      extendedMinor: 2000,
      updatedAt: "2027-01-02T00:00:00Z",
    });
  });

  it("totals committed by the silence rule", () => {
    const line = (committedMinor: number | null, over: Partial<finance.BudgetLine> = {}) =>
      ({
        committedMinor,
        committedWithheld: false,
        poLineCount: committedMinor ? 1 : 0,
        otherCurrencyPoLineCount: 0,
        ...over,
      }) as finance.BudgetLine;
    expect(finance.budgetCommittedTotal([])).toEqual({
      totalMinor: 0,
      committedLineCount: 0,
      otherCurrencyLineCount: 0,
    });
    expect(
      finance.budgetCommittedTotal([line(500), line(0, { otherCurrencyPoLineCount: 2 }), line(250)]),
    ).toEqual({ totalMinor: 750, committedLineCount: 2, otherCurrencyLineCount: 2 });
    expect(
      finance.budgetCommittedTotal([line(500), line(null, { committedWithheld: true })]),
    ).toBeNull();
    expect(finance.budgetCommittedTotal([line(500), line(null)])).toBeNull();
  });

  it("answers not-found for a missing budget", async () => {
    const { db } = fakeClient({ "from:budgets": [okResponse(null)] });
    expect(await finance.getBudget(db, "o1", "zz")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("creates, edits and deletes budgets", async () => {
    const { db } = fakeClient({
      "from:budgets": [
        okResponse({ id: "b2" }),
        errorResponse("23505", "dup"),
        okResponse(null),
        okResponse(null),
      ],
    });
    const budget = { projectId: "p1", name: " B ", currency: "USD", isBaseline: false };
    expect(await finance.createBudget(db, "o1", budget)).toEqual({ ok: true, data: { id: "b2" } });
    expect(await finance.createBudget(db, "o1", { ...budget, isBaseline: true })).toEqual({
      ok: false,
      error: { kind: "conflict", message: "dup" },
    });
    expect((await finance.updateBudget(db, "b2", { name: "C", isBaseline: false })).ok).toBe(true);
    expect((await finance.deleteBudget(db, "b2")).ok).toBe(true);
  });

  it("numbers appended lines after the last one", async () => {
    const { db, calls } = fakeClient({
      "from:budget_lines": [
        okResponse([{ line_number: 4 }]),
        okResponse([{ id: "n1" }, { id: "n2" }]),
      ],
    });
    const result = await finance.addBudgetLines(db, "o1", "b1", [input, input]);
    expect(result).toEqual({ ok: true, data: { ids: ["n1", "n2"] } });
    const rowsInserted = calls[1]?.steps[0]?.[1]?.[0] as {
      line_number: number;
      unit_price_minor: null;
    }[];
    expect(rowsInserted.map((r) => r.line_number)).toEqual([5, 6]);
    expect(rowsInserted[0]?.unit_price_minor).toBeNull();
    expect(await finance.addBudgetLines(db, "o1", "b1", [])).toEqual({
      ok: true,
      data: { ids: [] },
    });
  });

  it("saves a line only at the version it was read, and reports the conflict otherwise", async () => {
    const { db } = fakeClient({
      "from:budget_lines": [
        okResponse([lineRow]),
        okResponse([]),
        okResponse({ ...lineRow, unit_price_minor: 900, updated_at: "2027-01-02T00:00:00Z" }),
        errorResponse("XR001", "budget_line_xyz_basis: wrong", "budget_line_xyz_basis"),
      ],
    });
    const saved = await finance.updateBudgetLine(db, "l1", "2027-01-01T00:00:00Z", input);
    expect(saved.ok).toBe(true);
    const conflict = await finance.updateBudgetLine(db, "l1", "2027-01-01T00:00:00Z", input);
    expect(conflict.ok === false && conflict.error.kind).toBe("line-conflict");
    expect(
      conflict.ok === false &&
        conflict.error.kind === "line-conflict" &&
        conflict.error.current.unitPriceMinor,
    ).toBe(900);
    const refused = await finance.updateBudgetLine(db, "l1", "x", input);
    expect(refused.ok === false && refused.error.kind).toBe("refusal");
  });

  it("deletes, restores and draws contingency", async () => {
    const { db } = fakeClient({
      "from:budget_lines": [okResponse(null), okResponse(null)],
      "from:contingency_draws": [
        refusal("contingency_exhausted", "The draw exceeds the contingency remaining."),
      ],
    });
    expect((await finance.deleteBudgetLines(db, ["l1"])).ok).toBe(true);
    expect((await finance.restoreBudgetLines(db, ["l1"])).ok).toBe(true);
    expect(await finance.deleteBudgetLines(db, [])).toEqual({ ok: true, data: null });
    expect(await finance.restoreBudgetLines(db, [])).toEqual({ ok: true, data: null });
    const draw = await finance.drawContingency(db, "o1", {
      fromLineId: "c",
      toLineId: "l",
      amountMinor: 1,
      reason: "Wind",
    });
    expect(draw).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "contingency_exhausted",
        message: "The draw exceeds the contingency remaining.",
      },
    });
  });

  it("lists budget line references for pickers", async () => {
    const { db, calls } = fakeClient({
      "from:budget_lines": [
        okResponse([
          {
            id: "l1",
            budget_id: "b1",
            line_number: 1,
            description: "Sound",
            urid: "5000.01",
            line_type: "Cost",
            budget: { name: "B", project_id: "p1", currency_code: "USD" },
          },
        ]),
      ],
    });
    const result = await finance.listBudgetLineRefs(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data[0]?.currency).toBe("USD");
    expect(calls[0]?.steps).toContainEqual(["eq", ["budget.project_id", "p1"]]);
  });
});

describe("expenses", () => {
  const row = {
    id: "e1",
    budget_line_id: "l1",
    counterparty_id: null,
    submitter_person_id: "carol",
    description: "Deposit",
    incurred_on: "2027-06-10",
    amount_minor: 4000,
    currency_code: "USD",
    expense_state: "Proposed",
    created_at: "2027-06-10T00:00:00Z",
    line: { description: "Stage", budget_id: "b1", budget: { project_id: "p1" } },
  };

  it("lists and filters by project", async () => {
    const { db } = fakeClient({ "from:expenses": [okResponse([row]), okResponse([row])] });
    const all = await finance.listExpenses(db, { orgId: "o1" });
    expect(all.ok && all.data[0]?.projectId).toBe("p1");
    const other = await finance.listExpenses(db, { orgId: "o1", projectId: "p2" });
    expect(other).toEqual({ ok: true, data: [] });
  });

  it("creates and edits", async () => {
    const { db } = fakeClient({ "from:expenses": [okResponse({ id: "e2" }), okResponse(null)] });
    const input = {
      budgetLineId: "l1",
      counterpartyId: null,
      description: " Tape ",
      incurredOn: "2027-06-10",
      amountMinor: 1,
      currency: "USD",
    };
    expect(await finance.createExpense(db, "o1", input)).toEqual({ ok: true, data: { id: "e2" } });
    expect((await finance.updateExpense(db, "e2", input)).ok).toBe(true);
  });

  it("approves under spend authority and reports a pending second approval", async () => {
    const { db } = fakeClient({
      "rpc:approve_expense": [
        okResponse(true),
        okResponse(false),
        refusal("sod_expense_submitter", "The submitter of an expense cannot approve it."),
      ],
      "rpc:reject_expense": [okResponse("t1"), errorResponse("42501", "denied")],
      "rpc:transition_expense": [
        okResponse("t2"),
        refusal("expense_use_approval_rpc", "Use the RPC."),
      ],
    });
    expect(await finance.approveExpense(db, "e1", "ok")).toEqual({
      ok: true,
      data: { complete: true },
    });
    expect(await finance.approveExpense(db, "e1", "ok")).toEqual({
      ok: true,
      data: { complete: false },
    });
    const refused = await finance.approveExpense(db, "e1", "ok");
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "sod_expense_submitter",
    );
    expect((await finance.rejectExpense(db, "e1", "no")).ok).toBe(true);
    expect(await finance.rejectExpense(db, "e1", "no")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const t = { id: "e1", expected: "Proposed" as const, next: "Canceled" as const, reason: "dup" };
    expect((await finance.transitionExpense(db, t)).ok).toBe(true);
    expect((await finance.transitionExpense(db, t)).ok).toBe(false);
  });
});

describe("change orders", () => {
  it("lists with NULL-aware totals", async () => {
    const { db } = fakeClient({
      "from:change_orders": [
        okResponse([
          {
            id: "c1",
            project_id: "p1",
            budget_id: "b1",
            change_order_number: 3,
            title: "Second stage",
            order_type_enum_id: "ENM-092",
            reason: null,
            requested_by: "carol",
            priced_by: null,
            change_order_state: "Proposed",
            created_at: "x",
          },
        ]),
        okResponse([]),
      ],
      "from:change_order_totals": [
        okResponse([
          { change_order_id: "c1", line_count: 1, unpriced_count: 1, total_minor: null },
        ]),
      ],
    });
    const result = await finance.listChangeOrders(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data[0]).toMatchObject({
      number: 3,
      totalMinor: null,
      unpricedCount: 1,
    });
    expect(await finance.listChangeOrders(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
  });

  it("reads, adds, edits and removes lines, storing zero only when declared no-cost", async () => {
    const { db, calls } = fakeClient({
      "from:change_order_lines": [
        okResponse([
          {
            id: "x1",
            budget_line_id: null,
            description: "Deck",
            urid: "5000.04.02",
            quantity: 2,
            unit_price_minor: null,
            is_no_cost: false,
          },
        ]),
        okResponse(null),
        okResponse(null),
        okResponse(null),
      ],
    });
    const lines = await finance.listChangeOrderLines(db, "c1");
    expect(lines.ok && lines.data[0]?.extendedMinor).toBeNull();
    const line = {
      budgetLineId: null,
      description: "Waived",
      urid: "5000.04.02",
      quantity: 1,
      unitPriceMinor: 500,
      isNoCost: true,
    };
    expect((await finance.addChangeOrderLine(db, "o1", "c1", line)).ok).toBe(true);
    expect((calls[1]?.steps[0]?.[1]?.[0] as { unit_price_minor: number }).unit_price_minor).toBe(0);
    expect((await finance.updateChangeOrderLine(db, "x1", { ...line, isNoCost: false })).ok).toBe(
      true,
    );
    expect((await finance.deleteChangeOrderLine(db, "x1")).ok).toBe(true);
  });

  it("creates, edits, prices, approves and transitions", async () => {
    const { db } = fakeClient({
      "from:change_orders": [okResponse({ id: "c2" }), okResponse(null)],
      "rpc:price_change_order": [
        refusal("change_order_unpriced", "Every line of a change order needs a price."),
        okResponse("t"),
      ],
      "rpc:approve_change_order": [okResponse(true)],
      "rpc:transition_change_order": [okResponse("t"), errorResponse("08006", "down")],
    });
    const input = {
      projectId: "p1",
      budgetId: "b1",
      title: " T ",
      orderTypeId: null,
      reason: "  ",
    };
    expect(await finance.createChangeOrder(db, "o1", input)).toEqual({
      ok: true,
      data: { id: "c2" },
    });
    expect((await finance.updateChangeOrder(db, "c2", { ...input, reason: "Why" })).ok).toBe(true);
    const unpriced = await finance.priceChangeOrder(db, "c2", "Priced.");
    expect(unpriced.ok === false && unpriced.error.kind === "refusal" && unpriced.error.rule).toBe(
      "change_order_unpriced",
    );
    expect((await finance.priceChangeOrder(db, "c2", "Priced.")).ok).toBe(true);
    expect(await finance.approveChangeOrder(db, "c2", "Ok")).toEqual({
      ok: true,
      data: { complete: true },
    });
    const t = { id: "c2", expected: "Priced" as const, next: "Rejected" as const, reason: "No" };
    expect((await finance.transitionChangeOrder(db, t)).ok).toBe(true);
    const failed = await finance.transitionChangeOrder(db, t);
    expect(failed.ok === false && failed.error.kind).toBe("unexpected");
  });
});

describe("invoices", () => {
  it("lists with totals that stay blank while a line is unpriced", async () => {
    const { db } = fakeClient({
      "from:invoices": [
        okResponse([
          {
            id: "i1",
            project_id: "p1",
            direction: "Receivable",
            counterparty_id: "c1",
            invoice_number: "INV-1",
            issued_on: null,
            due_on: null,
            currency_code: "USD",
            invoice_state: "Proposed",
            created_at: "x",
          },
          {
            id: "i2",
            project_id: "p1",
            direction: "Payable",
            counterparty_id: "c1",
            invoice_number: null,
            issued_on: null,
            due_on: null,
            currency_code: "USD",
            invoice_state: "Approved",
            created_at: "x",
          },
        ]),
        okResponse([]),
      ],
      "from:invoice_totals": [
        okResponse([
          {
            invoice_id: "i1",
            unpriced_count: 1,
            subtotal_minor: null,
            tax_minor: null,
            applied_minor: 0,
          },
          {
            invoice_id: "i2",
            unpriced_count: 0,
            subtotal_minor: 1000,
            tax_minor: 70,
            applied_minor: 500,
          },
        ]),
      ],
    });
    const result = await finance.listInvoices(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data.map((i) => i.totalMinor)).toEqual([null, 1070]);
    expect(await finance.listInvoices(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
  });

  it("manages lines and the invoice lifecycle", async () => {
    const { db } = fakeClient({
      "from:invoices": [okResponse({ id: "i3" }), okResponse(null)],
      "from:invoice_lines": [
        okResponse([
          {
            id: "x",
            line_number: 1,
            description: "Fee",
            quantity: 1,
            unit_price_minor: 100,
            budget_line_id: null,
          },
        ]),
        okResponse([{ line_number: 2 }]),
        okResponse(null),
        okResponse(null),
      ],
      "rpc:issue_invoice": [okResponse("t"), refusal("invoice_unpriced", "Price every line.")],
      "rpc:approve_invoice": [okResponse(false)],
      "rpc:transition_invoice": [okResponse("t"), errorResponse("42501", "denied")],
    });
    const input = {
      projectId: "p1",
      direction: "Receivable" as const,
      counterpartyId: "c1",
      number: " ",
      issuedOn: null,
      dueOn: null,
      currency: "USD",
    };
    expect(await finance.createInvoice(db, "o1", input)).toEqual({ ok: true, data: { id: "i3" } });
    expect(
      (await finance.updateInvoice(db, "i3", { number: "A", issuedOn: null, dueOn: null })).ok,
    ).toBe(true);
    const lines = await finance.listInvoiceLines(db, "i3");
    expect(lines.ok && lines.data[0]?.extendedMinor).toBe(100);
    expect(
      (
        await finance.addInvoiceLine(db, "o1", "i3", {
          description: "Fee",
          quantity: 1,
          unitPriceMinor: null,
          budgetLineId: null,
        })
      ).ok,
    ).toBe(true);
    expect((await finance.deleteInvoiceLine(db, "x")).ok).toBe(true);
    expect((await finance.issueInvoice(db, "i3", "Issued.")).ok).toBe(true);
    expect((await finance.issueInvoice(db, "i3", "Issued.")).ok).toBe(false);
    expect(await finance.approveInvoice(db, "i3", "Ok")).toEqual({
      ok: true,
      data: { complete: false },
    });
    const t = { id: "i3", expected: "Issued" as const, next: "Disputed" as const, reason: "Wrong" };
    expect((await finance.transitionInvoice(db, t)).ok).toBe(true);
    expect((await finance.transitionInvoice(db, t)).ok).toBe(false);
  });

  it("surfaces a failed line number read", async () => {
    const { db } = fakeClient({ "from:invoice_lines": [errorResponse("08006", "down")] });
    const result = await finance.addInvoiceLine(db, "o1", "i3", {
      description: "Fee",
      quantity: 1,
      unitPriceMinor: 1,
      budgetLineId: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe("payments", () => {
  it("lists with the live amount applied", async () => {
    const { db } = fakeClient({
      "from:payments": [
        okResponse([
          {
            id: "pay1",
            counterparty_id: "c1",
            direction: "Receivable",
            amount_minor: 1000,
            currency_code: "USD",
            paid_on: "2027-06-01",
            reference_identifier: null,
            payment_state: "Approved",
            created_at: "x",
            payment_applications: [
              { amount_minor: 300, deleted_at: null },
              { amount_minor: 200, deleted_at: "2027-06-02" },
            ],
          },
        ]),
      ],
    });
    const result = await finance.listPayments(db, "o1");
    expect(result.ok && result.data[0]?.appliedMinor).toBe(300);
  });

  it("records, approves, cancels, applies and removes", async () => {
    const { db } = fakeClient({
      "from:payments": [okResponse({ id: "pay2" })],
      "rpc:approve_payment": [refusal("sod_vendor_payment", "Not you."), okResponse("t")],
      "rpc:cancel_payment": [okResponse("t")],
      "from:payment_applications": [
        okResponse([{ id: "a1", payment_id: "pay2", invoice_id: "i1", amount_minor: 10 }]),
        refusal("payment_overapplied", "A payment is never applied beyond its amount."),
        okResponse(null),
      ],
    });
    const input = {
      counterpartyId: "c1",
      direction: "Payable" as const,
      amountMinor: 10,
      currency: "USD",
      paidOn: "2027-06-01",
      reference: null,
    };
    expect(await finance.createPayment(db, "o1", input)).toEqual({
      ok: true,
      data: { id: "pay2" },
    });
    expect((await finance.approvePayment(db, "pay2", "Ok")).ok).toBe(false);
    expect((await finance.approvePayment(db, "pay2", "Ok")).ok).toBe(true);
    expect((await finance.cancelPayment(db, "pay2", "No")).ok).toBe(true);
    const apps = await finance.listPaymentApplications(db, "pay2");
    expect(apps.ok && apps.data[0]?.amountMinor).toBe(10);
    const over = await finance.applyPayment(db, "o1", {
      paymentId: "pay2",
      invoiceId: "i1",
      amountMinor: 99,
    });
    expect(over.ok === false && over.error.kind === "refusal" && over.error.rule).toBe(
      "payment_overapplied",
    );
    expect((await finance.removePaymentApplication(db, "a1")).ok).toBe(true);
  });
});

describe("periods and journal", () => {
  it("lists, opens and transitions periods", async () => {
    const { db } = fakeClient({
      "from:accounting_periods": [
        okResponse([
          {
            id: "per",
            starts_on: "2027-06-01",
            ends_on: "2027-06-30",
            period_state: "Open",
            created_at: "x",
          },
        ]),
        refusal("period_overlap", "Accounting periods of an org never overlap."),
      ],
      "rpc:transition_accounting_period": [
        okResponse("t"),
        refusal("lifecycle_transition", "Not allowed."),
      ],
    });
    expect((await finance.listPeriods(db, "o1")).ok).toBe(true);
    const overlap = await finance.createPeriod(db, "o1", {
      startsOn: "2027-06-15",
      endsOn: "2027-07-15",
    });
    expect(overlap.ok === false && overlap.error.kind === "refusal" && overlap.error.rule).toBe(
      "period_overlap",
    );
    const t = { id: "per", expected: "Open" as const, next: "In Period" as const, reason: "Start" };
    expect((await finance.transitionPeriod(db, t)).ok).toBe(true);
    expect((await finance.transitionPeriod(db, { ...t, next: "Audited" })).ok).toBe(false);
  });

  it("reads the period ledger", async () => {
    const { db, calls } = fakeClient({
      "from:accounting_period_state_transitions": [
        okResponse([
          {
            id: "t1",
            from_state: null,
            to_state: "Open",
            reason: "Opened.",
            created_at: "x",
            created_by: null,
          },
        ]),
      ],
    });
    const ledger = await finance.listTransitions(db, "accounting_period_state_transitions", "per");
    expect(ledger.ok && ledger.data[0]?.toState).toBe("Open");
    expect(calls[0]?.steps).toContainEqual(["eq", ["accounting_period_id", "per"]]);
  });

  it("lists entries with balances and live lines", async () => {
    const { db } = fakeClient({
      "from:journal_entries": [
        okResponse([
          {
            id: "j1",
            accounting_period_id: "per",
            project_id: null,
            entry_date: "2027-06-10",
            memo: "Accrual",
            journal_state: "Proposed",
            prepared_by: "carol",
            posted_by: null,
            posted_at: null,
            source_table: null,
            source_id: null,
            journal_lines: [
              {
                id: "b",
                line_number: 2,
                account_code: "2000",
                cost_center_id: null,
                urid: null,
                counterparty_id: null,
                description: "x",
                debit_minor: 0,
                credit_minor: 100,
                currency_code: "USD",
                deleted_at: null,
              },
              {
                id: "a",
                line_number: 1,
                account_code: "5500",
                cost_center_id: null,
                urid: null,
                counterparty_id: null,
                description: "x",
                debit_minor: 100,
                credit_minor: 0,
                currency_code: "USD",
                deleted_at: null,
              },
              {
                id: "z",
                line_number: 3,
                account_code: "5500",
                cost_center_id: null,
                urid: null,
                counterparty_id: null,
                description: "x",
                debit_minor: 7,
                credit_minor: 0,
                currency_code: "USD",
                deleted_at: "x",
              },
            ],
          },
        ]),
      ],
    });
    const result = await finance.listJournalEntries(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data[0]).toMatchObject({
      debitMinor: 100,
      creditMinor: 100,
      currency: "USD",
    });
    expect(result.ok && result.data[0]?.lines.map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("prepares an entry, and cancels the header when its lines are refused", async () => {
    const input = {
      periodId: "per",
      projectId: null,
      entryDate: "2027-06-10",
      memo: " Accrual ",
      currency: "USD",
      lines: [
        {
          accountCode: "5500",
          costCenterId: null,
          urid: null,
          description: "d",
          debitMinor: 100,
          creditMinor: 0,
        },
        {
          accountCode: "2000",
          costCenterId: null,
          urid: null,
          description: "d",
          debitMinor: 0,
          creditMinor: 100,
        },
      ],
    };
    const good = fakeClient({
      "from:journal_entries": [okResponse({ id: "j2" })],
      "from:journal_lines": [okResponse(null)],
    });
    expect(await finance.createJournalEntry(good.db, "o1", input)).toEqual({
      ok: true,
      data: { id: "j2" },
    });
    const bad = fakeClient({
      "from:journal_entries": [okResponse({ id: "j3" })],
      "from:journal_lines": [refusal("urid_unknown", "Bad URID.")],
      "rpc:cancel_journal_entry": [okResponse("t")],
    });
    const refused = await finance.createJournalEntry(bad.db, "o1", input);
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "urid_unknown",
    );
    expect(bad.calls.at(-1)?.target).toBe("rpc:cancel_journal_entry");
    const closed = fakeClient({
      "from:journal_entries": [
        refusal("period_closed", "The period is Closed and refuses postings."),
      ],
    });
    const blocked = await finance.createJournalEntry(closed.db, "o1", input);
    expect(blocked.ok === false && blocked.error.kind === "refusal" && blocked.error.rule).toBe(
      "period_closed",
    );
    const stuck = fakeClient({
      "from:journal_entries": [okResponse({ id: "j4" })],
      "from:journal_lines": [refusal("urid_unknown", "Bad URID.")],
      "rpc:cancel_journal_entry": [errorResponse("08006", "down")],
    });
    const result = await finance.createJournalEntry(stuck.db, "o1", input);
    expect(result.ok === false && result.error.kind).toBe("unexpected");
  });

  it("posts and cancels through the RPCs", async () => {
    const { db } = fakeClient({
      "rpc:post_journal_entry": [
        refusal("sod_journal_preparer", "The preparer cannot post it."),
        okResponse("t"),
      ],
      "rpc:cancel_journal_entry": [okResponse("t")],
    });
    const self = await finance.postJournalEntry(db, "j1", "Post");
    expect(self.ok === false && self.error.kind === "refusal" && self.error.rule).toBe(
      "sod_journal_preparer",
    );
    expect((await finance.postJournalEntry(db, "j1", "Post")).ok).toBe(true);
    expect((await finance.cancelJournalEntry(db, "j1", "No")).ok).toBe(true);
  });
});

describe("errors on reads", () => {
  it("returns typed errors instead of throwing", async () => {
    const { db } = fakeClient({
      "from:budgets": [
        okResponse([{ id: "b1", project_id: "p1" }]),
        errorResponse("08006", "down"),
      ],
      "from:budget_revised_totals": [errorResponse("42501", "denied")],
      "from:change_orders": [okResponse([{ id: "c1" }])],
      "from:change_order_totals": [errorResponse("08006", "down")],
      "from:invoices": [okResponse([{ id: "i1" }])],
      "from:invoice_totals": [errorResponse("08006", "down")],
      "from:cost_centers": [errorResponse("08006", "down")],
      "from:budget_lines": [errorResponse("08006", "down")],
    });
    expect((await finance.listBudgets(db, { orgId: "o1" })).ok).toBe(false);
    expect((await finance.listBudgets(db, { orgId: "o1" })).ok).toBe(false);
    expect((await finance.listChangeOrders(db, { orgId: "o1" })).ok).toBe(false);
    expect((await finance.listInvoices(db, { orgId: "o1" })).ok).toBe(false);
    expect((await finance.listCostCenters(db, "o1")).ok).toBe(false);
    expect((await finance.addBudgetLines(db, "o1", "b1", [{} as BudgetLineInput])).ok).toBe(false);
  });

  it("answers not-found when a budget's own summary is hidden", async () => {
    const { db } = fakeClient({
      "from:budgets": [okResponse({ id: "b1", project_id: "p1" }), okResponse([])],
      "from:budget_lines": [okResponse([])],
      "from:budget_line_amounts": [okResponse([])],
      "from:budget_line_commitments": [okResponse([])],
    });
    expect(await finance.getBudget(db, "o1", "b1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("lifecycle tables", () => {
  it("offer only the moves A03 declares", () => {
    expect(finance.NEXT_STATES.change_order.Priced).toContain("Approved");
    expect(finance.NEXT_STATES.accounting_period.Open).toEqual(["In Period"]);
    expect(finance.PERIOD_STATES).toHaveLength(6);
  });
});
