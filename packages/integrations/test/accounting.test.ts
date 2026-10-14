import { describe, expect, it } from "vitest";
import {
  accountingConnector,
  accountingConnectors,
  groupJournals,
  netSuiteProvider,
  quickBooksProvider,
  rampProvider,
  supabaseAccountingSource,
  xeroProvider,
  type AccountingSource,
  type LedgerLine,
  type ProviderPayment,
  type QueuedPayment,
} from "../src/connectors/accounting/index.ts";
import { StoreError } from "../src/framework/db.ts";
import {
  bodyOf,
  contextFor,
  dbError,
  memoryStore,
  okData,
  recordingDb,
  scriptedHttp,
} from "./doubles.ts";

const line = (overrides: Partial<LedgerLine>): LedgerLine => ({
  journalEntryId: "je-1",
  memo: "Accrue stage storage.",
  postingLineId: "pl-1",
  lineNumber: 1,
  date: "2027-07-02",
  projectId: null,
  accountCode: "5000",
  costCenterCode: "CC-VENUE",
  urid: null,
  counterpartyId: null,
  description: "Storage accrual.",
  quantity: null,
  amountMinor: 5000n,
  currencyCode: "USD",
  exponent: 2,
  ...overrides,
});

const balanced = [
  line({}),
  line({
    postingLineId: "pl-2",
    lineNumber: 2,
    accountCode: "2100",
    amountMinor: -5000n,
    costCenterCode: null,
  }),
];

const mappings = new Map([
  ["5000", { externalAccountId: "400", taxCode: "NONE" }],
  ["2100", { externalAccountId: "800", taxCode: null }],
]);

const payment: QueuedPayment = {
  paymentId: "pay-1",
  counterpartyId: "cp-1",
  counterpartyExternalId: "contact-77",
  direction: "Payable",
  amountMinor: 123456n,
  currencyCode: "USD",
  exponent: 2,
  paidOn: "2027-07-06",
  reference: "ACH 1",
};

function source(overrides: Partial<AccountingSource> = {}) {
  const recorded: ProviderPayment[] = [];
  const value: AccountingSource = {
    ledgerQueue: async () => balanced,
    accountMappings: async () => mappings,
    paymentQueue: async () => [payment],
    paymentApplications: async () => [
      { paymentId: "pay-1", invoiceId: "inv-1", amountMinor: 123456n },
    ],
    recordProviderPayment: async (_c, p) => {
      recorded.push(p);
      return "local-pay";
    },
    chartAccounts: async () => [
      { code: "2100", name: "Accounts Payable", type: "Liability" },
      { code: "5000", name: "Production Costs", type: "Expense" },
      { code: "6000", name: "Overhead", type: "Expense" },
    ],
    exponentOf: async (code) => (code === "JPY" ? 0 : 2),
    ...overrides,
  };
  return { value, recorded };
}

describe("journal grouping", () => {
  it("groups balanced, single-currency, mapped journals", () => {
    const [result] = groupJournals(
      [balanced[1] as LedgerLine, balanced[0] as LedgerLine],
      mappings,
    );
    expect(result && "journal" in result && result.journal.lines.map((l) => l.lineNumber)).toEqual([
      1, 2,
    ]);
  });

  it("refuses unbalanced, mixed-currency and unmapped journals", () => {
    const results = groupJournals(
      [
        line({ journalEntryId: "a" }),
        line({ journalEntryId: "b" }),
        line({ journalEntryId: "b", lineNumber: 2, amountMinor: -5000n, currencyCode: "EUR" }),
        line({ journalEntryId: "c", accountCode: "6000" }),
        line({ journalEntryId: "c", lineNumber: 2, accountCode: "2100", amountMinor: -5000n }),
      ],
      mappings,
    );
    expect(results.map((r) => ("code" in r ? r.code : "ok"))).toEqual([
      "journal_unbalanced",
      "journal_mixed_currency",
      "account_unmapped",
    ]);
  });
});

describe("Xero", () => {
  it("exports a manual journal and maps the entry", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "PUT https://api.xero.com/api.xro/2.0/ManualJournals",
        respond: () => ({ json: { ManualJournals: [{ ManualJournalID: "MJ-1" }] } }),
      },
    ]);
    const { store, externalIds } = memoryStore();
    const { value } = source();
    const connector = accountingConnector(xeroProvider(value), value);
    const outcome = await connector.sync(
      contextFor("xero", {
        http,
        store,
        credential: { token: "t", fields: { tenant_id: "tenant-1" } },
        cursor: "c0",
      }),
    );
    expect(outcome).toEqual({
      counts: { read: 1, written: 1, skipped: 0, failed: 0 },
      cursorAfter: "c0",
    });
    expect(requests[0]?.headers?.["xero-tenant-id"]).toBe("tenant-1");
    expect(bodyOf(requests[0])).toEqual({
      ManualJournals: [
        {
          Narration: "Accrue stage storage.",
          Date: "2027-07-02",
          Status: "POSTED",
          LineAmountTypes: "NoTax",
          JournalLines: [
            {
              LineAmount: "50.00",
              AccountCode: "400",
              Description: "Storage accrual.",
              TaxType: "NONE",
              Tracking: [{ Name: "Cost Center", Option: "CC-VENUE" }],
            },
            { LineAmount: "-50.00", AccountCode: "800", Description: "Storage accrual." },
          ],
        },
      ],
    });
    expect(externalIds).toEqual([
      {
        entity: "Journal Entry",
        localId: "je-1",
        externalId: "MJ-1",
        externalVersion: null,
        contentHash: null,
      },
    ]);
  });

  it("records an unmapped account as an item error instead of exporting", async () => {
    const { http, requests } = scriptedHttp([]);
    const { store, itemErrors } = memoryStore();
    const { value } = source({ accountMappings: async () => new Map() });
    const outcome = await accountingConnector(xeroProvider(value), value).sync(
      contextFor("xero", { http, store }),
    );
    expect(requests).toHaveLength(0);
    expect(outcome.counts).toEqual({ read: 1, written: 0, skipped: 0, failed: 1 });
    expect(itemErrors[0]).toMatchObject({
      code: "account_unmapped",
      ref: { entity: "Journal Entry", localId: "je-1" },
    });
  });

  it("pushes payments against mapped invoices and pulls provider payments", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "PUT https://api.xero.com/api.xro/2.0/Payments",
        respond: () => ({ json: { Payments: [{ PaymentID: "P-1" }] } }),
      },
      {
        match: "GET https://api.xero.com/api.xro/2.0/Payments",
        respond: () => ({
          json: {
            Payments: [
              {
                PaymentID: "P-1",
                Date: "2027-07-06T00:00:00",
                Amount: 1234.56,
                PaymentType: "ACCPAYPAYMENT",
                UpdatedDateUTC: "2027-07-06T10:00:00",
                Invoice: { Contact: { ContactID: "contact-77" }, CurrencyCode: "USD" },
              },
              {
                PaymentID: "P-2",
                Date: "2027-07-07T00:00:00",
                Amount: "300",
                Reference: "Deposit",
                PaymentType: "ACCRECPAYMENT",
                UpdatedDateUTC: "2027-07-07T10:00:00",
                Invoice: { Contact: { ContactID: "contact-90" }, CurrencyCode: "JPY" },
              },
            ],
          },
        }),
      },
    ]);
    const { store, externalIds } = memoryStore([
      {
        entity: "Invoice",
        localId: "inv-1",
        externalId: "INV-9",
        externalVersion: null,
        contentHash: null,
      },
    ]);
    const { value, recorded } = source();
    const connector = accountingConnector(xeroProvider(value), value);
    const outcome = await connector.sync(
      contextFor("xero", {
        http,
        store,
        run: { scope: "Payment Sync", direction: "Two Way" },
        settings: { bank_account_code: "090" },
        credential: { token: "t", fields: { tenant_id: "x" } },
      }),
    );
    expect(bodyOf(requests[0])).toEqual({
      Payments: [
        {
          Invoice: { InvoiceID: "INV-9" },
          Account: { Code: "090" },
          Amount: "1234.56",
          Date: "2027-07-06",
          Reference: "ACH 1",
        },
      ],
    });
    expect(requests[1]?.headers?.["if-modified-since"]).toBe("1970-01-01T00:00:00");
    expect(externalIds.find((x) => x.entity === "Payment")).toMatchObject({
      localId: "pay-1",
      externalId: "P-1",
      externalVersion: "P-1",
    });
    // P-1 is the payment XOS just pushed, so only P-2 comes in.
    expect(recorded).toEqual([
      {
        externalId: "P-2",
        counterpartyExternalId: "contact-90",
        direction: "Receivable",
        amountMinor: 300n,
        currencyCode: "JPY",
        paidOn: "2027-07-07",
        reference: "Deposit",
      },
    ]);
    expect(outcome).toEqual({
      counts: { read: 3, written: 2, skipped: 1, failed: 0 },
      cursorAfter: "2027-07-07T10:00:00",
    });
  });

  it("refuses payments it cannot place", async () => {
    const { http } = scriptedHttp([]);
    const { store, itemErrors } = memoryStore();
    const { value } = source({
      paymentQueue: async () => [
        payment,
        { ...payment, paymentId: "pay-2", counterpartyExternalId: null },
      ],
    });
    const outcome = await accountingConnector(xeroProvider(value), value).sync(
      contextFor("xero", { http, store, run: { scope: "Payment Sync", direction: "Outbound" } }),
    );
    expect(itemErrors.map((e) => e.code)).toEqual(["invoice_unmapped", "counterparty_unmapped"]);
    expect(outcome.counts.failed).toBe(2);
    const unapplied = source({ paymentApplications: async () => [] });
    const memory = memoryStore();
    await expect(
      accountingConnector(xeroProvider(unapplied.value), unapplied.value).sync(
        contextFor("xero", {
          http,
          store: memory.store,
          run: { scope: "Payment Sync", direction: "Outbound" },
          settings: { bank_account_code: "090" },
        }),
      ),
    ).rejects.toMatchObject({ code: "payment_unapplied" });
  });

  it("records refused provider payments and stops on unexpected failures", async () => {
    const { http } = scriptedHttp([
      {
        match: "GET https://api.xero.com",
        respond: () => ({
          json: {
            Payments: [
              {
                PaymentID: "P-5",
                Date: "2027-07-06",
                Amount: 1,
                PaymentType: "ACCPAYPAYMENT",
                UpdatedDateUTC: "2027-07-06T10:00:00",
                Invoice: { Contact: { ContactID: "nobody" }, CurrencyCode: "USD" },
              },
            ],
          },
        }),
      },
    ]);
    const { store, itemErrors } = memoryStore();
    const refused = source({
      recordProviderPayment: () =>
        Promise.reject(
          new StoreError({
            kind: "refusal",
            rule: "counterparty_unmapped",
            message: "Provider contact nobody is not mapped to a counterparty.",
          }),
        ),
    });
    const run = { scope: "Payment Sync" as const, direction: "Inbound" as const };
    const outcome = await accountingConnector(xeroProvider(refused.value), refused.value).sync(
      contextFor("xero", { http, store, run, cursor: "2027-07-01T00:00:00" }),
    );
    expect(itemErrors[0]).toMatchObject({
      code: "counterparty_unmapped",
      ref: { externalId: "P-5" },
    });
    expect(outcome.counts.failed).toBe(1);
    const invalid = source({
      recordProviderPayment: () =>
        Promise.reject(new StoreError({ kind: "invalid", message: "check failed" })),
    });
    const second = memoryStore();
    await accountingConnector(xeroProvider(invalid.value), invalid.value).sync(
      contextFor("xero", { http, store: second.store, run }),
    );
    expect(second.itemErrors[0]?.code).toBe("payment_invalid");
    const broken = source({
      recordProviderPayment: () =>
        Promise.reject(new StoreError({ kind: "unexpected", message: "down" })),
    });
    await expect(
      accountingConnector(xeroProvider(broken.value), broken.value).sync(
        contextFor("xero", { http, store, run }),
      ),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("needs the tenant and the bank account", async () => {
    const { http } = scriptedHttp([]);
    const { store } = memoryStore();
    const { value } = source();
    const context = contextFor("xero", { http, store, credential: { token: "t", fields: {} } });
    const noTenant = { ...context, connection: { ...context.connection, externalAccountId: null } };
    await expect(
      accountingConnector(xeroProvider(value), value).sync(noTenant),
    ).rejects.toMatchObject({ code: "credential_incomplete" });
    const noBank = contextFor("xero", {
      http,
      store,
      run: { scope: "Payment Sync", direction: "Outbound" },
    });
    const withInvoice = memoryStore([
      {
        entity: "Invoice",
        localId: "inv-1",
        externalId: "INV-9",
        externalVersion: null,
        contentHash: null,
      },
    ]);
    await expect(
      accountingConnector(xeroProvider(value), value).sync({ ...noBank, store: withInvoice.store }),
    ).rejects.toMatchObject({ code: "setting_missing" });
    await expect(
      accountingConnector(xeroProvider(value), value).sync({ ...context, credential: null }),
    ).rejects.toMatchObject({ code: "credential_required" });
  });

  it("rejects malformed provider responses", async () => {
    const { http } = scriptedHttp([
      {
        match: "PUT https://api.xero.com/api.xro/2.0/ManualJournals",
        respond: () => ({ json: { ManualJournals: [] } }),
      },
      {
        match: "PUT https://api.xero.com/api.xro/2.0/Payments",
        respond: () => ({ json: { Payments: [] } }),
      },
    ]);
    const { store } = memoryStore([
      {
        entity: "Invoice",
        localId: "inv-1",
        externalId: "INV-9",
        externalVersion: null,
        contentHash: null,
      },
    ]);
    const { value } = source();
    await expect(
      accountingConnector(xeroProvider(value), value).sync(contextFor("xero", { http, store })),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
    await expect(
      accountingConnector(xeroProvider(value), value).sync(
        contextFor("xero", {
          http,
          store,
          run: { scope: "Payment Sync", direction: "Outbound" },
          settings: { bank_account_code: "090" },
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
  });
});

describe("QuickBooks Online", () => {
  it("posts journal entries with posting types and bill payments", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://quickbooks.api.intuit.com/v3/company/realm-9/journalentry",
        respond: () => ({ json: { JournalEntry: { Id: "145", SyncToken: "0" } } }),
      },
      {
        match: "POST https://quickbooks.api.intuit.com/v3/company/realm-9/billpayment",
        respond: () => ({ json: { BillPayment: { Id: "88", SyncToken: "0" } } }),
      },
      {
        match: "POST https://quickbooks.api.intuit.com/v3/company/realm-9/payment",
        respond: () => ({ json: { Payment: { Id: "89", SyncToken: "1" } } }),
      },
    ]);
    const { store, externalIds } = memoryStore([
      {
        entity: "Invoice",
        localId: "inv-1",
        externalId: "BILL-3",
        externalVersion: null,
        contentHash: null,
      },
    ]);
    const { value } = source({
      paymentQueue: async () => [
        payment,
        { ...payment, paymentId: "pay-2", direction: "Receivable", reference: null },
      ],
      paymentApplications: async () => [
        { paymentId: "pay-1", invoiceId: "inv-1", amountMinor: 123456n },
      ],
    });
    const connector = accountingConnector(quickBooksProvider(value), value);
    const credential = { token: "t", fields: { realm_id: "realm-9" } };
    await connector.sync(contextFor("quickbooks_online", { http, store, credential }));
    expect(bodyOf(requests[0])).toMatchObject({
      Line: [
        {
          Amount: "50.00",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { value: "400" },
            TaxCodeRef: { value: "NONE" },
          },
        },
        {
          Amount: "50.00",
          JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "800" } },
        },
      ],
    });
    await connector.sync(
      contextFor("quickbooks_online", {
        http,
        store,
        credential,
        run: { scope: "Payment Sync", direction: "Outbound" },
        settings: { bank_account_id: "35" },
      }),
    );
    expect(bodyOf(requests[1])).toMatchObject({
      VendorRef: { value: "contact-77" },
      CheckPayment: { BankAccountRef: { value: "35" } },
      TotalAmt: "1234.56",
      Line: [{ LinkedTxn: [{ TxnId: "BILL-3", TxnType: "Bill" }] }],
    });
    expect(bodyOf(requests[2])).toMatchObject({ CustomerRef: { value: "contact-77" }, Line: [] });
    expect(externalIds.filter((x) => x.entity === "Payment").map((x) => x.externalId)).toEqual([
      "88",
      "89",
    ]);
    expect(externalIds.find((x) => x.entity === "Journal Entry")?.externalVersion).toBe("0");
  });

  it("pulls payments and bill payments since the cursor", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://quickbooks.api.intuit.com/v3/company/realm-9/query",
        respond: (request) =>
          request.url.includes("BillPayment")
            ? {
                json: {
                  QueryResponse: {
                    BillPayment: [
                      {
                        Id: "7",
                        TotalAmt: 10,
                        TxnDate: "2027-07-08",
                        VendorRef: { value: "v1" },
                        MetaData: { LastUpdatedTime: "2027-07-08T01:00:00Z" },
                      },
                    ],
                  },
                },
              }
            : {
                json: {
                  QueryResponse: {
                    Payment: [
                      {
                        Id: "5",
                        TotalAmt: "25.50",
                        TxnDate: "2027-07-07",
                        PaymentRefNum: "R5",
                        CustomerRef: { value: "c1" },
                        CurrencyRef: { value: "USD" },
                        MetaData: { LastUpdatedTime: "2027-07-07T01:00:00Z" },
                      },
                      {
                        Id: "6",
                        TotalAmt: 1,
                        TxnDate: "2027-07-07",
                        MetaData: { LastUpdatedTime: "2027-07-07T02:00:00Z" },
                      },
                    ],
                  },
                },
              },
      },
    ]);
    const { store } = memoryStore();
    const { value, recorded } = source();
    const outcome = await accountingConnector(quickBooksProvider(value), value).sync(
      contextFor("quickbooks_online", {
        http,
        store,
        credential: { token: "t", fields: { realm_id: "realm-9" } },
        run: { scope: "Payment Sync", direction: "Inbound" },
        settings: { home_currency: "USD" },
        cursor: "2027-07-01T00:00:00Z",
      }),
    );
    expect(decodeURIComponent(requests[0]?.url ?? "")).toContain(
      "MetaData.LastUpdatedTime > '2027-07-01T00:00:00Z'",
    );
    expect(recorded.map((p) => [p.externalId, p.direction, p.amountMinor])).toEqual([
      ["payment:5", "Receivable", 2550n],
      ["billpayment:7", "Payable", 1000n],
    ]);
    expect(outcome.cursorAfter).toBe("2027-07-08T01:00:00Z");
  });
});

describe("NetSuite", () => {
  it("creates records and reads the id from the Location header", async () => {
    const { http, requests } = scriptedHttp([
      {
        match:
          "POST https://td-123.suitetalk.api.netsuite.com/services/rest/record/v1/journalEntry",
        respond: () => ({
          status: 204,
          headers: {
            location:
              "https://td-123.suitetalk.api.netsuite.com/services/rest/record/v1/journalEntry/9001",
          },
        }),
      },
      {
        match:
          "POST https://td-123.suitetalk.api.netsuite.com/services/rest/record/v1/vendorPayment",
        respond: () => ({ status: 204, headers: { location: ".../vendorPayment/77" } }),
      },
      {
        match:
          "POST https://td-123.suitetalk.api.netsuite.com/services/rest/record/v1/customerPayment",
        respond: () => ({ status: 204, headers: {} }),
      },
    ]);
    const { store, externalIds } = memoryStore([
      {
        entity: "Invoice",
        localId: "inv-1",
        externalId: "BILL-3",
        externalVersion: null,
        contentHash: null,
      },
    ]);
    const { value } = source();
    const connector = accountingConnector(netSuiteProvider(value), value);
    const credential = { token: "t", fields: { account_id: "TD_123" } };
    const settings = { subsidiary_id: "1", bank_account_id: "11" };
    await connector.sync(contextFor("netsuite", { http, store, credential, settings }));
    expect(bodyOf(requests[0])).toMatchObject({
      subsidiary: { id: "1" },
      line: {
        items: [
          { account: { id: "400" }, debit: "50.00", department: { refName: "CC-VENUE" } },
          { account: { id: "800" }, credit: "50.00" },
        ],
      },
    });
    expect(externalIds.find((x) => x.entity === "Journal Entry")?.externalId).toBe("9001");
    await connector.sync(
      contextFor("netsuite", {
        http,
        store,
        credential,
        settings,
        run: { scope: "Payment Sync", direction: "Outbound" },
      }),
    );
    expect(bodyOf(requests[1])).toMatchObject({
      entity: { id: "contact-77" },
      apply: { items: [{ doc: { id: "BILL-3" }, apply: true, amount: "1234.56" }] },
    });
    const receivable = source({
      paymentQueue: async () => [{ ...payment, direction: "Receivable" }],
    });
    await expect(
      accountingConnector(netSuiteProvider(receivable.value), receivable.value).sync(
        contextFor("netsuite", {
          http,
          store,
          credential,
          settings,
          run: { scope: "Payment Sync", direction: "Outbound" },
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
    await expect(
      connector.sync(
        contextFor("netsuite", {
          http,
          store,
          credential: { token: "t", fields: { account_id: "bad host!" } },
          settings,
        }),
      ),
    ).rejects.toMatchObject({ code: "credential_incomplete" });
  });

  it("pulls payments through SuiteQL", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://td-123.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql",
        respond: () => ({
          json: {
            items: [
              {
                id: "31",
                entity: "v9",
                trandate: "2027-07-09",
                foreigntotal: "-75.25",
                symbol: "USD",
                type: "VendPymt",
                lastmodified: "2027-07-09 08:00:00",
              },
              {
                id: "32",
                entity: "c9",
                trandate: "2027-07-09",
                foreigntotal: "10",
                symbol: "USD",
                type: "CustPymt",
                tranid: "PMT-32",
                lastmodified: "2027-07-08 08:00:00",
              },
            ],
          },
        }),
      },
    ]);
    const { store } = memoryStore();
    const { value, recorded } = source();
    const run = { scope: "Payment Sync" as const, direction: "Inbound" as const };
    const credential = { token: "t", fields: { account_id: "td-123" } };
    const outcome = await accountingConnector(netSuiteProvider(value), value).sync(
      contextFor("netsuite", { http, store, credential, run }),
    );
    expect(requests[0]?.headers?.["prefer"]).toBe("transient");
    expect(recorded.map((p) => [p.externalId, p.direction, p.amountMinor, p.reference])).toEqual([
      ["31", "Payable", 7525n, null],
      ["32", "Receivable", 1000n, "PMT-32"],
    ]);
    expect(outcome.cursorAfter).toBe("2027-07-09 08:00:00");
    await expect(
      accountingConnector(netSuiteProvider(value), value).sync(
        contextFor("netsuite", { http, store, credential, run, cursor: "x'; drop" }),
      ),
    ).rejects.toMatchObject({ code: "cursor_malformed" });
  });
});

describe("Ramp", () => {
  it("projects the mapped chart into Ramp", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://api.ramp.com/developer/v1/accounting/accounts",
        respond: () => ({ json: {} }),
      },
    ]);
    const { store } = memoryStore();
    const { value } = source();
    const outcome = await accountingConnector(rampProvider(value), value).sync(
      contextFor("ramp", { http, store }),
    );
    expect(bodyOf(requests[0])).toEqual({
      gl_accounts: [
        { id: "800", code: "2100", name: "Accounts Payable", classification: "LIABILITY" },
        { id: "400", code: "5000", name: "Production Costs", classification: "EXPENSE" },
      ],
    });
    expect(outcome.counts).toEqual({ read: 3, written: 2, skipped: 1, failed: 0 });
    const none = source({ accountMappings: async () => new Map() });
    const empty = await accountingConnector(rampProvider(none.value), none.value).sync(
      contextFor("ramp", { http, store }),
    );
    expect(empty.counts.written).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("pages through paid bills and refuses to take payments from XOS", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://api.ramp.com/developer/v1/bills",
        respond: (request) =>
          request.url.includes("start=2")
            ? {
                json: {
                  data: [
                    {
                      id: "b2",
                      vendor: { id: "rv2" },
                      amount: { amount: 999, currency_code: "USD" },
                      paid_at: "2027-07-10T09:00:00Z",
                    },
                  ],
                  page: { next: null },
                },
              }
            : {
                json: {
                  data: [
                    {
                      id: "b1",
                      vendor: { id: "rv1", remote_id: "contact-77" },
                      amount: { amount: 120000, currency_code: "USD" },
                      paid_at: "2027-07-09T09:00:00Z",
                      invoice_number: "INV-1",
                    },
                  ],
                  page: { next: "https://api.ramp.com/developer/v1/bills?start=2" },
                },
              },
      },
    ]);
    const { store } = memoryStore();
    const { value, recorded } = source();
    const connector = accountingConnector(rampProvider(value), value);
    const outcome = await connector.sync(
      contextFor("ramp", {
        http,
        store,
        run: { scope: "Payment Sync", direction: "Inbound" },
        cursor: "2027-07-01T00:00:00Z",
      }),
    );
    expect(requests[0]?.url).toContain("from_paid_at=2027-07-01T00%3A00%3A00Z");
    expect(recorded.map((p) => [p.externalId, p.counterpartyExternalId, p.amountMinor])).toEqual([
      ["b1", "contact-77", 120000n],
      ["b2", "rv2", 999n],
    ]);
    expect(outcome.cursorAfter).toBe("2027-07-10T09:00:00Z");
    await expect(
      connector.sync(
        contextFor("ramp", { http, store, run: { scope: "Payment Sync", direction: "Outbound" } }),
      ),
    ).rejects.toMatchObject({ code: "direction_unsupported" });
    const hostile = scriptedHttp([
      {
        match: "GET https://api.ramp.com",
        respond: () => ({
          json: { data: [], page: { next: "https://elsewhere.example.com/bills" } },
        }),
      },
    ]);
    await expect(
      connector.sync(
        contextFor("ramp", {
          http: hostile.http,
          store,
          run: { scope: "Payment Sync", direction: "Inbound" },
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
  });

  it("names the scopes a provider lacks", async () => {
    const { http } = scriptedHttp([]);
    const { store } = memoryStore();
    const { value } = source();
    const bare = accountingConnector({ provider: "xero", label: "Bare" }, value);
    await expect(bare.sync(contextFor("xero", { http, store }))).rejects.toMatchObject({
      code: "scope_unsupported",
    });
    await expect(
      bare.sync(
        contextFor("xero", { http, store, run: { scope: "Payment Sync", direction: "Inbound" } }),
      ),
    ).rejects.toMatchObject({ code: "direction_unsupported" });
    expect(accountingConnectors(value).map((c) => c.provider)).toEqual([
      "xero",
      "quickbooks_online",
      "netsuite",
      "ramp",
    ]);
  });
});

describe("accounting source", () => {
  it("reads the queues as bigint money and calls the payment RPC", async () => {
    const { db, calls } = recordingDb({
      "from:integration_ledger_queue": [
        okData([
          {
            journal_entry_id: "je",
            memo: "m",
            posting_line_id: "pl",
            line_number: 1,
            date: "2027-07-02",
            project_id: null,
            account_code: "5000",
            cost_center_code: null,
            urid: null,
            counterparty_id: null,
            description: "d",
            quantity: null,
            amount_minor: "9007199254740993",
            currency_code: "USD",
            minor_unit_exponent: 2,
          },
        ]),
      ],
      "from:integration_account_mappings": [
        okData([{ account_code: "5000", external_account_id: "400", external_tax_code: null }]),
      ],
      "from:integration_payment_queue": [
        okData([
          {
            payment_id: "p",
            counterparty_id: "c",
            counterparty_external_id: null,
            direction: "Payable",
            amount_minor: 5,
            currency_code: "USD",
            minor_unit_exponent: 2,
            paid_on: "2027-07-01",
            reference_identifier: null,
          },
        ]),
      ],
      "from:payment_applications": [
        okData([{ payment_id: "p", invoice_id: "i", amount_minor: 5 }]),
      ],
      "rpc:record_provider_payment": [okData("local")],
      "from:currencies": [okData({ minor_unit_exponent: 0 }), okData(null)],
    });
    const canon = recordingDb({
      "from:dim_gl_account": [
        okData([{ account_code: "5000", account_name: "Production", account_type: "Expense" }]),
      ],
    });
    const s = supabaseAccountingSource(db, canon.db);
    expect((await s.ledgerQueue("conn", 10))[0]?.amountMinor).toBe(9007199254740993n);
    expect((await s.accountMappings("conn")).get("5000")).toEqual({
      externalAccountId: "400",
      taxCode: null,
    });
    expect((await s.paymentQueue("conn", 10))[0]?.amountMinor).toBe(5n);
    expect(await s.paymentApplications([])).toEqual([]);
    expect(await s.paymentApplications(["p"])).toEqual([
      { paymentId: "p", invoiceId: "i", amountMinor: 5n },
    ]);
    expect(
      await s.recordProviderPayment("conn", {
        externalId: "x",
        counterpartyExternalId: "c",
        direction: "Payable",
        amountMinor: 12n,
        currencyCode: "USD",
        paidOn: "2027-07-01",
        reference: null,
      }),
    ).toBe("local");
    expect(
      calls.find((c) => c.target === "rpc:record_provider_payment")?.steps[0]?.[1],
    ).toMatchObject([{ p_amount_minor: "12" }]);
    expect(await s.chartAccounts()).toEqual([
      { code: "5000", name: "Production", type: "Expense" },
    ]);
    expect(await s.exponentOf("JPY")).toBe(0);
    await expect(s.exponentOf("QQQ")).rejects.toMatchObject({ code: "currency_unknown" });
    void dbError;
  });
});
