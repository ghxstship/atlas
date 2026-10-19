/**
 * Finance operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Finance resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Finance resources follow ADR 0023 (A15).
 *
 * Money stays integer minor units and nullable where unpriced (Section 3.7). A document's currency
 * is `currency_code` on the document; its lines are priced in it, so line shapes carry no currency
 * of their own. Totals are `MoneyTotal`: the sum of the priced inputs with the unpriced count.
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, defineResource, fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, setOrder } from "../correct.ts";
import { collectionAction, collectionQuery, itemAction, resource, transition } from "../define.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

/** The write form of a NOT NULL amount in integer minor units; read shapes keep money nullable. */
const minor = (description: string, example: number, min = 0) =>
  z
    .int()
    .min(min)
    .meta({
      description: `${description} Integer minor units of the document currency.`,
      example,
      format: "int64",
    });

const currencyCode = fields.currency("ISO 4217 currency code of every money field on the row.");
const quantity = z.number().meta({ description: "Quantity; defaults to 1.", example: 24 });

const EXPENSE_STATES = ["Proposed", "Approved", "Rejected", "Paid", "Canceled"] as const;
const CHANGE_ORDER_STATES = ["Proposed", "Priced", "Approved", "Rejected", "Canceled"] as const;
const INVOICE_STATES = ["Proposed", "Issued", "Approved", "Disputed", "Canceled"] as const;
const JOURNAL_STATES = ["Proposed", "Posted", "Canceled"] as const;
const UPL_TARGETS = ["xero", "quickbooks", "netsuite", "ramp"] as const;

const SINCE = "1.0.0-draft.2";

/** The synchronous UPL export (Section 3.11): the projected CSV, with its header and row count. */
const PostingExport = z
  .object({
    target: label(UPL_TARGETS, "Accounting platform the rows were projected to."),
    accounting_period_id: fields.ref("accounting period exported"),
    filename: fields.text("Suggested file name.", "upl-xero-2026-09-01-2026-09-30.csv"),
    content_type: z.literal("text/csv").meta({ description: "Media type.", example: "text/csv" }),
    header: z
      .array(z.string())
      .meta({ description: "Column names after the canon mapping.", example: ["Date", "Amount"] }),
    row_count: fields.int("Posting lines exported.", 42),
    csv: z.string().meta({
      description: "RFC 4180 CSV with CRLF line endings: the header, then one row per line.",
      example: "Date,AccountCode\r\n2026-09-14,5400\r\n",
    }),
  })
  .meta({
    id: "PostingExport",
    description:
      "Universal Posting Lines of one period projected to one platform through the canon mapping.",
  });

/** Recording that an invoice was paid (A38-007, app.record_invoice_payment, 1123). */
const RecordPaymentRequest = z
  .object({
    paid_on: fields.date("Date the money moved."),
    amount_minor: minor("Amount paid; the whole balance when null or omitted.", 349000, 1)
      .nullable()
      .optional(),
    reference: z.string().min(1).max(200).optional().meta({
      description: "Remittance reference from the bank or payout provider.",
      example: "ACH-2027-0042",
    }),
  })
  .meta({
    id: "InvoicePaymentRequest",
    description: "A payment made on the org's own rails, recorded against an invoice.",
  });

/**
 * A payee of the 1099-NEC data export (A38-006, app.form_1099_nec_rows, 1124). The API never returns
 * the full TIN: that Restricted export needs step-up authentication, which an API key cannot give,
 * so it stays in Atlas.
 */
const Form1099NecRow = defineResource({
  name: "Form1099NecRow",
  table: "app.form_1099_nec_rows",
  description:
    "A payee paid $600 or more in approved USD payments in a tax year as an independent contractor, with the W-9 on file.",
  base: "view",
  fields: {
    payee_person_id: orNull(fields.ref("person paid as an individual")),
    payee_organization_id: orNull(fields.ref("account paid")),
    payee_name: fields.text("Name on the W-9, or the payee's name.", "Ivy Marchetti"),
    w9_on_file: fields.bool("Whether a W-9 is on file with the org.", true),
    tin_type: orNull(fields.int("FIRE TIN type: 1 EIN (an account), 2 SSN (a person).", 2, 1)),
    tin_last4: orNull(fields.text("Last four of the TIN.", "6789", 4)),
    address_complete: fields.bool("Whether the W-9 address is complete.", true),
    amount_minor: fields.money("Approved USD payments in the year.", 75000),
    payment_count: fields.int("Payments counted.", 2),
  },
});

export const additions = defineAdditions("Finance", {
  resources: [
    resource("Finance", "/form-1099-nec", Form1099NecRow, {
      verbs: [],
      label: "1099-NEC payee",
      actions: [
        collectionQuery("rows", {
          summary: "1099-NEC payees of a tax year",
          description:
            "Payees paid $600 or more in approved USD payments in the calendar year as independent contractors (individuals and accounts), with whether a W-9 and its address are on file. Full TINs are a Restricted export with step-up, in Atlas only.",
          paged: true,
          response: Form1099NecRow.read,
          query: z.object({
            year: z.coerce
              .number()
              .int()
              .min(2020)
              .meta({ description: "Tax year.", example: 2025 }),
          }),
        }),
      ],
    }),
  ],
  actions: {
    invoices: [
      itemAction("recordPayment", {
        summary: "Record a payment",
        description:
          "Records that an approved payable (or issued receivable) was paid: a Proposed payment of the invoice's payee, its counterparty or the person engaged as an individual, applied to the invoice for the whole balance unless `amount_minor` says otherwise. Money moves on the org's own rails; XOS never holds funds. Another eligible person approves the payment. Refuses a Proposed, Disputed or Canceled invoice and an invoice with nothing left to pay (422).",
        body: RecordPaymentRequest,
      }),
    ],
  },
  capabilities: {
    invoices: { actions: { recordPayment: "finance.payment.write" } },
    form1099Nec: { actions: { rows: "finance.payment.read" } },
  },
  corrections: [
    {
      id: "budget-columns",
      since: SINCE,
      resources: ["budgets"],
      change:
        "`currency` becomes `currency_code`; adds `is_baseline`; removes `budget_state` and `contingency_percent`.",
      reason:
        "app.budgets (0320) stores `currency_code` and an `is_baseline` flag for the gate 3 baseline. It has no lifecycle and no contingency percent: contingency is a budget line of type Contingency, drawn through app.contingency_draws.",
      apply: editShape({
        rename: { currency: "currency_code" },
        remove: ["budget_state", "contingency_percent"],
        add: {
          is_baseline: {
            schema: fields.bool(
              "Whether this is the gate 3 baseline the final cost report compares against.",
              false,
            ),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "budget-line-columns",
      since: SINCE,
      resources: ["budgetLines"],
      components: ["schemas/Grade"],
      change:
        "Adds a required `line_number`; `grade` and `unit` become `grade_code` and `unit_basis`; `cost_center_id` becomes nullable; `quantity` defaults to 1; `line_total_minor` is derived. Removes `account_code`, `currency` and `line_state`. Lists order by `line_number`.",
      reason:
        "app.budget_lines (0320) numbers its lines, stores the price band as the lowercase `grade_code` and the unit as `unit_basis`, leaves the cost center NULL until assigned, and keeps `quantity` NOT NULL with a default of 1. The GL account is derived from the URID class (app.budget_line_facts, 0480), the currency is the budget's, and lines have no lifecycle.",
      apply: all(
        editShape({
          rename: { grade: "grade_code", unit: "unit_basis" },
          remove: ["account_code", "currency", "line_state"],
          nullable: ["cost_center_id"],
          add: {
            line_number: {
              schema: fields.int("Line number within the budget.", 1, 1),
              create: "required",
            },
            grade_code: {
              schema: orNull(fields.code("Price band grade of the catalog element.", "base")),
              create: "optional",
            },
            quantity: { schema: quantity, create: "optional" },
            line_type: { schema: canonCodes.LineType, create: "optional" },
          },
        }),
        setOrder({ by: ["line_number"], numeric: false }),
      ),
    },
    {
      id: "expense-columns",
      since: SINCE,
      resources: ["expenses"],
      change:
        "`submitted_by` becomes `submitter_person_id` and `currency` becomes `currency_code`; adds `counterparty_id`; removes `receipt_document_id`; `amount_minor` is required on create. `expense_state` is Proposed, Approved, Rejected, Paid or Canceled, and `submit` resubmits a Rejected expense.",
      reason:
        "app.expenses (0321) stamps the submitter's person, stores `currency_code` and an optional payee counterparty, and keeps `amount_minor` NOT NULL. Receipts are attachments on the expense (app.attachments), not a column. An expense is Proposed when created; app.transition_expense (0321) moves a Rejected one back to Proposed.",
      apply: editShape({
        rename: { submitted_by: "submitter_person_id", currency: "currency_code" },
        remove: ["receipt_document_id"],
        add: {
          submitter_person_id: { schema: orNull(fields.ref("person who submitted the expense")) },
          counterparty_id: {
            schema: orNull(fields.ref("counterparty paid, when it is not the submitter")),
            create: "optional",
          },
          amount_minor: {
            schema: fields.money("Expense amount.", 14388),
            writeSchema: minor("Expense amount.", 14388),
            create: "required",
          },
          expense_state: { schema: label(EXPENSE_STATES, "Expense state.") },
        },
      }),
    },
    {
      id: "contingency-draw-amount",
      since: SINCE,
      resources: ["contingencyDraws"],
      change: "Removes `currency`; `amount_minor` is required on create and positive.",
      reason:
        "app.contingency_draws (0321) moves an amount between two lines of one budget, in the budget's currency, and keeps `amount_minor` NOT NULL and positive.",
      apply: editShape({
        remove: ["currency"],
        add: {
          amount_minor: {
            schema: fields.money("Amount drawn.", 250000),
            writeSchema: minor("Amount drawn.", 250000, 1),
            create: "required",
          },
        },
      }),
    },
    {
      id: "change-order-columns",
      since: SINCE,
      resources: ["changeOrders"],
      change:
        "Adds a required, immutable `budget_id`, the server-set `change_order_number` and `priced_by`, and an optional `order_type_enum_id`; `description` becomes the nullable `reason`; `requested_by` becomes nullable. `change_order_state` is Proposed, Priced, Approved, Rejected or Canceled, and the transition example is Proposed to Canceled.",
      reason:
        "app.change_orders (0321) belongs to one budget, numbers itself per project, records who priced it, takes its type from the canon order types and stores the reason as `reason` (nullable). The requester is stamped from the session and is NULL for seed and system rows. The lifecycle of 0321 is Proposed, Priced, Approved, Rejected and Canceled.",
      apply: all(
        editShape({
          rename: { description: "reason" },
          nullable: ["reason", "requested_by"],
          add: {
            budget_id: {
              schema: fields.ref("budget the change order revises"),
              create: "required",
              update: false,
            },
            change_order_number: {
              schema: fields.int("Change order number within the project.", 3, 1),
            },
            order_type_enum_id: {
              schema: orNull(fields.code("Canon change order type.", "ENM-092")),
              create: "optional",
            },
            priced_by: { schema: orNull(fields.ref("person who priced the change order")) },
            change_order_state: { schema: label(CHANGE_ORDER_STATES, "Change order state.") },
          },
        }),
        putActions([
          transition(
            "Change Order",
            ["Proposed", "Canceled"],
            z.enum(CHANGE_ORDER_STATES).meta({ description: "Change order state." }),
          ),
        ]),
      ),
    },
    {
      id: "change-order-line-pricing",
      since: SINCE,
      resources: ["changeOrderLines"],
      change:
        "Replaces `amount_minor` and `currency` with `quantity`, `unit_price_minor` and `is_no_cost`.",
      reason:
        "app.change_order_lines (0321) prices a line as quantity times unit price in the budget's currency; a NULL unit price is unpriced and `is_no_cost` records a deliberate zero, so an unpriced change order is never stored at zero.",
      apply: editShape({
        remove: ["amount_minor", "currency"],
        add: {
          quantity: { schema: quantity, create: "optional" },
          unit_price_minor: {
            schema: fields.money("Unit price; null when unpriced.", 1200000),
            create: "optional",
          },
          is_no_cost: {
            schema: fields.bool("Whether the line is deliberately free of charge.", false),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "accounting-period-state-column",
      since: SINCE,
      resources: ["accountingPeriods"],
      change: "`accounting_period_state` becomes `period_state`.",
      reason: "app.accounting_periods (0320) names the lifecycle column `period_state`.",
      apply: editShape({ rename: { accounting_period_state: "period_state" } }),
    },
    {
      id: "journal-entry-columns",
      since: SINCE,
      resources: ["journalEntries"],
      change:
        "Adds an optional `project_id`, the server-set `prepared_by`, and `source_table` and `source_id` for system entries. `journal_state` is Proposed, Posted or Canceled.",
      reason:
        "app.journal_entries (0320) may belong to a project, stamps the preparer for separation of duties (the preparer cannot post), and records the document a system posting came from. Its lifecycle is Proposed, Posted and Canceled.",
      apply: editShape({
        add: {
          project_id: { schema: orNull(fields.ref("project")), create: "optional" },
          prepared_by: { schema: orNull(fields.ref("person who prepared the entry")) },
          source_table: {
            schema: orNull(
              fields.code("Table of the document that produced the entry.", "invoices"),
            ),
          },
          source_id: { schema: orNull(fields.ref("document that produced the entry")) },
          journal_state: { schema: label(JOURNAL_STATES, "Journal state.") },
        },
      }),
    },
    {
      id: "journal-line-debits-credits",
      since: SINCE,
      resources: ["journalLines"],
      change:
        "Replaces the signed `amount_minor` and `currency` with `debit_minor`, `credit_minor` and `currency_code`; adds a required `line_number` and `description`, and optional `counterparty_id`, `element_id`, `quantity` and `unit_basis`; `cost_center_id` becomes nullable.",
      reason:
        "app.journal_lines (0320) stores unsigned debit and credit columns (one of them zero) so an entry balances by sum, numbers its lines, requires a description and its currency, and carries the UPL dimensions it posts with. The cost center is NULL on balance sheet lines.",
      apply: editShape({
        remove: ["amount_minor", "currency"],
        nullable: ["cost_center_id"],
        add: {
          line_number: {
            schema: fields.int("Line number within the entry.", 1, 1),
            create: "required",
          },
          description: {
            schema: fields.text("Line description.", "Reclass staging rental"),
            create: "required",
          },
          debit_minor: {
            schema: fields.money("Debit amount; zero on a credit line.", 45000),
            writeSchema: minor("Debit amount; zero on a credit line.", 45000),
            create: "optional",
          },
          credit_minor: {
            schema: fields.money("Credit amount; zero on a debit line.", 0),
            writeSchema: minor("Credit amount; zero on a debit line.", 0),
            create: "optional",
          },
          currency_code: { schema: currencyCode, create: "required" },
          counterparty_id: { schema: orNull(fields.ref("counterparty")), create: "optional" },
          element_id: { schema: orNull(canonCodes.ItemId), create: "optional" },
          quantity: { schema: orNull(fields.quantity("Quantity.", 24)), create: "optional" },
          unit_basis: { schema: orNull(canonCodes.UnitCode), create: "optional" },
        },
      }),
    },
    {
      id: "posting-line-view",
      since: SINCE,
      resources: ["postingLines"],
      components: ["schemas/PostingExport"],
      change:
        "The key is `posting_line_id`; `amount` becomes `amount_minor`; adds `project_id`; `cost_center_id` and `urid` become nullable; removes `id` and the audit columns. `postingLines.export` answers 200 with the projected CSV (`PostingExport`) instead of 202 with a job.",
      reason:
        "app.posting_lines (0320, extended by A03F in 0362) is a view over posted journal lines: each row is identified by `posting_line_id`, carries its project, and has no audit columns of its own. Balance sheet lines have no cost center or URID. The export is a projection of one period's rows through the canon mapping (xpms.dim_upl_field) and finishes in the request, so there is no job to poll.",
      apply: all(
        editShape({
          rename: { amount: "amount_minor" },
          remove: ["id", "created_at", "created_by", "updated_at", "updated_by"],
          nullable: ["cost_center_id", "urid"],
          key: "posting_line_id",
          add: {
            posting_line_id: { schema: fields.uuid("Identifier of the posting line.") },
            project_id: { schema: orNull(fields.ref("project")) },
          },
        }),
        putActions([
          collectionAction("export", {
            segment: "exports",
            summary: "Export posting lines",
            description:
              "Projects the period's Universal Posting Lines to the target accounting platform through its canon field mapping and returns the CSV. There is no other export format.",
            body: z
              .object({
                target: label(UPL_TARGETS, "Accounting platform the rows are projected to."),
                accounting_period_id: fields.ref("accounting period"),
              })
              .meta({
                id: "PostingExportRequest",
                description: "Request to export posting lines for a period.",
              }),
            response: PostingExport,
          }),
        ]),
      ),
    },
    {
      id: "invoice-columns",
      since: SINCE,
      resources: ["invoices"],
      change:
        "The counterparty is a required `counterparty_id`; `currency` becomes `currency_code`; `direction` is Payable or Receivable; `invoice_number` and `issued_on` become nullable; removes `counterparty_organization_id`, `engagement_id` and `purchase_order_id`. `invoice_state` is Proposed, Issued, Approved, Disputed or Canceled, and the transition example is Proposed to Canceled.",
      reason:
        "app.invoices (0321) names its party through app.counterparties (NOT NULL), stores `currency_code` and the `money_direction` enum, and leaves the number and issue date NULL until a receivable is issued or a payable is recorded. An engagement's invoices are the ones with its counterparty on its project (app.submit_engagement_invoice, 0765), and purchase orders match through app.invoice_matches (0331), not invoice columns. The lifecycle of 0321 is Proposed, Issued, Approved, Disputed and Canceled.",
      apply: all(
        editShape({
          rename: { currency: "currency_code" },
          remove: ["counterparty_organization_id", "engagement_id", "purchase_order_id"],
          nullable: ["invoice_number", "issued_on"],
          add: {
            counterparty_id: {
              schema: fields.ref("counterparty billed or billing"),
              create: "required",
            },
            direction: {
              schema: label(["Payable", "Receivable"], "Whether the invoice is owed or owing."),
              create: "required",
              update: false,
            },
            invoice_state: { schema: label(INVOICE_STATES, "Invoice state.") },
          },
        }),
        putActions([
          transition(
            "Invoice",
            ["Proposed", "Canceled"],
            z.enum(INVOICE_STATES).meta({ description: "Invoice state." }),
          ),
        ]),
      ),
    },
    {
      id: "invoice-individual-payee",
      since: SINCE,
      resources: ["invoices"],
      change:
        "`counterparty_id` becomes nullable, optional on create and no longer accepted on update (the payee is fixed, `invoice_immutable`); adds the server-set `payee_person_id` and an optional `engagement_id`. Exactly one of `counterparty_id` and `payee_person_id` is set.",
      reason:
        "A person engaged as an individual has no counterparty (finding A38-007). app.invoices (1120) names exactly one payee: the counterparty, or the engaged person on a payable, which self-billing (app.generate_self_billed_invoice) and the person's own submission (app.submit_engagement_invoice) set together with the engagement billed.",
      apply: editShape({
        add: {
          counterparty_id: {
            schema: orNull(
              fields.ref("counterparty billed or billing; null for an individual payee"),
            ),
            create: "optional",
            update: false,
          },
          payee_person_id: {
            schema: orNull(fields.ref("person billing as an individual")),
          },
          engagement_id: {
            schema: orNull(fields.ref("engagement the invoice bills")),
            create: "optional",
            update: false,
          },
        },
      }),
    },
    {
      id: "invoice-line-columns",
      since: SINCE,
      resources: ["invoiceLines"],
      change:
        "Adds a required `line_number` and optional `budget_line_id`, `tax_rate_id` and `urid`; removes `po_line_id` and `currency`.",
      reason:
        "app.invoice_lines (0321, `urid` from 0362) numbers its lines, links a line to the budget line and tax rate it posts with, and carries the URID the posting needs. Purchase order lines match through app.invoice_matches (0331); the currency is the invoice's.",
      apply: editShape({
        remove: ["po_line_id", "currency"],
        add: {
          line_number: {
            schema: fields.int("Line number within the invoice.", 1, 1),
            create: "required",
          },
          budget_line_id: { schema: orNull(fields.ref("budget line")), create: "optional" },
          tax_rate_id: { schema: orNull(fields.ref("tax rate")), create: "optional" },
          urid: { schema: orNull(canonCodes.UridAtAnyGrain), create: "optional" },
        },
      }),
    },
    {
      id: "payment-application-payment",
      since: SINCE,
      resources: ["paymentApplications"],
      change:
        "Adds a required `payment_id`; `currency` becomes `currency_code`; `paid_on`, `currency_code` and `external_ref` are read from the payment; `amount_minor` is required on create.",
      reason:
        "app.payment_applications (0321) applies part of an app.payments row to an invoice: the payment holds the date, currency and bank reference, and the applied `amount_minor` is NOT NULL.",
      apply: editShape({
        rename: { currency: "currency_code" },
        serverSet: ["paid_on", "currency_code", "external_ref"],
        add: {
          payment_id: { schema: fields.ref("payment applied"), create: "required", update: false },
          amount_minor: {
            schema: fields.money("Amount applied.", 108000),
            writeSchema: minor("Amount applied.", 108000, 1),
            create: "required",
          },
        },
      }),
    },
    {
      id: "billing-draw-columns",
      since: SINCE,
      resources: ["billingDraws"],
      change:
        "Replaces `title`, `amount_minor`, `currency` and `due_on` with `draw_number`, `period_end`, `amount_requested_minor` and `currency_code` (all required), and adds the server-set `invoice_id`.",
      reason:
        "app.billing_draws (0321) is a numbered pay application for the period ending `period_end`, requesting `amount_requested_minor` in `currency_code`; the receivable invoice it produces is linked by `invoice_id`.",
      apply: editShape({
        remove: ["title", "amount_minor", "currency", "due_on"],
        add: {
          draw_number: {
            schema: fields.int("Draw number within the project.", 1, 1),
            create: "required",
          },
          period_end: { schema: fields.date("Last day the draw bills for."), create: "required" },
          amount_requested_minor: {
            schema: fields.money("Amount requested.", 5000000),
            writeSchema: minor("Amount requested.", 5000000),
            create: "required",
          },
          currency_code: { schema: currencyCode, create: "required" },
          invoice_id: { schema: orNull(fields.ref("receivable invoice of the draw")) },
        },
      }),
    },
    {
      id: "cost-center-code",
      since: SINCE,
      resources: ["costCenters"],
      change:
        "`cost_center_id` becomes `code`; `kind` is Standing, Overhead or Event; adds the server-set `template_id`. Lists order by `code`.",
      reason:
        "app.cost_centers (0320) stores the GL dimension 1 identifier as `code` (unique per org), types it with the `cost_center_kind` enum and records the canon template a center was created from.",
      apply: editShape({
        rename: { cost_center_id: "code" },
        add: {
          kind: {
            schema: label(["Standing", "Overhead", "Event"], "Cost center kind."),
            create: "required",
          },
          template_id: { schema: orNull(fields.code("Canon cost center template.", "CC-VENUE")) },
        },
      }),
    },
    {
      id: "tax-rate-type",
      since: SINCE,
      resources: ["taxRates"],
      change: "Adds a required `tax_type`.",
      reason:
        "app.tax_rates (0321) records the UPL tax type each rate posts with (NOT NULL), so the posting line carries it.",
      apply: editShape({
        add: { tax_type: { schema: canonCodes.TaxType, create: "required" } },
      }),
    },
    {
      id: "fx-rate-effective-on",
      since: SINCE,
      resources: ["fxRates"],
      change: "`rate_date` becomes `effective_on`, and lists order by it.",
      reason: "app.fx_rates (0321) names the reference date `effective_on`.",
      apply: editShape({ rename: { rate_date: "effective_on" } }),
    },
    {
      id: "price-book-currency-code",
      since: SINCE,
      resources: ["priceBooks"],
      change: "`currency` becomes `currency_code`.",
      reason:
        "app.price_books (1170, built for this operation by ADR 0032) names the column `currency_code`, as every money table does.",
      apply: editShape({ rename: { currency: "currency_code" } }),
    },
  ],
});
