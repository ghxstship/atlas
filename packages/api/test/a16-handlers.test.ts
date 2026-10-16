/**
 * Contract tests for A16's handlers (Section 18, gate 5): Procurement, Vendors, Knowledge and the
 * Canon extension proposal. Requests run through `contractApp` against the in-memory client and
 * every success is checked against openapi/v1.json with `expectContract`. Refusals (422), hidden
 * rows (404) and stale If-Match (412) are checked where the operation can produce them.
 */
import { describe, expect, it } from "vitest";
import { handlers as canon } from "../src/handlers/canon.ts";
import { handlers as knowledge } from "../src/handlers/knowledge.ts";
import { handlers as procurement } from "../src/handlers/procurement.ts";
import { handlers as vendors } from "../src/handlers/vendors.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(16000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const VENDOR = id(2);
const COUNTERPARTY = id(3);
const RFQ = id(4);
const INVITATION = id(5);
const RESPONSE = id(6);
const RESPONSE_LINE = id(7);
const PO = id(8);
const PO_LINE = id(9);
const CHANGE = id(10);
const RECEIPT = id(11);
const RECEIPT_LINE = id(12);
const INVOICE = id(13);
const MATCH = id(14);
const BINDING = id(15);
const PRODUCT = id(16);
const CLASS = id(17);
const ASSIGNMENT = id(18);
const PREQUAL = id(19);
const COI = id(20);
const SCORECARD = id(21);
const ENTITLEMENT = id(22);
const SOP = id(23);
const ACK = id(24);
const DOCUMENT = id(25);
const VERSION = id(26);
const TERM = id(27);
const SHA = "a".repeat(64);
const STALE = 'W/"MjAyMC0wMS0wMQ"';
const MISSING = id(99);

function find(db: MemoryDb, table: string, key: unknown): Row {
  return db.tables[table]?.find((r) => r["id"] === key) as Row;
}

function world() {
  const db: MemoryDb = memoryDb(
    {
      counterparties: [
        tenantRow(COUNTERPARTY, ORG, {
          organization_id: id(40),
          counterparty_type: "Audio Supply",
        }),
      ],
      vendors: [
        tenantRow(VENDOR, ORG, {
          counterparty_id: COUNTERPARTY,
          vendor_state: "Prospect",
          payment_terms_days: 30,
          default_currency_code: "USD",
        }),
      ],
      vendor_classes: [
        tenantRow(CLASS, ORG, { name: "Audio", std_vendor_class_id: null, description: null }),
      ],
      vendor_class_assignments: [
        tenantRow(ASSIGNMENT, ORG, { vendor_id: VENDOR, vendor_class_id: CLASS }),
      ],
      prequalifications: [
        tenantRow(PREQUAL, ORG, {
          vendor_id: VENDOR,
          scope_note: "Rigging over 2,000 kg.",
          decision: null,
          decided_by: null,
          decided_at: null,
          valid_to: null,
        }),
      ],
      insurance_certificates: [
        tenantRow(COI, ORG, {
          vendor_id: VENDOR,
          insurer: "Example Mutual",
          policy_identifier: "GL-1",
          coverage_type: "General Liability",
          coverage_limit_minor: null,
          currency_code: null,
          valid_from: "2027-01-01",
          valid_to: "2027-12-31",
          document_uri: null,
        }),
      ],
      vendor_scorecards: [
        tenantRow(SCORECARD, ORG, {
          vendor_id: VENDOR,
          project_id: null,
          period_end: "2026-12-31",
          quality_score: 5,
          delivery_score: null,
          safety_score: 4,
          note: null,
        }),
      ],
      sponsor_entitlements: [
        tenantRow(ENTITLEMENT, ORG, {
          project_id: PROJECT,
          counterparty_id: COUNTERPARTY,
          description: "Logo on the main stage scrims.",
          quantity: 4,
          due_on: null,
          fulfilled_at: null,
        }),
      ],
      rfqs: [
        tenantRow(RFQ, ORG, {
          project_id: PROJECT,
          rfq_number: 1,
          title: "Main stage audio package",
          responses_due_at: null,
          rfq_state: "Proposed",
        }),
      ],
      rfq_invitations: [tenantRow(INVITATION, ORG, { rfq_id: RFQ, vendor_id: VENDOR })],
      rfq_responses: [
        tenantRow(RESPONSE, ORG, {
          rfq_id: RFQ,
          vendor_id: VENDOR,
          submitted_at: "2026-10-01T12:00:00.000Z",
          valid_until: null,
        }),
      ],
      rfq_response_lines: [
        tenantRow(RESPONSE_LINE, ORG, {
          rfq_response_id: RESPONSE,
          description: "Line array",
          element_id: null,
          quantity: 4,
          unit_price_minor: null,
          currency_code: "USD",
        }),
      ],
      purchase_orders: [
        tenantRow(PO, ORG, {
          project_id: PROJECT,
          po_number: 7,
          vendor_id: VENDOR,
          rfq_response_id: null,
          currency_code: "USD",
          po_state: "Proposed",
        }),
      ],
      po_lines: [
        tenantRow(PO_LINE, ORG, {
          purchase_order_id: PO,
          line_number: 1,
          description: "Stage deck",
          budget_line_id: null,
          element_id: null,
          quantity: 4,
          unit_basis: null,
          unit_price_minor: 4500,
        }),
      ],
      po_change_orders: [
        tenantRow(CHANGE, ORG, {
          purchase_order_id: PO,
          description: "Add stair units.",
          amount_delta_minor: null,
          po_change_order_state: "Proposed",
        }),
      ],
      goods_receipts: [
        tenantRow(RECEIPT, ORG, {
          purchase_order_id: PO,
          received_at: "2026-10-01T12:00:00.000Z",
          received_by: ME,
          note: null,
        }),
      ],
      receipt_lines: [
        tenantRow(RECEIPT_LINE, ORG, {
          goods_receipt_id: RECEIPT,
          po_line_id: PO_LINE,
          quantity_received: 2,
        }),
      ],
      invoice_matches: [
        tenantRow(MATCH, ORG, {
          invoice_id: INVOICE,
          purchase_order_id: PO,
          goods_receipt_id: RECEIPT,
          resolution_note: null,
          resolved_by: null,
          resolved_at: null,
        }),
      ],
      invoice_match_results: [{ invoice_match_id: MATCH, is_matched: false, variance_minor: 2000 }],
      catalog_bindings: [
        tenantRow(BINDING, ORG, {
          item_id: "0000.01.01-NORTHW-001",
          element_id: "0000.01.01-XOS-001",
          name: "Stage Deck",
          unit_basis: "ea",
          default_unit_price_minor: null,
          currency_code: null,
        }),
      ],
      vendor_products: [
        tenantRow(PRODUCT, ORG, {
          vendor_id: VENDOR,
          catalog_binding_id: BINDING,
          element_id: null,
          vendor_sku: "DSS-1",
          unit_price_minor: null,
          currency_code: null,
          lead_time_days: 14,
        }),
      ],
      sops: [
        tenantRow(SOP, ORG, {
          code: "SOP-001",
          title: "Load in",
          body: "Confirm the dock slot.",
          version: 1,
          published_at: null,
        }),
      ],
      sop_acknowledgments: [
        tenantRow(ACK, ORG, {
          sop_id: SOP,
          person_id: ME,
          sop_version: 1,
          acknowledged_at: "2026-10-01T12:00:00.000Z",
        }),
      ],
      documents: [tenantRow(DOCUMENT, ORG, { title: "Site plan", project_id: null })],
      document_versions: [
        tenantRow(VERSION, ORG, {
          document_id: DOCUMENT,
          version_number: 1,
          storage_uri: "https://files.example.com/a.pdf",
          checksum_sha256: SHA,
        }),
      ],
      verbiage_terms: [
        tenantRow(TERM, ORG, {
          term: "Load In",
          casing_rule: "Title Case",
          definition: "The arrival of gear.",
        }),
      ],
      canon_extension_proposals: [],
    },
    {
      transition_rfq: (args, self) => {
        const r = find(self, "rfqs", args["p_rfq_id"]);
        if (r["rfq_state"] !== args["p_expected"])
          throw refusal("rfq_state_conflict", "Changed first.");
        r["rfq_state"] = args["p_next"];
        return id(70);
      },
      approve_purchase_order: (args, self) => {
        const po = find(self, "purchase_orders", args["p_purchase_order_id"]);
        if (po["po_state"] !== "Proposed")
          throw refusal("purchase_order_state_conflict", "Only a draft.");
        po["po_state"] = "Approved";
        return true;
      },
      transition_purchase_order: (args, self) => {
        const po = find(self, "purchase_orders", args["p_purchase_order_id"]);
        if (po["po_state"] !== args["p_expected"])
          throw refusal("purchase_order_state_conflict", "Changed first.");
        po["po_state"] = args["p_next"];
        return id(71);
      },
      acknowledge_purchase_order: (args, self) => {
        const po = find(self, "purchase_orders", args["p_purchase_order_id"]);
        if (po["po_state"] !== "Sent") throw refusal("po_acknowledge_state", "Only a sent order.");
        return id(72);
      },
      decide_po_change_order: (args, self) => {
        const c = find(self, "po_change_orders", args["p_po_change_order_id"]);
        if (args["p_decision"] === "Approved" && c["amount_delta_minor"] === null) {
          throw refusal("po_change_order_unpriced", "Price it first.");
        }
        c["po_change_order_state"] = args["p_decision"];
        return true;
      },
      transition_vendor: (args, self) => {
        const v = find(self, "vendors", args["p_vendor_id"]);
        if (args["p_next"] === "Active" && v["vendor_state"] === "Prospect") {
          throw refusal("vendor_transition_not_allowed", "Not from Prospect.");
        }
        v["vendor_state"] = args["p_next"];
        return id(73);
      },
      decide_prequalification: (args, self) => {
        const q = find(self, "prequalifications", args["p_prequalification_id"]);
        if (q["decision"] !== null) throw refusal("prequalification_decided", "Final.");
        q["decision"] = args["p_decision"];
        q["decided_by"] = id(80);
        q["decided_at"] = "2026-10-14T12:00:00.000Z";
        q["valid_to"] = args["p_valid_to"] ?? null;
      },
    },
    {
      vendors: { vendor_state: "Prospect", payment_terms_days: null, default_currency_code: null },
      vendor_classes: { std_vendor_class_id: null, description: null },
      prequalifications: { decision: null, decided_by: null, decided_at: null, valid_to: null },
      insurance_certificates: {
        coverage_limit_minor: null,
        currency_code: null,
        document_uri: null,
      },
      vendor_scorecards: {
        project_id: null,
        quality_score: null,
        delivery_score: null,
        safety_score: null,
        note: null,
      },
      sponsor_entitlements: { quantity: null, due_on: null, fulfilled_at: null },
      rfqs: { rfq_number: 2, responses_due_at: null, rfq_state: "Proposed" },
      rfq_responses: { submitted_at: "2026-10-14T12:00:00.000Z", valid_until: null },
      rfq_response_lines: { element_id: null, quantity: 1, unit_price_minor: null },
      purchase_orders: { po_number: 8, rfq_response_id: null, po_state: "Proposed" },
      po_lines: {
        budget_line_id: null,
        element_id: null,
        unit_basis: null,
        unit_price_minor: null,
      },
      po_change_orders: { amount_delta_minor: null, po_change_order_state: "Proposed" },
      goods_receipts: { received_at: "2026-10-14T12:00:00.000Z", received_by: ME, note: null },
      invoice_matches: { resolution_note: null, resolved_by: null, resolved_at: null },
      catalog_bindings: {
        item_id: "0000.01.01-NORTHW-002",
        unit_basis: null,
        default_unit_price_minor: null,
        currency_code: null,
      },
      vendor_products: {
        catalog_binding_id: null,
        element_id: null,
        unit_price_minor: null,
        currency_code: null,
        lead_time_days: null,
      },
      sops: { version: 1, published_at: null },
      sop_acknowledgments: { sop_version: 1, acknowledged_at: "2026-10-14T12:00:00.000Z" },
      documents: { project_id: null },
      document_versions: { version_number: 2 },
    },
  );
  const app = contractApp({ handlers: [procurement, vendors, knowledge, canon], db });
  return { db, http: requests(app) };
}

describe("Procurement contract: table operations", () => {
  it("serves rfqs", async () => {
    const { http } = world();
    const res1 = await success(http.get("/rfqs"));
    await expectContract(res1, "rfqs.list");
    const res2 = await success(http.get(`/rfqs/${RFQ}`));
    await expectContract(res2, "rfqs.get");
    expect((await http.get(`/rfqs/${MISSING}`)).status).toBe(404);
    const res3 = await success(
      http.post("/rfqs", { project_id: PROJECT, title: "Lighting package" }),
    );
    await expectContract(res3, "rfqs.create");
    const res4 = await success(http.patch(`/rfqs/${RFQ}`, { title: "Lighting package v2" }));
    await expectContract(res4, "rfqs.update");
    expect((await http.patch(`/rfqs/${RFQ}`, { title: "Lighting package v2" }, STALE)).status).toBe(
      412,
    );
    const res5 = await success(http.delete(`/rfqs/${RFQ}`));
    await expectContract(res5, "rfqs.delete");
    expect((await http.get(`/rfqs/${RFQ}`)).status).toBe(404);
  });

  it("serves rfqInvitations", async () => {
    const { http } = world();
    const res6 = await success(http.get("/rfq-invitations"));
    await expectContract(res6, "rfqInvitations.list");
    const res7 = await success(http.get(`/rfq-invitations/${INVITATION}`));
    await expectContract(res7, "rfqInvitations.get");
    expect((await http.get(`/rfq-invitations/${MISSING}`)).status).toBe(404);
    const res8 = await success(http.post("/rfq-invitations", { rfq_id: RFQ, vendor_id: id(41) }));
    await expectContract(res8, "rfqInvitations.create");
    const res9 = await success(http.delete(`/rfq-invitations/${INVITATION}`));
    await expectContract(res9, "rfqInvitations.delete");
    expect((await http.get(`/rfq-invitations/${INVITATION}`)).status).toBe(404);
  });

  it("serves rfqResponses", async () => {
    const { http } = world();
    const res10 = await success(http.get("/rfq-responses"));
    await expectContract(res10, "rfqResponses.list");
    const res11 = await success(http.get(`/rfq-responses/${RESPONSE}`));
    await expectContract(res11, "rfqResponses.get");
    expect((await http.get(`/rfq-responses/${MISSING}`)).status).toBe(404);
    // rfqResponses.create records a sealed response through app.record_rfq_response (A33's test).
  });

  it("serves rfqResponseLines", async () => {
    const { http } = world();
    const res13 = await success(http.get("/rfq-response-lines"));
    await expectContract(res13, "rfqResponseLines.list");
    const res14 = await success(http.get(`/rfq-response-lines/${RESPONSE_LINE}`));
    await expectContract(res14, "rfqResponseLines.get");
    expect((await http.get(`/rfq-response-lines/${MISSING}`)).status).toBe(404);
    const res15 = await success(
      http.post("/rfq-response-lines", {
        rfq_response_id: RESPONSE,
        description: "Delay towers",
        quantity: 2,
        unit_price_minor: null,
        currency_code: "USD",
      }),
    );
    await expectContract(res15, "rfqResponseLines.create");
    const res16 = await success(
      http.patch(`/rfq-response-lines/${RESPONSE_LINE}`, { unit_price_minor: 120000 }),
    );
    await expectContract(res16, "rfqResponseLines.update");
    expect(
      (
        await http.patch(
          `/rfq-response-lines/${RESPONSE_LINE}`,
          { unit_price_minor: 120000 },
          STALE,
        )
      ).status,
    ).toBe(412);
    const res17 = await success(http.delete(`/rfq-response-lines/${RESPONSE_LINE}`));
    await expectContract(res17, "rfqResponseLines.delete");
    expect((await http.get(`/rfq-response-lines/${RESPONSE_LINE}`)).status).toBe(404);
  });

  it("serves purchaseOrders", async () => {
    const { http } = world();
    const res18 = await success(http.get("/purchase-orders"));
    await expectContract(res18, "purchaseOrders.list");
    const res19 = await success(http.get(`/purchase-orders/${PO}`));
    await expectContract(res19, "purchaseOrders.get");
    expect((await http.get(`/purchase-orders/${MISSING}`)).status).toBe(404);
    const res20 = await success(
      http.post("/purchase-orders", {
        project_id: PROJECT,
        vendor_id: VENDOR,
        currency_code: "USD",
      }),
    );
    await expectContract(res20, "purchaseOrders.create");
    const res21 = await success(
      http.patch(`/purchase-orders/${PO}`, { rfq_response_id: RESPONSE }),
    );
    await expectContract(res21, "purchaseOrders.update");
    expect(
      (await http.patch(`/purchase-orders/${PO}`, { rfq_response_id: RESPONSE }, STALE)).status,
    ).toBe(412);
  });

  it("serves poLines", async () => {
    const { http } = world();
    const res22 = await success(http.get("/po-lines"));
    await expectContract(res22, "poLines.list");
    const res23 = await success(http.get(`/po-lines/${PO_LINE}`));
    await expectContract(res23, "poLines.get");
    expect((await http.get(`/po-lines/${MISSING}`)).status).toBe(404);
    const res24 = await success(
      http.post("/po-lines", {
        purchase_order_id: PO,
        description: "Stairs",
        quantity: 2,
        unit_price_minor: null,
      }),
    );
    await expectContract(res24, "poLines.create");
    const res25 = await success(http.patch(`/po-lines/${PO_LINE}`, { unit_price_minor: 9000 }));
    await expectContract(res25, "poLines.update");
    expect(
      (await http.patch(`/po-lines/${PO_LINE}`, { unit_price_minor: 9000 }, STALE)).status,
    ).toBe(412);
    const res26 = await success(http.delete(`/po-lines/${PO_LINE}`));
    await expectContract(res26, "poLines.delete");
    expect((await http.get(`/po-lines/${PO_LINE}`)).status).toBe(404);
  });

  it("serves poChangeOrders", async () => {
    const { http } = world();
    const res27 = await success(http.get("/po-change-orders"));
    await expectContract(res27, "poChangeOrders.list");
    const res28 = await success(http.get(`/po-change-orders/${CHANGE}`));
    await expectContract(res28, "poChangeOrders.get");
    expect((await http.get(`/po-change-orders/${MISSING}`)).status).toBe(404);
    const res29 = await success(
      http.post("/po-change-orders", {
        purchase_order_id: PO,
        description: "Add skirting.",
        amount_delta_minor: null,
      }),
    );
    await expectContract(res29, "poChangeOrders.create");
    const res30 = await success(
      http.patch(`/po-change-orders/${CHANGE}`, { amount_delta_minor: 5000 }),
    );
    await expectContract(res30, "poChangeOrders.update");
    expect(
      (await http.patch(`/po-change-orders/${CHANGE}`, { amount_delta_minor: 5000 }, STALE)).status,
    ).toBe(412);
  });

  it("serves goodsReceipts", async () => {
    const { http } = world();
    const res31 = await success(http.get("/goods-receipts"));
    await expectContract(res31, "goodsReceipts.list");
    const res32 = await success(http.get(`/goods-receipts/${RECEIPT}`));
    await expectContract(res32, "goodsReceipts.get");
    expect((await http.get(`/goods-receipts/${MISSING}`)).status).toBe(404);
    const res33 = await success(
      http.post("/goods-receipts", { purchase_order_id: PO, note: "Arrived dry." }),
    );
    await expectContract(res33, "goodsReceipts.create");
  });

  it("serves receiptLines", async () => {
    const { http } = world();
    const res34 = await success(http.get("/receipt-lines"));
    await expectContract(res34, "receiptLines.list");
    const res35 = await success(http.get(`/receipt-lines/${RECEIPT_LINE}`));
    await expectContract(res35, "receiptLines.get");
    expect((await http.get(`/receipt-lines/${MISSING}`)).status).toBe(404);
    const res36 = await success(
      http.post("/receipt-lines", {
        goods_receipt_id: RECEIPT,
        po_line_id: PO_LINE,
        quantity_received: 1,
      }),
    );
    await expectContract(res36, "receiptLines.create");
  });

  it("serves invoiceMatches", async () => {
    const { http } = world();
    const res37 = await success(http.get("/invoice-matches"));
    await expectContract(res37, "invoiceMatches.list");
    const res38 = await success(http.get(`/invoice-matches/${MATCH}`));
    await expectContract(res38, "invoiceMatches.get");
    expect((await http.get(`/invoice-matches/${MISSING}`)).status).toBe(404);
    const res39 = await success(
      http.post("/invoice-matches", {
        invoice_id: id(42),
        purchase_order_id: PO,
        goods_receipt_id: id(43),
      }),
    );
    await expectContract(res39, "invoiceMatches.create");
  });

  it("serves catalogBindings", async () => {
    const { http } = world();
    const res40 = await success(http.get("/catalog-bindings"));
    await expectContract(res40, "catalogBindings.list");
    const res41 = await success(http.get(`/catalog-bindings/${BINDING}`));
    await expectContract(res41, "catalogBindings.get");
    expect((await http.get(`/catalog-bindings/${MISSING}`)).status).toBe(404);
    const res42 = await success(
      http.post("/catalog-bindings", {
        element_id: "0000.01.01-XOS-002",
        name: "Stage Stair",
        unit_basis: "ea",
      }),
    );
    await expectContract(res42, "catalogBindings.create");
    const res43 = await success(
      http.patch(`/catalog-bindings/${BINDING}`, {
        default_unit_price_minor: 4500,
        currency_code: "USD",
      }),
    );
    await expectContract(res43, "catalogBindings.update");
    expect(
      (
        await http.patch(
          `/catalog-bindings/${BINDING}`,
          { default_unit_price_minor: 4500, currency_code: "USD" },
          STALE,
        )
      ).status,
    ).toBe(412);
    const res44 = await success(http.delete(`/catalog-bindings/${BINDING}`));
    await expectContract(res44, "catalogBindings.delete");
    expect((await http.get(`/catalog-bindings/${BINDING}`)).status).toBe(404);
  });

  it("serves vendorProducts", async () => {
    const { http } = world();
    const res45 = await success(http.get("/vendor-products"));
    await expectContract(res45, "vendorProducts.list");
    const res46 = await success(http.get(`/vendor-products/${PRODUCT}`));
    await expectContract(res46, "vendorProducts.get");
    expect((await http.get(`/vendor-products/${MISSING}`)).status).toBe(404);
    const res47 = await success(
      http.post("/vendor-products", {
        vendor_id: VENDOR,
        vendor_sku: "DSS-2",
        catalog_binding_id: BINDING,
      }),
    );
    await expectContract(res47, "vendorProducts.create");
    const res48 = await success(
      http.patch(`/vendor-products/${PRODUCT}`, { unit_price_minor: 5000, currency_code: "USD" }),
    );
    await expectContract(res48, "vendorProducts.update");
    expect(
      (
        await http.patch(
          `/vendor-products/${PRODUCT}`,
          { unit_price_minor: 5000, currency_code: "USD" },
          STALE,
        )
      ).status,
    ).toBe(412);
    const res49 = await success(http.delete(`/vendor-products/${PRODUCT}`));
    await expectContract(res49, "vendorProducts.delete");
    expect((await http.get(`/vendor-products/${PRODUCT}`)).status).toBe(404);
  });

  it("numbers a new PO line after the last one", async () => {
    const { http } = world();
    const res50 = await success(
      http.post("/po-lines", { purchase_order_id: PO, description: "Skirting", quantity: 1 }),
    );
    const made = (await expectContract(res50, "poLines.create")) as Row;
    expect(made["line_number"]).toBe(2);
  });

  it("derives the match variance and agreement", async () => {
    const { http } = world();
    const res51 = await success(http.get(`/invoice-matches/${MATCH}`));
    const match = (await expectContract(res51, "invoiceMatches.get")) as Row;
    expect(match["variance_minor"]).toBe(2000);
    expect(match["matched"]).toBe(false);
  });
});

describe("Procurement contract: lifecycle actions", () => {
  it("issues and transitions an RFQ with compare-and-set", async () => {
    const { http } = world();
    const res52 = await success(http.post(`/rfqs/${RFQ}/issue`));
    const issued = (await expectContract(res52, "rfqs.issue")) as Row;
    expect(issued["rfq_state"]).toBe("Issued");
    const res53 = await success(
      http.post(`/rfqs/${RFQ}/transitions`, {
        expected_state: "Issued",
        to_state: "Closed",
        reason: "Deadline.",
      }),
    );
    const closed = (await expectContract(res53, "rfqs.transition")) as Row;
    expect(closed["rfq_state"]).toBe("Closed");
    const stale = await http.post(`/rfqs/${RFQ}/transitions`, {
      expected_state: "Issued",
      to_state: "Awarded",
    });
    expect(stale.status).toBe(422);
    expect((await http.post(`/rfqs/${MISSING}/issue`)).status).toBe(404);
  });

  it("approves, sends and acknowledges a purchase order", async () => {
    const { http, db } = world();
    const res54 = await success(
      http.post(`/purchase-orders/${PO}/approve`, { reason: "Within budget." }),
    );
    const approved = (await expectContract(res54, "purchaseOrders.approve")) as Row;
    expect(approved["po_state"]).toBe("Approved");
    expect((await http.post(`/purchase-orders/${PO}/approve`, { reason: "Again." })).status).toBe(
      422,
    );
    expect((await http.post(`/purchase-orders/${PO}/acknowledge`)).status).toBe(422);
    const res55 = await success(
      http.post(`/purchase-orders/${PO}/transitions`, {
        expected_state: "Approved",
        to_state: "Sent",
        reason: "Emailed.",
      }),
    );
    const sent = (await expectContract(res55, "purchaseOrders.transition")) as Row;
    expect(sent["po_state"]).toBe("Sent");
    const res56 = await success(http.post(`/purchase-orders/${PO}/acknowledge`));
    await expectContract(res56, "purchaseOrders.acknowledge");
    expect(db.calls.map((c) => c.name)).toContain("acknowledge_purchase_order");
  });

  it("refuses an unpriced change order, then rejects it", async () => {
    const { http } = world();
    const unpriced = await http.post(`/po-change-orders/${CHANGE}/approve`, { reason: "Go." });
    expect(unpriced.status).toBe(422);
    expect(((await unpriced.json()) as Row)["rule"]).toBe("po_change_order_unpriced");
    const res57 = await success(
      http.post(`/po-change-orders/${CHANGE}/reject`, { reason: "Not needed." }),
    );
    const rejected = (await expectContract(res57, "poChangeOrders.reject")) as Row;
    expect(rejected["po_change_order_state"]).toBe("Rejected");
  });

  it("approves a priced change order", async () => {
    const { http, db } = world();
    find(db, "po_change_orders", CHANGE)["amount_delta_minor"] = 5000;
    const res58 = await success(
      http.post(`/po-change-orders/${CHANGE}/approve`, { reason: "Agreed." }),
    );
    const approved = (await expectContract(res58, "poChangeOrders.approve")) as Row;
    expect(approved["po_change_order_state"]).toBe("Approved");
  });

  it("accepts a mismatch with a note", async () => {
    const { http } = world();
    const res59 = await success(
      http.post(`/invoice-matches/${MATCH}/resolve`, { resolution_note: "Freight agreed." }),
    );
    const resolved = (await expectContract(res59, "invoiceMatches.resolve")) as Row;
    expect(resolved["resolution_note"]).toBe("Freight agreed.");
  });
});

describe("Vendors contract", () => {
  it("serves vendors", async () => {
    const { http } = world();
    const res60 = await success(http.get("/vendors"));
    await expectContract(res60, "vendors.list");
    const res61 = await success(http.get(`/vendors/${VENDOR}`));
    await expectContract(res61, "vendors.get");
    expect((await http.get(`/vendors/${MISSING}`)).status).toBe(404);
    const res62 = await success(http.post("/vendors", { counterparty_id: id(44) }));
    await expectContract(res62, "vendors.create");
    const res63 = await success(http.patch(`/vendors/${VENDOR}`, { payment_terms_days: 45 }));
    await expectContract(res63, "vendors.update");
    expect((await http.patch(`/vendors/${VENDOR}`, { payment_terms_days: 45 }, STALE)).status).toBe(
      412,
    );
    const res64 = await success(http.delete(`/vendors/${VENDOR}`));
    await expectContract(res64, "vendors.delete");
    expect((await http.get(`/vendors/${VENDOR}`)).status).toBe(404);
  });

  it("serves vendorClasses", async () => {
    const { http } = world();
    const res65 = await success(http.get("/vendor-classes"));
    await expectContract(res65, "vendorClasses.list");
    const res66 = await success(http.get(`/vendor-classes/${CLASS}`));
    await expectContract(res66, "vendorClasses.get");
    expect((await http.get(`/vendor-classes/${MISSING}`)).status).toBe(404);
    const res67 = await success(http.post("/vendor-classes", { name: "Staging" }));
    await expectContract(res67, "vendorClasses.create");
    const res68 = await success(
      http.patch(`/vendor-classes/${CLASS}`, { description: "Decks and risers." }),
    );
    await expectContract(res68, "vendorClasses.update");
    expect(
      (await http.patch(`/vendor-classes/${CLASS}`, { description: "Decks and risers." }, STALE))
        .status,
    ).toBe(412);
    const res69 = await success(http.delete(`/vendor-classes/${CLASS}`));
    await expectContract(res69, "vendorClasses.delete");
    expect((await http.get(`/vendor-classes/${CLASS}`)).status).toBe(404);
  });

  it("serves vendorClassAssignments", async () => {
    const { http } = world();
    const res70 = await success(http.get("/vendor-class-assignments"));
    await expectContract(res70, "vendorClassAssignments.list");
    const res71 = await success(http.get(`/vendor-class-assignments/${ASSIGNMENT}`));
    await expectContract(res71, "vendorClassAssignments.get");
    expect((await http.get(`/vendor-class-assignments/${MISSING}`)).status).toBe(404);
    const res72 = await success(
      http.post("/vendor-class-assignments", { vendor_id: VENDOR, vendor_class_id: id(45) }),
    );
    await expectContract(res72, "vendorClassAssignments.create");
    const res73 = await success(http.delete(`/vendor-class-assignments/${ASSIGNMENT}`));
    await expectContract(res73, "vendorClassAssignments.delete");
    expect((await http.get(`/vendor-class-assignments/${ASSIGNMENT}`)).status).toBe(404);
  });

  it("serves prequalifications", async () => {
    const { http } = world();
    const res74 = await success(http.get("/prequalifications"));
    await expectContract(res74, "prequalifications.list");
    const res75 = await success(http.get(`/prequalifications/${PREQUAL}`));
    await expectContract(res75, "prequalifications.get");
    expect((await http.get(`/prequalifications/${MISSING}`)).status).toBe(404);
    const res76 = await success(
      http.post("/prequalifications", { vendor_id: VENDOR, scope_note: "Flown audio." }),
    );
    await expectContract(res76, "prequalifications.create");
    const res77 = await success(
      http.patch(`/prequalifications/${PREQUAL}`, { scope_note: "Flown audio up to 1,500 kg." }),
    );
    await expectContract(res77, "prequalifications.update");
    expect(
      (
        await http.patch(
          `/prequalifications/${PREQUAL}`,
          { scope_note: "Flown audio up to 1,500 kg." },
          STALE,
        )
      ).status,
    ).toBe(412);
    const res78 = await success(http.delete(`/prequalifications/${PREQUAL}`));
    await expectContract(res78, "prequalifications.delete");
    expect((await http.get(`/prequalifications/${PREQUAL}`)).status).toBe(404);
  });

  it("serves insuranceCertificates", async () => {
    const { http } = world();
    const res79 = await success(http.get("/insurance-certificates"));
    await expectContract(res79, "insuranceCertificates.list");
    const res80 = await success(http.get(`/insurance-certificates/${COI}`));
    await expectContract(res80, "insuranceCertificates.get");
    expect((await http.get(`/insurance-certificates/${MISSING}`)).status).toBe(404);
    const res81 = await success(
      http.post("/insurance-certificates", {
        vendor_id: VENDOR,
        insurer: "Example Mutual",
        policy_identifier: "WC-1",
        coverage_type: "Workers Compensation",
        valid_from: "2027-01-01",
        valid_to: "2027-12-31",
      }),
    );
    await expectContract(res81, "insuranceCertificates.create");
    const res82 = await success(
      http.patch(`/insurance-certificates/${COI}`, {
        coverage_limit_minor: 100000000,
        currency_code: "USD",
      }),
    );
    await expectContract(res82, "insuranceCertificates.update");
    expect(
      (
        await http.patch(
          `/insurance-certificates/${COI}`,
          { coverage_limit_minor: 100000000, currency_code: "USD" },
          STALE,
        )
      ).status,
    ).toBe(412);
    const res83 = await success(http.delete(`/insurance-certificates/${COI}`));
    await expectContract(res83, "insuranceCertificates.delete");
    expect((await http.get(`/insurance-certificates/${COI}`)).status).toBe(404);
  });

  it("serves vendorScorecards", async () => {
    const { http } = world();
    const res84 = await success(http.get("/vendor-scorecards"));
    await expectContract(res84, "vendorScorecards.list");
    const res85 = await success(http.get(`/vendor-scorecards/${SCORECARD}`));
    await expectContract(res85, "vendorScorecards.get");
    expect((await http.get(`/vendor-scorecards/${MISSING}`)).status).toBe(404);
    const res86 = await success(
      http.post("/vendor-scorecards", {
        vendor_id: VENDOR,
        period_end: "2027-03-31",
        quality_score: 4,
      }),
    );
    await expectContract(res86, "vendorScorecards.create");
    const res87 = await success(
      http.patch(`/vendor-scorecards/${SCORECARD}`, { delivery_score: 3 }),
    );
    await expectContract(res87, "vendorScorecards.update");
    expect(
      (await http.patch(`/vendor-scorecards/${SCORECARD}`, { delivery_score: 3 }, STALE)).status,
    ).toBe(412);
    const res88 = await success(http.delete(`/vendor-scorecards/${SCORECARD}`));
    await expectContract(res88, "vendorScorecards.delete");
    expect((await http.get(`/vendor-scorecards/${SCORECARD}`)).status).toBe(404);
  });

  it("serves sponsorEntitlements", async () => {
    const { http } = world();
    const res89 = await success(http.get("/sponsor-entitlements"));
    await expectContract(res89, "sponsorEntitlements.list");
    const res90 = await success(http.get(`/sponsor-entitlements/${ENTITLEMENT}`));
    await expectContract(res90, "sponsorEntitlements.get");
    expect((await http.get(`/sponsor-entitlements/${MISSING}`)).status).toBe(404);
    const res91 = await success(
      http.post("/sponsor-entitlements", {
        project_id: PROJECT,
        counterparty_id: COUNTERPARTY,
        description: "Naming rights on the VIP terrace.",
      }),
    );
    await expectContract(res91, "sponsorEntitlements.create");
    const res92 = await success(
      http.patch(`/sponsor-entitlements/${ENTITLEMENT}`, { due_on: "2027-03-12" }),
    );
    await expectContract(res92, "sponsorEntitlements.update");
    expect(
      (await http.patch(`/sponsor-entitlements/${ENTITLEMENT}`, { due_on: "2027-03-12" }, STALE))
        .status,
    ).toBe(412);
    const res93 = await success(http.delete(`/sponsor-entitlements/${ENTITLEMENT}`));
    await expectContract(res93, "sponsorEntitlements.delete");
    expect((await http.get(`/sponsor-entitlements/${ENTITLEMENT}`)).status).toBe(404);
  });

  it("reads the counterparty type from the counterparty", async () => {
    const { http } = world();
    const res94 = await success(http.get(`/vendors/${VENDOR}`));
    const vendor = (await expectContract(res94, "vendors.get")) as Row;
    expect(vendor["counterparty_type"]).toBe("Audio Supply");
  });

  it("moves a vendor along its lifecycle and refuses a skipped step", async () => {
    const { http } = world();
    const skipped = await http.post(`/vendors/${VENDOR}/transitions`, {
      expected_state: "Prospect",
      to_state: "Active",
    });
    expect(skipped.status).toBe(422);
    const res95 = await success(
      http.post(`/vendors/${VENDOR}/transitions`, {
        expected_state: "Prospect",
        to_state: "Onboarded",
        reason: "Paperwork in.",
      }),
    );
    const onboarded = (await expectContract(res95, "vendors.transition")) as Row;
    expect(onboarded["vendor_state"]).toBe("Onboarded");
  });

  it("decides a prequalification once", async () => {
    const { http } = world();
    const res96 = await success(
      http.post(`/prequalifications/${PREQUAL}/decide`, {
        decision: "Approved",
        valid_to: "2027-12-31",
      }),
    );
    const decided = (await expectContract(res96, "prequalifications.decide")) as Row;
    expect(decided["decision"]).toBe("Approved");
    expect(
      (await http.post(`/prequalifications/${PREQUAL}/decide`, { decision: "Rejected" })).status,
    ).toBe(422);
  });

  it("marks an entitlement fulfilled and owed again", async () => {
    const { http } = world();
    const res97 = await success(http.post(`/sponsor-entitlements/${ENTITLEMENT}/fulfill`));
    const done = (await expectContract(res97, "sponsorEntitlements.fulfill")) as Row;
    expect(done["fulfilled_at"]).not.toBeNull();
    const res98 = await success(http.post(`/sponsor-entitlements/${ENTITLEMENT}/reopen`));
    const owed = (await expectContract(res98, "sponsorEntitlements.reopen")) as Row;
    expect(owed["fulfilled_at"]).toBeNull();
  });
});

describe("Knowledge contract", () => {
  it("serves sops", async () => {
    const { http } = world();
    const res99 = await success(http.get("/sops"));
    await expectContract(res99, "sops.list");
    const res100 = await success(http.get(`/sops/${SOP}`));
    await expectContract(res100, "sops.get");
    expect((await http.get(`/sops/${MISSING}`)).status).toBe(404);
    const res101 = await success(
      http.post("/sops", { code: "SOP-002", title: "Hot works", body: "Get the permit first." }),
    );
    await expectContract(res101, "sops.create");
    const res102 = await success(http.patch(`/sops/${SOP}`, { title: "Hot works permit check" }));
    await expectContract(res102, "sops.update");
    expect(
      (await http.patch(`/sops/${SOP}`, { title: "Hot works permit check" }, STALE)).status,
    ).toBe(412);
    const res103 = await success(http.delete(`/sops/${SOP}`));
    await expectContract(res103, "sops.delete");
    expect((await http.get(`/sops/${SOP}`)).status).toBe(404);
  });

  it("serves sopAcknowledgments", async () => {
    const { http } = world();
    const res104 = await success(http.get("/sop-acknowledgments"));
    await expectContract(res104, "sopAcknowledgments.list");
    const res105 = await success(http.get(`/sop-acknowledgments/${ACK}`));
    await expectContract(res105, "sopAcknowledgments.get");
    expect((await http.get(`/sop-acknowledgments/${MISSING}`)).status).toBe(404);
    const res106 = await success(http.post("/sop-acknowledgments", { sop_id: SOP }));
    await expectContract(res106, "sopAcknowledgments.create");
  });

  it("serves documents", async () => {
    const { http } = world();
    const res107 = await success(http.get("/documents"));
    await expectContract(res107, "documents.list");
    const res108 = await success(http.get(`/documents/${DOCUMENT}`));
    await expectContract(res108, "documents.get");
    expect((await http.get(`/documents/${MISSING}`)).status).toBe(404);
    const res109 = await success(http.post("/documents", { title: "Rigging plot" }));
    await expectContract(res109, "documents.create");
    const res110 = await success(
      http.patch(`/documents/${DOCUMENT}`, { title: "Rigging plot v2" }),
    );
    await expectContract(res110, "documents.update");
    expect(
      (await http.patch(`/documents/${DOCUMENT}`, { title: "Rigging plot v2" }, STALE)).status,
    ).toBe(412);
    const res111 = await success(http.delete(`/documents/${DOCUMENT}`));
    await expectContract(res111, "documents.delete");
    expect((await http.get(`/documents/${DOCUMENT}`)).status).toBe(404);
  });

  it("serves documentVersions", async () => {
    const { http } = world();
    const res112 = await success(http.get("/document-versions"));
    await expectContract(res112, "documentVersions.list");
    const res113 = await success(http.get(`/document-versions/${VERSION}`));
    await expectContract(res113, "documentVersions.get");
    expect((await http.get(`/document-versions/${MISSING}`)).status).toBe(404);
    const res114 = await success(
      http.post("/document-versions", {
        document_id: DOCUMENT,
        storage_uri: "https://files.example.com/b.pdf",
        checksum_sha256: SHA,
      }),
    );
    await expectContract(res114, "documentVersions.create");
  });

  it("serves verbiageTerms", async () => {
    const { http } = world();
    const res115 = await success(http.get("/verbiage-terms"));
    await expectContract(res115, "verbiageTerms.list");
    const res116 = await success(http.get(`/verbiage-terms/${TERM}`));
    await expectContract(res116, "verbiageTerms.get");
    expect((await http.get(`/verbiage-terms/${MISSING}`)).status).toBe(404);
    const res117 = await success(
      http.post("/verbiage-terms", {
        term: "Strike",
        casing_rule: "Sentence case",
        definition: "The removal of gear.",
      }),
    );
    await expectContract(res117, "verbiageTerms.create");
    const res118 = await success(
      http.patch(`/verbiage-terms/${TERM}`, { definition: "The removal of equipment." }),
    );
    await expectContract(res118, "verbiageTerms.update");
    expect(
      (
        await http.patch(
          `/verbiage-terms/${TERM}`,
          { definition: "The removal of equipment." },
          STALE,
        )
      ).status,
    ).toBe(412);
    const res119 = await success(http.delete(`/verbiage-terms/${TERM}`));
    await expectContract(res119, "verbiageTerms.delete");
    expect((await http.get(`/verbiage-terms/${TERM}`)).status).toBe(404);
  });

  it("acknowledges as the signed-in person", async () => {
    const { http } = world();
    const res120 = await success(http.post("/sop-acknowledgments", { sop_id: SOP }));
    const ack = (await expectContract(res120, "sopAcknowledgments.create")) as Row;
    expect(ack["person_id"]).toBe(ME);
  });

  it("publishes an SOP", async () => {
    const { http } = world();
    const res121 = await success(http.post(`/sops/${SOP}/publish`));
    const published = (await expectContract(res121, "sops.publish")) as Row;
    expect(published["published_at"]).not.toBeNull();
    expect((await http.post(`/sops/${MISSING}/publish`)).status).toBe(404);
  });
});

describe("Canon contract: org extension proposals", () => {
  it("records a proposal for the caller's org and never writes canon", async () => {
    const { http, db } = world();
    const res122 = await success(
      http.post("/canon/extensions/propose", {
        proposed_kind: "discipline",
        proposed_code: "5000.90",
        proposed_label: "Drone Light Shows",
        rationale: "Most outdoor shows include one.",
      }),
    );
    const made = (await expectContract(res122, "canonExtensions.propose")) as Row;
    expect(made["intake_state"]).toBe("Proposed");
    const row = db.tables["canon_extension_proposals"]?.[0] as Row;
    expect(row).toMatchObject({
      org_id: ORG,
      extension_level: "Discipline",
      parent_code: "5000",
      proposed_code: "5000.90",
    });
    expect(db.writes.every((w) => !w.table.startsWith("xpms"))).toBe(true);
    const bad = await http.post("/canon/extensions/propose", {
      proposed_kind: "element",
      proposed_code: "5000.90.01",
      proposed_label: "Thing",
      rationale: "Because.",
    });
    expect(bad.status).toBe(422);
  });
});
