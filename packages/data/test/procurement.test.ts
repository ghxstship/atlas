import { describe, expect, it } from "vitest";
import {
  addPoLine,
  approveMatchedInvoice,
  approvePurchaseOrder,
  createCatalogBinding,
  createInvoiceMatch,
  createPoChangeOrder,
  createPurchaseOrder,
  createPurchaseOrderFromResponse,
  createRfq,
  createVendorProduct,
  decidePoChangeOrder,
  deleteCatalogBinding,
  deleteVendorProduct,
  displayKey,
  extendedMinor,
  getGoodsReceipt,
  getPurchaseOrder,
  getPurchaseOrderTotals,
  getRfq,
  inviteVendorToRfq,
  listCatalogBindings,
  listCurrencies,
  listGoodsReceipts,
  listInvoiceMatches,
  listPayableInvoices,
  listPoChangeOrders,
  listPoLines,
  listProjectOptions,
  listPurchaseOrders,
  listRfqResponses,
  listRfqs,
  listVendorProducts,
  matchStanding,
  nullAwareTotal,
  pricePoChangeOrder,
  recordGoodsReceipt,
  recordRfqResponse,
  removePoLine,
  removeRfqInvitation,
  resolveInvoiceMatch,
  transitionPurchaseOrder,
  transitionRfq,
  updateCatalogBinding,
  updatePoLine,
  updateRfq,
  type RfqResponse,
} from "../src/procurement.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

const project = { project_key: "NWL", name: "Summer" };
const vendor = { counterparty: { counterparty_name: "Harbor Audio" } };
const down = errorResponse("08006", "down");

describe("money helpers", () => {
  it("extends and totals with NULL meaning unpriced", () => {
    expect(extendedMinor(2, 1050)).toBe(2100);
    expect(extendedMinor(1.5, 333)).toBe(500);
    expect(extendedMinor(-1.5, 333)).toBe(-500);
    expect(extendedMinor(3, null)).toBeNull();
    expect(nullAwareTotal([100, 200])).toBe(300);
    expect(nullAwareTotal([100, null])).toBeNull();
    expect(nullAwareTotal([])).toBeNull();
  });

  it("builds display keys from the project key", () => {
    expect(displayKey("NWL", "PO", 7)).toBe("NWL-PO7");
    expect(displayKey(null, "RFQ", 1)).toBe("?-RFQ1");
  });

  it("classifies match standing", () => {
    expect(matchStanding({ isMatched: true, isResolved: false })).toBe("matched");
    expect(matchStanding({ isMatched: false, isResolved: true })).toBe("resolved");
    expect(matchStanding({ isMatched: false, isResolved: false })).toBe("mismatch");
  });
});

describe("pickers", () => {
  it("lists projects and currencies", async () => {
    const { db } = commercialClient({
      "from:projects": [okResponse([{ id: "p1", project_key: "NWL", name: "Summer" }])],
      "from:currencies": [
        okResponse([
          { currency_code: "USD", minor_unit_exponent: 2 },
          { currency_code: null, minor_unit_exponent: null },
        ]),
      ],
    });
    expect(await listProjectOptions(db, "o1")).toEqual({
      ok: true,
      data: [{ id: "p1", key: "NWL", name: "Summer" }],
    });
    const currencies = await listCurrencies(db);
    expect(currencies.ok && currencies.data).toEqual([
      { code: "USD", minorUnits: 2 },
      { code: "", minorUnits: 2 },
    ]);
  });
});

describe("rfqs", () => {
  const rfqRow = {
    id: "r1",
    project_id: "p1",
    rfq_number: 3,
    title: "Stage audio",
    responses_due_at: null,
    rfq_state: "Issued",
    created_at: "t",
    project,
    rfq_invitations: [
      { vendor_id: "v1", deleted_at: null },
      { vendor_id: "v2", deleted_at: "x" },
    ],
  };

  it("lists and reads RFQs with keys and live invitations", async () => {
    const { db } = commercialClient({
      "from:rfqs": [okResponse([rfqRow]), okResponse(rfqRow), okResponse(null)],
    });
    const list = await listRfqs(db, "o1");
    expect(list.ok && list.data[0]).toMatchObject({ key: "NWL-RFQ3", invitedVendorIds: ["v1"] });
    expect((await getRfq(db, "r1")).ok).toBe(true);
    expect((await getRfq(db, "r9")).ok).toBe(false);
  });

  it("creates, edits and transitions RFQs", async () => {
    const { db, calls } = commercialClient({
      "from:rfqs": [okResponse({ id: "r1" }), okResponse([{ id: "r1" }])],
      "rpc:transition_rfq": [
        okResponse("t"),
        errorResponse("XR001", "rfq_no_invitations: Invite.", "rfq_no_invitations"),
      ],
    });
    expect(
      (await createRfq(db, { projectId: "p1", title: " Audio ", responsesDueAt: "" })).ok,
    ).toBe(true);
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { project_id: "p1", title: "Audio", responses_due_at: null },
    ]);
    expect(
      (await updateRfq(db, "r1", { title: "Audio", responsesDueAt: "2026-11-01T17:00:00Z" })).ok,
    ).toBe(true);
    expect(
      (await transitionRfq(db, { id: "r1", expected: "Proposed", next: "Issued", reason: "Go." }))
        .ok,
    ).toBe(true);
    const refused = await transitionRfq(db, {
      id: "r1",
      expected: "Proposed",
      next: "Issued",
      reason: "Go.",
    });
    expect(refused.ok === false && refused.error).toEqual({
      kind: "refusal",
      rule: "rfq_no_invitations",
      message: "Invite.",
    });
  });

  it("invites and withdraws vendors", async () => {
    const { db, calls } = commercialClient({
      "from:rfq_invitations": [
        okResponse({ id: "i1" }),
        okResponse([{ id: "i1" }]),
        okResponse([]),
      ],
    });
    expect((await inviteVendorToRfq(db, "r1", "v1")).ok).toBe(true);
    expect((await removeRfqInvitation(db, "r1", "v1")).ok).toBe(true);
    expect(calls[1]?.steps).toContainEqual(["eq", ["vendor_id", "v1"]]);
    expect((await removeRfqInvitation(db, "r1", "v2")).ok).toBe(false);
  });

  it("lists responses with NULL-aware totals", async () => {
    const line = (id: string, price: number | null, deleted: string | null = null) => ({
      id,
      description: "Line.",
      element_id: null,
      quantity: 2,
      unit_price_minor: price,
      currency_code: "USD",
      deleted_at: deleted,
    });
    const { db } = commercialClient({
      "from:rfq_responses": [
        okResponse([
          {
            id: "s1",
            vendor_id: "v1",
            submitted_at: "t",
            valid_until: null,
            vendor,
            rfq_response_lines: [line("l1", 100), line("l2", 50), line("l3", null, "x")],
          },
          {
            id: "s2",
            vendor_id: "v2",
            submitted_at: "t",
            valid_until: null,
            vendor: null,
            rfq_response_lines: [line("l4", null)],
          },
        ]),
      ],
    });
    const result = await listRfqResponses(db, "r1");
    expect(
      result.ok && result.data.map((r) => [r.vendorName, r.totalMinor, r.lines.length]),
    ).toEqual([
      ["Harbor Audio", 300, 2],
      [null, null, 1],
    ]);
  });

  it("records a response with its lines and refuses an empty one", async () => {
    const { db, calls } = commercialClient({
      "from:rfq_responses": [
        okResponse({ id: "s1" }),
        errorResponse("XR001", "rfq_not_open: Closed.", "rfq_not_open"),
        okResponse({ id: "s3" }),
      ],
      "from:rfq_response_lines": [okResponse([{ id: "l1" }]), errorResponse("23514", "bad")],
    });
    const input = {
      rfqId: "r1",
      vendorId: "v1",
      validUntil: "",
      currencyCode: "USD",
      lines: [{ description: " Mics ", quantity: 4, unitPriceMinor: null, elementId: "" }],
    };
    expect(await recordRfqResponse(db, input)).toEqual({ ok: true, data: { id: "s1" } });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      [
        {
          rfq_response_id: "s1",
          description: "Mics",
          element_id: null,
          quantity: 4,
          unit_price_minor: null,
          currency_code: "USD",
        },
      ],
    ]);
    expect((await recordRfqResponse(db, input)).ok).toBe(false);
    expect((await recordRfqResponse(db, input)).ok).toBe(false);
    expect(await recordRfqResponse(db, { ...input, lines: [] })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "lines" },
    });
  });
});

describe("purchase orders", () => {
  const poRow = {
    id: "po1",
    project_id: "p1",
    po_number: 7,
    vendor_id: "v1",
    rfq_response_id: null,
    currency_code: "USD",
    po_state: "Proposed",
    created_at: "t",
    created_by: "p9",
    project,
    vendor,
  };

  it("lists orders with their NULL-aware totals", async () => {
    const { db } = commercialClient({
      "from:purchase_orders": [okResponse([poRow, { ...poRow, id: "po2", po_number: 8 }])],
      "from:purchase_order_totals": [
        okResponse([
          {
            purchase_order_id: "po1",
            unpriced_count: 1,
            lines_total_minor: null,
            approved_changes_minor: 500,
          },
        ]),
      ],
    });
    const result = await listPurchaseOrders(db, "o1");
    expect(result.ok && result.data.map((o) => [o.key, o.totals])).toEqual([
      ["NWL-PO7", { unpricedCount: 1, linesTotalMinor: null, approvedChangesMinor: 500 }],
      ["NWL-PO8", { unpricedCount: 0, linesTotalMinor: null, approvedChangesMinor: null }],
    ]);
  });

  it("surfaces either failing read", async () => {
    const a = commercialClient({
      "from:purchase_orders": [down],
      "from:purchase_order_totals": [okResponse([])],
    });
    expect((await listPurchaseOrders(a.db, "o1")).ok).toBe(false);
    const b = commercialClient({
      "from:purchase_orders": [okResponse([])],
      "from:purchase_order_totals": [down],
    });
    expect((await listPurchaseOrders(b.db, "o1")).ok).toBe(false);
  });

  it("reads one order, its lines and totals", async () => {
    const { db } = commercialClient({
      "from:purchase_orders": [okResponse(poRow)],
      "from:po_lines": [
        okResponse([
          {
            id: "l1",
            line_number: 1,
            description: "Deck.",
            element_id: null,
            budget_line_id: null,
            quantity: 4,
            unit_basis: "ea",
            unit_price_minor: 2500,
            receipt_lines: [
              { quantity_received: 1, deleted_at: null },
              { quantity_received: 2, deleted_at: "x" },
            ],
          },
        ]),
      ],
      "from:purchase_order_totals": [
        okResponse({ unpriced_count: 0, lines_total_minor: 10000, approved_changes_minor: null }),
        okResponse(null),
        down,
      ],
    });
    expect((await getPurchaseOrder(db, "po1")).ok).toBe(true);
    const lines = await listPoLines(db, "po1");
    expect(lines.ok && lines.data[0]).toMatchObject({ extendedMinor: 10000, receivedQuantity: 1 });
    expect(await getPurchaseOrderTotals(db, "po1")).toEqual({
      ok: true,
      data: { unpricedCount: 0, linesTotalMinor: 10000, approvedChangesMinor: null },
    });
    expect(await getPurchaseOrderTotals(db, "po2")).toEqual({
      ok: true,
      data: { unpricedCount: 0, linesTotalMinor: null, approvedChangesMinor: null },
    });
    expect((await getPurchaseOrderTotals(db, "po3")).ok).toBe(false);
  });

  it("creates orders and numbers new lines after the last", async () => {
    const { db, calls } = commercialClient({
      "from:purchase_orders": [okResponse({ id: "po1" })],
      "from:po_lines": [
        okResponse([{ line_number: 3 }]),
        okResponse({ id: "l4" }),
        okResponse([]),
        okResponse({ id: "l1" }),
        down,
        okResponse([{ id: "l1" }]),
        okResponse([{ id: "l1" }]),
      ],
    });
    expect(
      (await createPurchaseOrder(db, { projectId: "p1", vendorId: "v1", currencyCode: "USD" })).ok,
    ).toBe(true);
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { project_id: "p1", vendor_id: "v1", currency_code: "USD", rfq_response_id: null },
    ]);
    expect(
      (await addPoLine(db, "po1", { description: " Deck ", quantity: 2, unitPriceMinor: null })).ok,
    ).toBe(true);
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      {
        description: "Deck",
        quantity: 2,
        unit_price_minor: null,
        unit_basis: null,
        element_id: null,
        budget_line_id: null,
        purchase_order_id: "po1",
        line_number: 4,
      },
    ]);
    await addPoLine(db, "po1", { description: "First", quantity: 1, unitPriceMinor: 100 });
    expect(calls[4]?.steps[0]?.[1]).toMatchObject([{ line_number: 1 }]);
    expect(
      (await addPoLine(db, "po1", { description: "x", quantity: 1, unitPriceMinor: 1 })).ok,
    ).toBe(false);
    expect(
      (
        await updatePoLine(db, "l1", {
          description: "Deck",
          quantity: 3,
          unitPriceMinor: 900,
          unitBasis: "ea",
        })
      ).ok,
    ).toBe(true);
    expect((await removePoLine(db, "l1")).ok).toBe(true);
  });

  it("approves under spend authority and transitions", async () => {
    const { db } = commercialClient({
      "rpc:approve_purchase_order": [
        okResponse(true),
        okResponse(false),
        errorResponse(
          "XR001",
          "sod_po_creator: The creator of a purchase order cannot approve it.",
          "sod_po_creator",
        ),
      ],
      "rpc:transition_purchase_order": [okResponse("t"), down],
    });
    expect(await approvePurchaseOrder(db, "po1", "Within limit.")).toEqual({
      ok: true,
      data: { approved: true },
    });
    expect(await approvePurchaseOrder(db, "po1", "First of two.")).toEqual({
      ok: true,
      data: { approved: false },
    });
    const refused = await approvePurchaseOrder(db, "po1", "Mine.");
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "sod_po_creator",
    );
    expect(
      (
        await transitionPurchaseOrder(db, {
          id: "po1",
          expected: "Approved",
          next: "Sent",
          reason: "Emailed.",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await transitionPurchaseOrder(db, {
          id: "po1",
          expected: "Sent",
          next: "Closed",
          reason: "Done.",
        })
      ).ok,
    ).toBe(false);
  });

  it("creates an order from an awarded response, copying its lines", async () => {
    const response: RfqResponse = {
      id: "s1",
      vendorId: "v1",
      vendorName: "Harbor",
      submittedAt: "t",
      validUntil: null,
      totalMinor: null,
      lines: [
        {
          id: "l1",
          description: "Mics.",
          elementId: null,
          quantity: 4,
          unitPriceMinor: 1000,
          currencyCode: "EUR",
        },
        {
          id: "l2",
          description: "Stands.",
          elementId: "E-1",
          quantity: 4,
          unitPriceMinor: null,
          currencyCode: "EUR",
        },
      ],
    };
    const { db, calls } = commercialClient({
      "from:purchase_orders": [okResponse({ id: "po9" }), down, okResponse({ id: "po10" })],
      "from:po_lines": [
        okResponse([{ id: "a" }, { id: "b" }]),
        errorResponse("XR001", "purchase_order_locked: Locked.", "purchase_order_locked"),
      ],
    });
    expect(await createPurchaseOrderFromResponse(db, { projectId: "p1", response })).toEqual({
      ok: true,
      data: { id: "po9" },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { project_id: "p1", vendor_id: "v1", currency_code: "EUR", rfq_response_id: "s1" },
    ]);
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      [
        {
          purchase_order_id: "po9",
          line_number: 1,
          description: "Mics.",
          element_id: null,
          quantity: 4,
          unit_price_minor: 1000,
        },
        {
          purchase_order_id: "po9",
          line_number: 2,
          description: "Stands.",
          element_id: "E-1",
          quantity: 4,
          unit_price_minor: null,
        },
      ],
    ]);
    expect((await createPurchaseOrderFromResponse(db, { projectId: "p1", response })).ok).toBe(
      false,
    );
    expect((await createPurchaseOrderFromResponse(db, { projectId: "p1", response })).ok).toBe(
      false,
    );
    expect(
      await createPurchaseOrderFromResponse(db, {
        projectId: "p1",
        response: { ...response, lines: [] },
      }),
    ).toEqual({ ok: false, error: { kind: "invalid", message: "lines" } });
  });
});

describe("po change orders", () => {
  it("lists, creates, prices and decides change orders", async () => {
    const { db, calls } = commercialClient({
      "from:po_change_orders": [
        okResponse([
          {
            id: "c1",
            purchase_order_id: "po1",
            description: "Stairs.",
            amount_delta_minor: null,
            po_change_order_state: "Proposed",
            created_by: "p1",
            created_at: "t",
          },
        ]),
        okResponse({ id: "c1" }),
        okResponse([{ id: "c1" }]),
      ],
      "rpc:decide_po_change_order": [okResponse(true), okResponse(false)],
    });
    const list = await listPoChangeOrders(db, "po1");
    expect(list.ok && list.data[0]?.amountDeltaMinor).toBeNull();
    expect(
      (
        await createPoChangeOrder(db, {
          purchaseOrderId: "po1",
          description: " Stairs. ",
          amountDeltaMinor: null,
        })
      ).ok,
    ).toBe(true);
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { purchase_order_id: "po1", description: "Stairs.", amount_delta_minor: null },
    ]);
    expect((await pricePoChangeOrder(db, "c1", -500)).ok).toBe(true);
    expect(
      await decidePoChangeOrder(db, { id: "c1", decision: "Approved", reason: "Go." }),
    ).toEqual({ ok: true, data: { decided: true } });
    expect(
      await decidePoChangeOrder(db, { id: "c1", decision: "Approved", reason: "Go." }),
    ).toEqual({ ok: true, data: { decided: false } });
  });
});

describe("goods receipts", () => {
  const receiptRow = {
    id: "g1",
    purchase_order_id: "po1",
    received_at: "t",
    received_by: "p1",
    note: null,
    receiver: { full_name: "Carol" },
    purchase_order: { po_number: 7, project, vendor },
    receipt_lines: [
      { po_line_id: "l1", quantity_received: 2, deleted_at: null },
      { po_line_id: "l2", quantity_received: 1, deleted_at: "x" },
    ],
    invoice_matches: [{ id: "m1", deleted_at: null }],
  };

  it("lists and reads receipts with their order and match", async () => {
    const { db, calls } = commercialClient({
      "from:goods_receipts": [
        okResponse([
          receiptRow,
          {
            ...receiptRow,
            id: "g2",
            receiver: null,
            purchase_order: null,
            receipt_lines: null,
            invoice_matches: null,
          },
        ]),
        okResponse([]),
        okResponse(receiptRow),
      ],
    });
    const list = await listGoodsReceipts(db, "o1");
    expect(list.ok && list.data[0]).toMatchObject({
      purchaseOrderKey: "NWL-PO7",
      vendorName: "Harbor Audio",
      receiverName: "Carol",
      matched: true,
      lines: [{ poLineId: "l1", quantityReceived: 2 }],
    });
    expect(list.ok && list.data[1]).toMatchObject({ purchaseOrderKey: "?-PO0", matched: false });
    await listGoodsReceipts(db, "o1", "po1");
    expect(calls[1]?.steps).toContainEqual(["eq", ["purchase_order_id", "po1"]]);
    expect((await getGoodsReceipt(db, "g1")).ok).toBe(true);
  });

  it("records receipts, skipping empty lines, and withdraws a refused header", async () => {
    const { db, calls } = commercialClient({
      "from:goods_receipts": [
        okResponse({ id: "g1" }),
        okResponse({ id: "g2" }),
        okResponse(null),
        errorResponse("XR001", "receipt_order_state: No.", "receipt_order_state"),
      ],
      "from:receipt_lines": [
        okResponse([{ id: "r1" }]),
        errorResponse(
          "XR001",
          "receipt_exceeds_order: Receipts never exceed the quantity ordered.",
          "receipt_exceeds_order",
        ),
      ],
    });
    const input = {
      purchaseOrderId: "po1",
      note: " ",
      lines: [
        { poLineId: "l1", quantity: 2 },
        { poLineId: "l2", quantity: 0 },
      ],
    };
    expect(await recordGoodsReceipt(db, input)).toEqual({ ok: true, data: { id: "g1" } });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      [{ goods_receipt_id: "g1", po_line_id: "l1", quantity_received: 2 }],
    ]);
    const exceeded = await recordGoodsReceipt(db, input);
    expect(exceeded.ok === false && exceeded.error.kind === "refusal" && exceeded.error.rule).toBe(
      "receipt_exceeds_order",
    );
    expect(calls[4]?.steps[0]?.[0]).toBe("update");
    expect((await recordGoodsReceipt(db, input)).ok).toBe(false);
    expect(await recordGoodsReceipt(db, { ...input, lines: [] })).toEqual({
      ok: false,
      error: { kind: "invalid", message: "lines" },
    });
  });
});

describe("three-way match", () => {
  it("joins matches to their derived results", async () => {
    const { db } = commercialClient({
      "from:invoice_matches": [
        okResponse([
          {
            id: "m1",
            invoice_id: "i1",
            purchase_order_id: "po1",
            goods_receipt_id: "g1",
            resolution_note: null,
            resolved_by: null,
            created_by: "p1",
            created_at: "t",
            invoice: { invoice_number: "HS-1", invoice_state: "Proposed", currency_code: "USD" },
            purchase_order: { po_number: 7, project, vendor },
          },
          {
            id: "m2",
            invoice_id: "i2",
            purchase_order_id: "po1",
            goods_receipt_id: "g2",
            resolution_note: "Agreed.",
            resolved_by: "p2",
            created_by: "p1",
            created_at: "t",
            invoice: null,
            purchase_order: null,
          },
        ]),
      ],
      "from:invoice_match_results": [
        okResponse([
          { invoice_match_id: "m1", variance_minor: 2000, is_matched: false, is_resolved: false },
        ]),
      ],
    });
    const result = await listInvoiceMatches(db, "o1");
    expect(result.ok && result.data[0]).toMatchObject({
      purchaseOrderKey: "NWL-PO7",
      varianceMinor: 2000,
      isMatched: false,
      invoiceNumber: "HS-1",
    });
    expect(result.ok && result.data[1]).toMatchObject({
      varianceMinor: null,
      isMatched: false,
      isResolved: false,
      currencyCode: null,
    });
  });

  it("surfaces either failing read", async () => {
    const a = commercialClient({
      "from:invoice_matches": [down],
      "from:invoice_match_results": [okResponse([])],
    });
    expect((await listInvoiceMatches(a.db, "o1")).ok).toBe(false);
    const b = commercialClient({
      "from:invoice_matches": [okResponse([])],
      "from:invoice_match_results": [errorResponse("42501", "no")],
    });
    expect(await listInvoiceMatches(b.db, "o1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("lists payable invoices, matches, resolves and approves", async () => {
    const { db, calls } = commercialClient({
      "from:invoices": [
        okResponse([
          {
            id: "i1",
            invoice_number: "HS-1",
            project_id: "p1",
            counterparty_id: "c1",
            invoice_state: "Proposed",
            counterparty: { counterparty_name: "Harbor" },
          },
          {
            id: "i2",
            invoice_number: null,
            project_id: "p1",
            counterparty_id: "c1",
            invoice_state: "Proposed",
            counterparty: null,
          },
        ]),
      ],
      "from:invoice_matches": [
        okResponse({ id: "m1" }),
        errorResponse("23505", "dup"),
        okResponse([{ id: "m1" }]),
      ],
      "rpc:approve_invoice": [
        okResponse(true),
        errorResponse("XR001", "invoice_match_mismatch: Resolve.", "invoice_match_mismatch"),
      ],
    });
    const invoices = await listPayableInvoices(db, "o1");
    expect(invoices.ok && invoices.data.map((i) => i.label)).toEqual(["HS-1 · Harbor", ""]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["direction", "Payable"]]);
    const input = { invoiceId: "i1", purchaseOrderId: "po1", goodsReceiptId: "g1" };
    expect((await createInvoiceMatch(db, input)).ok).toBe(true);
    expect(await createInvoiceMatch(db, input)).toEqual({
      ok: false,
      error: { kind: "conflict", message: "dup" },
    });
    expect((await resolveInvoiceMatch(db, "m1", " Freight agreed. ")).ok).toBe(true);
    expect(calls[3]?.steps[0]).toEqual(["update", [{ resolution_note: "Freight agreed." }]]);
    expect(await approveMatchedInvoice(db, "i1", "Matched.")).toEqual({
      ok: true,
      data: { approved: true },
    });
    const refused = await approveMatchedInvoice(db, "i1", "Matched.");
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "invoice_match_mismatch",
    );
  });
});

describe("catalog", () => {
  it("lists bindings with their canon element names", async () => {
    const { db } = commercialClient({
      "from:catalog_bindings": [
        okResponse([
          {
            id: "b1",
            item_id: "0000.01.01-NORTHW-001",
            element_id: "0000.01.01-XOS-001",
            name: "Deck",
            unit_basis: "ea",
            default_unit_price_minor: null,
            currency_code: null,
          },
          {
            id: "b2",
            item_id: "x",
            element_id: "missing",
            name: "Other",
            unit_basis: null,
            default_unit_price_minor: 5,
            currency_code: "USD",
          },
        ]),
        okResponse([]),
        down,
      ],
      "from:xpms:elements": [
        okResponse([{ element_id: "0000.01.01-XOS-001", item: "Stage Deck", urid: "0000.01.01" }]),
        down,
      ],
    });
    const result = await listCatalogBindings(db, "o1");
    expect(result.ok && result.data.map((b) => [b.elementName, b.urid])).toEqual([
      ["Stage Deck", "0000.01.01"],
      [null, null],
    ]);
    expect(await listCatalogBindings(db, "o1")).toEqual({ ok: true, data: [] });
    expect((await listCatalogBindings(db, "o1")).ok).toBe(false);
  });

  it("fails when the element read fails", async () => {
    const { db } = commercialClient({
      "from:catalog_bindings": [
        okResponse([
          {
            id: "b1",
            item_id: "x",
            element_id: "e",
            name: "n",
            unit_basis: null,
            default_unit_price_minor: null,
            currency_code: null,
          },
        ]),
      ],
      "from:xpms:elements": [down],
    });
    expect((await listCatalogBindings(db, "o1")).ok).toBe(false);
  });

  it("creates, edits and removes bindings and vendor products", async () => {
    const { db, calls } = commercialClient({
      "from:catalog_bindings": [
        okResponse({ id: "b1" }),
        okResponse([{ id: "b1" }]),
        okResponse([{ id: "b1" }]),
      ],
      "from:vendor_products": [
        okResponse([
          {
            id: "vp1",
            vendor_id: "v1",
            catalog_binding_id: "b1",
            element_id: null,
            vendor_sku: "SKU-1",
            unit_price_minor: null,
            currency_code: null,
            lead_time_days: 3,
            vendor,
          },
        ]),
        okResponse([]),
        okResponse({ id: "vp1" }),
        okResponse([{ id: "vp1" }]),
      ],
    });
    const input = { name: " Deck ", unitBasis: "", defaultUnitPriceMinor: null, currencyCode: "" };
    expect((await createCatalogBinding(db, "o1", { ...input, elementId: "E" })).ok).toBe(true);
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        name: "Deck",
        unit_basis: null,
        default_unit_price_minor: null,
        currency_code: null,
        org_id: "o1",
        element_id: "E",
      },
    ]);
    expect((await updateCatalogBinding(db, "b1", input)).ok).toBe(true);
    expect((await deleteCatalogBinding(db, "b1")).ok).toBe(true);
    const products = await listVendorProducts(db, { catalogBindingId: "b1" });
    expect(products.ok && products.data[0]?.vendorName).toBe("Harbor Audio");
    await listVendorProducts(db, { vendorId: "v1" });
    expect(calls[4]?.steps).toContainEqual(["eq", ["vendor_id", "v1"]]);
    expect(
      (
        await createVendorProduct(db, {
          vendorId: "v1",
          catalogBindingId: "",
          vendorSku: " SKU-2 ",
          unitPriceMinor: 900,
          currencyCode: "USD",
          leadTimeDays: null,
        })
      ).ok,
    ).toBe(true);
    expect(calls[5]?.steps[0]?.[1]).toEqual([
      {
        vendor_id: "v1",
        catalog_binding_id: null,
        vendor_sku: "SKU-2",
        unit_price_minor: 900,
        currency_code: "USD",
        lead_time_days: null,
      },
    ]);
    expect((await deleteVendorProduct(db, "vp1")).ok).toBe(true);
  });
});
