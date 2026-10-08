/**
 * Finance, Procurement and Vendors (Sections 3.11, 4.2 and 7.4).
 * Every money field is integer minor units, nullable where unpriced; totals carry `unpriced_count`.
 */
import { z } from "zod";
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import { AccountingPeriodState } from "../common/enums.ts";
import { MoneyTotal } from "../common/envelope.ts";
import { defineResource } from "../common/resource.ts";

// Finance

export const Budget = defineResource({
  name: "Budget",
  table: "app.budgets",
  description: "A project budget, structured as a chart of accounts by department and discipline.",
  immutable: ["project_id"],
  serverSet: ["budget_state"],
  fields: {
    project_id: f.ref("project"),
    name: f.text("Budget name.", "Gate 3 Budget"),
    currency: f.currency(),
    budget_state: f.stateLabel("Budget state.", "Active"),
    contingency_percent: f.quantity("Contingency as a percent of scope.", 5).nullable(),
  },
});

export const BudgetLine = defineResource({
  name: "BudgetLine",
  table: "app.budget_lines",
  description:
    "A budget line. A blank unit price is unpriced; zero is a claim. Fee and Contingency are line types.",
  immutable: ["budget_id"],
  serverSet: ["line_total_minor", "account_code"],
  fields: {
    budget_id: f.ref("budget"),
    account_code: c.GlAccountCode,
    cost_center_id: f.ref("cost center"),
    urid: c.UridAtAnyGrain,
    xyz: c.Xyz,
    xyz_basis: f.text("Basis for the XYZ tag.", "Rented inventory"),
    line_type: c.LineType,
    grade: c.Grade.nullable(),
    element_id: c.ItemId.nullable(),
    description: f.text("Line description.", "Stage deck rental"),
    quantity: f.quantity("Quantity.", 24).nullable(),
    unit: c.UnitCode.nullable(),
    unit_price_minor: f.money("Unit price.", 4500),
    line_total_minor: f.money("Line total, generated from quantity and unit price.", 108000),
    currency: f.currency(),
    line_state: c.SharedState,
  },
});

export const BudgetSummary = defineResource({
  name: "BudgetSummary",
  table: "app.v_budget_summary",
  description: "Budget totals. Unpriced lines stay out of the sum and are counted.",
  base: "view",
  fields: {
    budget_id: f.ref("budget"),
    estimate: MoneyTotal,
    committed: MoneyTotal,
    actual: MoneyTotal,
    variance: MoneyTotal,
  },
});

export const Expense = defineResource({
  name: "Expense",
  table: "app.expenses",
  description:
    "An expense. One expense posts to exactly one budget line; the submitter cannot approve it.",
  immutable: ["budget_line_id"],
  serverSet: ["expense_state", "submitted_by"],
  fields: {
    budget_line_id: f.ref("budget line"),
    submitted_by: f.ref("submitter"),
    description: f.text("Expense description.", "Gaffer tape, 12 rolls"),
    amount_minor: f.money("Expense amount.", 14388),
    currency: f.currency(),
    incurred_on: f.date("When it was incurred."),
    receipt_document_id: f.ref("receipt").nullable(),
    expense_state: c.SharedState,
  },
});

export const ContingencyDraw = defineResource({
  name: "ContingencyDraw",
  table: "app.contingency_draws",
  description: "A draw from a contingency line onto another budget line.",
  immutable: ["from_budget_line_id", "to_budget_line_id"],
  fields: {
    from_budget_line_id: f.ref("contingency budget line"),
    to_budget_line_id: f.ref("receiving budget line"),
    amount_minor: f.money("Amount drawn.", 250000),
    currency: f.currency(),
    reason: f.longText(
      "Why contingency is drawn.",
      "Added wind bracing after the engineering review.",
    ),
  },
});

export const ChangeOrder = defineResource({
  name: "ChangeOrder",
  table: "app.change_orders",
  description:
    "A change order. An unpriced change order cannot be stored at zero; its requester cannot price and approve it alone.",
  immutable: ["project_id"],
  serverSet: ["change_order_state", "total", "requested_by"],
  fields: {
    project_id: f.ref("project"),
    title: f.text("Change order title.", "Add Second Bar"),
    description: f.longText(
      "What changes and why.",
      "Client added a second bar at the north lawn.",
    ),
    requested_by: f.ref("requester"),
    change_order_state: c.SharedState,
    total: MoneyTotal,
  },
});

export const ChangeOrderLine = defineResource({
  name: "ChangeOrderLine",
  table: "app.change_order_lines",
  description: "A line of a change order.",
  immutable: ["change_order_id"],
  fields: {
    change_order_id: f.ref("change order"),
    budget_line_id: f.ref("affected budget line").nullable(),
    urid: c.UridAtAnyGrain,
    description: f.text("Line description.", "Bar build and dressing"),
    amount_minor: f.money("Line amount; null when unpriced.", 1200000),
    currency: f.currency(),
  },
});

export const AccountingPeriod = defineResource({
  name: "AccountingPeriod",
  table: "app.accounting_periods",
  description:
    "An accounting period. A closed period refuses postings; an open period cannot become Audited without passing through Closed.",
  serverSet: ["accounting_period_state"],
  fields: {
    starts_on: f.date("First day."),
    ends_on: f.date("Last day."),
    accounting_period_state: AccountingPeriodState,
  },
});

export const JournalEntry = defineResource({
  name: "JournalEntry",
  table: "app.journal_entries",
  description: "A journal entry. The preparer cannot post it.",
  serverSet: ["journal_state", "posted_at", "posted_by"],
  fields: {
    accounting_period_id: f.ref("accounting period"),
    entry_date: f.date("Entry date."),
    memo: f.text("Memo.", "Reclass staging rental"),
    journal_state: c.SharedState,
    posted_at: f.instant("When it was posted.").nullable(),
    posted_by: f.ref("poster").nullable(),
  },
});

export const JournalLine = defineResource({
  name: "JournalLine",
  table: "app.journal_lines",
  description: "A line of a journal entry.",
  immutable: ["journal_entry_id"],
  fields: {
    journal_entry_id: f.ref("journal entry"),
    account_code: c.GlAccountCode,
    cost_center_id: f.ref("cost center"),
    urid: c.UridAtAnyGrain.nullable(),
    amount_minor: f.money("Signed amount; negative for credits.", -45000),
    currency: f.currency(),
  },
});

export const PostingLine = defineResource({
  name: "PostingLine",
  table: "app.posting_lines",
  description:
    "A Universal Posting Line (Bible tab 36): the one export shape, projected to every accounting platform.",
  serverSet: [
    "date",
    "account_code",
    "cost_center_id",
    "urid",
    "vendor_id",
    "item_id",
    "description",
    "quantity",
    "unit_basis",
    "amount",
    "tax_type",
    "currency",
    "external_ref",
    "line_state",
  ],
  fields: {
    date: f.date("Date the cost or revenue is recognized."),
    account_code: c.GlAccountCode,
    cost_center_id: c.CostCenterCode,
    urid: c.UridAtAnyGrain,
    vendor_id: f.ref("vendor organization; null for revenue").nullable(),
    item_id: c.ItemId.nullable(),
    description: f.text(
      "Sentence-case line description.",
      "Stage deck rental for opening weekend.",
    ),
    quantity: f.quantity("Quantity.", 24).nullable(),
    unit_basis: c.UnitCode.nullable(),
    amount: f.money("Signed amount; negative for credits.", 108000),
    tax_type: c.TaxType,
    currency: f.currency(),
    external_ref: f
      .text("Invoice, card transaction or record identifier.", "INV-2026-0042")
      .nullable(),
    line_state: c.SharedState,
  },
});

export const PostingExportRequest = z
  .object({
    target: z.enum(["xero", "quickbooks", "netsuite", "ramp"]).meta({
      description: "Accounting platform the UPL rows are projected to (Section 3.11).",
      example: "xero",
    }),
    accounting_period_id: f.ref("accounting period"),
  })
  .meta({
    id: "PostingExportRequest",
    description: "Request to export posting lines for a period.",
  });

export const Invoice = defineResource({
  name: "Invoice",
  table: "app.invoices",
  description: "An invoice issued or received. A closed production refuses new invoices.",
  serverSet: ["invoice_state", "total"],
  fields: {
    project_id: f.ref("project"),
    counterparty_organization_id: f.ref("counterparty organization").nullable(),
    engagement_id: f.ref("engagement").nullable(),
    purchase_order_id: f.ref("purchase order").nullable(),
    direction: f.code("Payable or receivable.", "payable"),
    invoice_number: f.code("Invoice number.", "INV-2026-0042"),
    issued_on: f.date("Issue date."),
    due_on: f.date("Due date.").nullable(),
    currency: f.currency(),
    invoice_state: c.SharedState,
    total: MoneyTotal,
  },
});

export const InvoiceLine = defineResource({
  name: "InvoiceLine",
  table: "app.invoice_lines",
  description: "A line of an invoice.",
  immutable: ["invoice_id"],
  fields: {
    invoice_id: f.ref("invoice"),
    po_line_id: f.ref("purchase order line").nullable(),
    description: f.text("Line description.", "Stage deck rental"),
    quantity: f.quantity("Quantity.", 24).nullable(),
    unit_price_minor: f.money("Unit price.", 4500),
    currency: f.currency(),
  },
});

export const PaymentApplication = defineResource({
  name: "PaymentApplication",
  table: "app.payment_applications",
  description: "A payment applied to an invoice. Billed-to-date counts each payment once.",
  immutable: ["invoice_id"],
  fields: {
    invoice_id: f.ref("invoice"),
    paid_on: f.date("Payment date."),
    amount_minor: f.money("Amount applied.", 108000),
    currency: f.currency(),
    external_ref: f.text("Bank or card reference.", "ACH-77812").nullable(),
  },
});

export const BillingDraw = defineResource({
  name: "BillingDraw",
  table: "app.billing_draws",
  description: "A client billing draw against the project.",
  immutable: ["project_id"],
  fields: {
    project_id: f.ref("project"),
    title: f.text("Draw title.", "Deposit 1"),
    amount_minor: f.money("Draw amount.", 5000000),
    currency: f.currency(),
    due_on: f.date("Due date."),
  },
});

export const CostCenter = defineResource({
  name: "CostCenter",
  table: "app.cost_centers",
  description:
    "A tenant cost center (GL dimension 1), created from canon templates or per event scope.",
  fields: {
    cost_center_id: c.CostCenterCode,
    name: f.text("Cost center name.", "Event 01 Opening Weekend"),
    kind: f.stateLabel("Cost center kind.", "Event"),
    scope_node_id: f.ref("scope node").nullable(),
  },
});

export const TaxJurisdiction = defineResource({
  name: "TaxJurisdiction",
  table: "app.tax_jurisdictions",
  description: "A tax jurisdiction the org collects or pays tax in.",
  fields: {
    jurisdiction_id: c.JurisdictionId,
    name: f.text("Tax jurisdiction name.", "Florida Sales Tax"),
  },
});

export const TaxRate = defineResource({
  name: "TaxRate",
  table: "app.tax_rates",
  description: "A tax rate with its effective dates.",
  immutable: ["tax_jurisdiction_id"],
  fields: {
    tax_jurisdiction_id: f.ref("tax jurisdiction"),
    rate_percent: f.quantity("Rate in percent.", 7),
    effective_from: f.date("First day the rate applies."),
    effective_to: f.date("Last day the rate applies.").nullable(),
  },
});

export const FxRate = defineResource({
  name: "FxRate",
  table: "app.fx_rates",
  description: "A daily reference exchange rate with its rate date and source.",
  base: "view",
  fields: {
    base_currency: f.currency("Base currency."),
    quote_currency: f.currency("Quote currency."),
    rate: f.quantity("Units of quote currency per unit of base currency.", 0.9213),
    rate_date: f.date("Reference rate date."),
    source: f.code("Rate source.", "ECB"),
  },
});

export const PriceBook = defineResource({
  name: "PriceBook",
  table: "app.price_books",
  description: "An org price book for selling items.",
  fields: {
    name: f.text("Price book name.", "Standard Client Rates"),
    currency: f.currency(),
  },
});

// Procurement

export const Rfq = defineResource({
  name: "Rfq",
  table: "app.rfqs",
  description: "A request for quotation. Responses stay sealed until the deadline.",
  immutable: ["project_id"],
  serverSet: ["rfq_state"],
  fields: {
    project_id: f.ref("project"),
    title: f.text("RFQ title.", "Main Stage Audio Package"),
    urid: c.UridAtAnyGrain,
    deadline_at: f.instant("Bid deadline; bids unseal after it."),
    rfq_state: c.SharedState,
  },
});

export const RfqInvitation = defineResource({
  name: "RfqInvitation",
  table: "app.rfq_invitations",
  description: "An invitation to bid on an RFQ.",
  immutable: ["rfq_id", "organization_id"],
  fields: { rfq_id: f.ref("RFQ"), organization_id: f.ref("invited vendor organization") },
});

export const RfqResponse = defineResource({
  name: "RfqResponse",
  table: "app.rfq_responses",
  description: "A sealed RFQ response. A bidder sees only their own response.",
  immutable: ["rfq_id", "organization_id"],
  serverSet: ["submitted_at", "total"],
  fields: {
    rfq_id: f.ref("RFQ"),
    organization_id: f.ref("responding vendor"),
    submitted_at: f.instant("When the response was submitted.").nullable(),
    total: MoneyTotal,
  },
});

export const RfqResponseLine = defineResource({
  name: "RfqResponseLine",
  table: "app.rfq_response_lines",
  description: "A line of an RFQ response.",
  immutable: ["rfq_response_id"],
  fields: {
    rfq_response_id: f.ref("RFQ response"),
    description: f.text("Line description.", "Line array, 12 boxes per side"),
    quantity: f.quantity("Quantity.", 1).nullable(),
    unit_price_minor: f.money("Unit price.", 1800000),
    currency: f.currency(),
  },
});

export const PurchaseOrder = defineResource({
  name: "PurchaseOrder",
  table: "app.purchase_orders",
  description:
    "A purchase order. Its creator cannot approve it; spend authority applies inside the approval RPC.",
  immutable: ["project_id"],
  serverSet: ["po_number", "po_state", "total"],
  fields: {
    project_id: f.ref("project"),
    vendor_id: f.ref("vendor"),
    po_number: f.code("PO number issued by `next_sequence`.", "PO-2026-0117"),
    currency: f.currency(),
    po_state: c.SharedState,
    total: MoneyTotal,
    required_on: f.date("Date the goods or services are required.").nullable(),
  },
});

export const PoLine = defineResource({
  name: "PoLine",
  table: "app.po_lines",
  description: "A purchase order line.",
  immutable: ["purchase_order_id"],
  fields: {
    purchase_order_id: f.ref("purchase order"),
    budget_line_id: f.ref("budget line"),
    element_id: c.ItemId.nullable(),
    description: f.text("Line description.", "Stage deck rental"),
    quantity: f.quantity("Quantity ordered.", 24),
    unit: c.UnitCode,
    unit_price_minor: f.money("Unit price.", 4500),
    currency: f.currency(),
  },
});

export const PoChangeOrder = defineResource({
  name: "PoChangeOrder",
  table: "app.po_change_orders",
  description: "A change to an issued purchase order.",
  immutable: ["purchase_order_id"],
  serverSet: ["po_change_state"],
  fields: {
    purchase_order_id: f.ref("purchase order"),
    description: f.longText("What changes.", "Add six deck sections."),
    amount_minor: f.money("Change amount; null when unpriced.", 27000),
    currency: f.currency(),
    po_change_state: c.SharedState,
  },
});

export const GoodsReceipt = defineResource({
  name: "GoodsReceipt",
  table: "app.goods_receipts",
  description: "A goods receipt against a purchase order. Duplicate receipts are refused.",
  immutable: ["purchase_order_id"],
  fields: {
    purchase_order_id: f.ref("purchase order"),
    received_at: f.instant("When the goods arrived."),
    received_by: f.ref("receiver"),
    dock_slot_id: f.ref("dock slot").nullable(),
  },
});

export const ReceiptLine = defineResource({
  name: "ReceiptLine",
  table: "app.receipt_lines",
  description: "A received quantity against a PO line.",
  immutable: ["goods_receipt_id", "po_line_id"],
  fields: {
    goods_receipt_id: f.ref("goods receipt"),
    po_line_id: f.ref("PO line"),
    quantity_received: f.quantity("Quantity received.", 24),
  },
});

export const InvoiceMatch = defineResource({
  name: "InvoiceMatch",
  table: "app.invoice_matches",
  description: "A three-way match of PO, receipt and invoice. A mismatch is never auto-approved.",
  immutable: ["invoice_id"],
  serverSet: ["matched", "variance"],
  fields: {
    invoice_id: f.ref("invoice"),
    purchase_order_id: f.ref("purchase order"),
    goods_receipt_id: f.ref("goods receipt"),
    matched: f.bool("Whether all three agree.", true),
    variance: MoneyTotal,
  },
});

export const CatalogBinding = defineResource({
  name: "CatalogBinding",
  table: "app.catalog_bindings",
  description: "A tenant item bound to a canon element.",
  fields: {
    tenant_item_code: f.code("Tenant's own item code.", "NWL-DECK-4x8"),
    element_id: c.ItemId,
    confirmed_by: f.ref("person who confirmed the binding"),
  },
});

export const VendorProduct = defineResource({
  name: "VendorProduct",
  table: "app.vendor_products",
  description: "A product a vendor offers, optionally bound to an element.",
  immutable: ["vendor_id"],
  fields: {
    vendor_id: f.ref("vendor"),
    name: f.text("Product name.", "4x8 Stage Deck"),
    element_id: c.ItemId.nullable(),
    unit_price_minor: f.money("List unit price.", 4500),
    currency: f.currency(),
  },
});

// Vendors

export const Vendor = defineResource({
  name: "Vendor",
  table: "app.vendors",
  description:
    "An organization in the vendor relationship with this org, with its counterparty type.",
  immutable: ["organization_id"],
  serverSet: ["vendor_state"],
  fields: {
    organization_id: f.ref("vendor organization"),
    counterparty_type: c.CounterpartyType,
    vendor_state: c.SharedState,
    internal_notes: f
      .longText("Internal notes; never visible externally.", "Reliable on short notice.")
      .nullable(),
  },
});

export const VendorClass = defineResource({
  name: "VendorClass",
  table: "app.vendor_classes",
  description: "An org vendor class, seeded from the Standard Library.",
  fields: {
    name: f.text("Vendor class name.", "Staging"),
    counterparty_type: c.CounterpartyType.nullable(),
  },
});

export const VendorClassAssignment = defineResource({
  name: "VendorClassAssignment",
  table: "app.vendor_class_assignments",
  description: "A vendor placed in a vendor class.",
  immutable: ["vendor_id", "vendor_class_id"],
  fields: { vendor_id: f.ref("vendor"), vendor_class_id: f.ref("vendor class") },
});

export const Prequalification = defineResource({
  name: "Prequalification",
  table: "app.prequalifications",
  description: "A vendor prequalification.",
  immutable: ["vendor_id"],
  serverSet: ["prequalification_state"],
  fields: {
    vendor_id: f.ref("vendor"),
    valid_to: f.date("Expiry.").nullable(),
    prequalification_state: c.SharedState,
  },
});

export const InsuranceCertificate = defineResource({
  name: "InsuranceCertificate",
  table: "app.insurance_certificates",
  description: "A certificate of insurance naming the required additional insureds.",
  fields: {
    organization_id: f.ref("insured organization"),
    document_id: f.ref("certificate document"),
    coverage_type: f.text("Coverage type.", "General Liability"),
    each_occurrence_minor: f.money("Each occurrence limit.", 100000000),
    currency: f.currency(),
    expires_on: f.date("Expiry."),
  },
});

export const VendorScorecard = defineResource({
  name: "VendorScorecard",
  table: "app.vendor_scorecards",
  description: "A vendor scorecard for an engagement or project.",
  immutable: ["vendor_id"],
  fields: {
    vendor_id: f.ref("vendor"),
    project_id: f.ref("project").nullable(),
    score: f.int("Score from 1 to 5.", 4, 1),
    notes: f.longText("Internal notes.", "On time; one damaged deck.").nullable(),
  },
});

export const SponsorEntitlement = defineResource({
  name: "SponsorEntitlement",
  table: "app.sponsor_entitlements",
  description: "A sponsor entitlement with fulfillment tracking.",
  serverSet: ["fulfillment_state"],
  fields: {
    engagement_id: f.ref("sponsor engagement"),
    name: f.text("Entitlement.", "Logo on Main Stage Screen"),
    quantity: f.quantity("Committed quantity.", 12).nullable(),
    fulfillment_state: c.SharedState,
  },
});
