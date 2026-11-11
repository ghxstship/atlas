import type { SyncContext } from "../../framework/connector.ts";
import { IntegrationError } from "../../framework/errors.ts";
import { callJson, callRaw } from "../../framework/http.ts";
import { credentialField, decimalToMinor, minorToDecimal } from "../../framework/support.ts";
import type {
  AccountingProvider,
  Journal,
  PaymentPage,
  PaymentPush,
  PushResult,
} from "./connector.ts";
import type { AccountingSource, ProviderPayment } from "./source.ts";
import type { Database } from "@xos/data/database.types";

/**
 * Provider clients for the four accounting connectors. Each talks to its provider only through the
 * injected HttpClient on the sync context, takes its token from the Vault credential, and turns
 * minor units into decimal strings (never floating point) on the way out and back on the way in.
 */

function token(context: SyncContext): string {
  if (context.credential === null) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  return context.credential.token;
}

function setting(context: SyncContext, name: string): string {
  const value = context.connection.settings[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new IntegrationError("setting_missing", `The connection needs the ${name} setting.`);
  }
  return value;
}

function accountField(context: SyncContext, name: string): string {
  if (context.credential?.fields[name] !== undefined)
    return credentialField(context.credential, name);
  if (context.connection.externalAccountId !== null) return context.connection.externalAccountId;
  throw new IntegrationError("credential_incomplete", `The stored credential is missing ${name}.`, {
    connectionError: true,
  });
}

const abs = (value: bigint) => (value < 0n ? -value : value);

// Xero ---------------------------------------------------------------------------------------------------------------

const XERO = "https://api.xero.com/api.xro/2.0";

interface XeroPayment {
  PaymentID: string;
  Date: string;
  Amount: number | string;
  Reference?: string;
  PaymentType: string;
  UpdatedDateUTC: string;
  Invoice: { Contact: { ContactID: string }; CurrencyCode: string };
}

export function xeroProvider(source: Pick<AccountingSource, "exponentOf">): AccountingProvider {
  const headers = (context: SyncContext) => ({
    "xero-tenant-id": accountField(context, "tenant_id"),
  });
  return {
    provider: "xero",
    label: "Xero",
    async pushJournal(context, journal: Journal): Promise<PushResult> {
      const body = {
        ManualJournals: [
          {
            Narration: journal.memo,
            Date: journal.date,
            Status: "POSTED",
            LineAmountTypes: "NoTax",
            JournalLines: journal.lines.map((l) => ({
              LineAmount: minorToDecimal(l.amountMinor, l.exponent),
              AccountCode: l.mapping.externalAccountId,
              Description: l.description,
              ...(l.mapping.taxCode ? { TaxType: l.mapping.taxCode } : {}),
              ...(l.costCenterCode
                ? { Tracking: [{ Name: "Cost Center", Option: l.costCenterCode }] }
                : {}),
            })),
          },
        ],
      };
      const response = await callJson<{ ManualJournals: { ManualJournalID: string }[] }>(
        context.http,
        "Xero",
        {
          method: "PUT",
          url: `${XERO}/ManualJournals`,
          token: token(context),
          headers: headers(context),
          json: body,
        },
      );
      const id = response.ManualJournals[0]?.ManualJournalID;
      if (!id)
        throw new IntegrationError(
          "provider_malformed_response",
          "Xero did not return the manual journal id.",
        );
      return { externalId: id };
    },
    async pushPayment(context, push: PaymentPush): Promise<PushResult> {
      if (push.applications.length === 0) {
        throw new IntegrationError(
          "payment_unapplied",
          "Xero records a payment only against an invoice or bill.",
        );
      }
      const response = await callJson<{ Payments: { PaymentID: string }[] }>(context.http, "Xero", {
        method: "PUT",
        url: `${XERO}/Payments`,
        token: token(context),
        headers: headers(context),
        json: {
          Payments: push.applications.map((a) => ({
            Invoice: { InvoiceID: a.invoiceExternalId },
            Account: { Code: setting(context, "bank_account_code") },
            Amount: minorToDecimal(a.amountMinor, push.payment.exponent),
            Date: push.payment.paidOn,
            ...(push.payment.reference ? { Reference: push.payment.reference } : {}),
          })),
        },
      });
      const ids = response.Payments.map((p) => p.PaymentID);
      if (ids.length === 0)
        throw new IntegrationError(
          "provider_malformed_response",
          "Xero did not return payment ids.",
        );
      return { externalId: ids[0] as string, version: ids.join(",") };
    },
    async listPayments(context, cursor): Promise<PaymentPage> {
      const since = cursor ?? "1970-01-01T00:00:00";
      const response = await callJson<{ Payments: XeroPayment[] }>(context.http, "Xero", {
        method: "GET",
        url: `${XERO}/Payments?where=${encodeURIComponent('Status=="AUTHORISED"')}`,
        token: token(context),
        headers: { ...headers(context), "if-modified-since": since },
      });
      const payments: ProviderPayment[] = [];
      let latest = since;
      for (const p of response.Payments) {
        const exponent = await source.exponentOf(p.Invoice.CurrencyCode);
        payments.push({
          externalId: p.PaymentID,
          counterpartyExternalId: p.Invoice.Contact.ContactID,
          direction: p.PaymentType.startsWith("ACCPAY") ? "Payable" : "Receivable",
          amountMinor: abs(decimalToMinor(String(p.Amount), exponent)),
          currencyCode: p.Invoice.CurrencyCode,
          paidOn: p.Date.slice(0, 10),
          reference: p.Reference ?? null,
        });
        if (p.UpdatedDateUTC > latest) latest = p.UpdatedDateUTC;
      }
      return { payments, cursor: latest };
    },
  };
}

// QuickBooks Online -----------------------------------------------------------------------------------------------------

const QBO = "https://quickbooks.api.intuit.com/v3/company";

interface QboPayment {
  Id: string;
  TotalAmt: number | string;
  TxnDate: string;
  PaymentRefNum?: string;
  CurrencyRef?: { value: string };
  CustomerRef?: { value: string };
  VendorRef?: { value: string };
  MetaData: { LastUpdatedTime: string };
}

export function quickBooksProvider(
  source: Pick<AccountingSource, "exponentOf">,
): AccountingProvider {
  const base = (context: SyncContext) => `${QBO}/${accountField(context, "realm_id")}`;
  const query = async (context: SyncContext, statement: string) =>
    callJson<{ QueryResponse: Record<string, QboPayment[] | undefined> }>(
      context.http,
      "QuickBooks Online",
      {
        method: "GET",
        url: `${base(context)}/query?minorversion=75&query=${encodeURIComponent(statement)}`,
        token: token(context),
      },
    );
  return {
    provider: "quickbooks_online",
    label: "QuickBooks Online",
    async pushJournal(context, journal) {
      const response = await callJson<{ JournalEntry: { Id: string; SyncToken: string } }>(
        context.http,
        "QuickBooks Online",
        {
          method: "POST",
          url: `${base(context)}/journalentry?minorversion=75`,
          token: token(context),
          json: {
            TxnDate: journal.date,
            PrivateNote: journal.memo,
            CurrencyRef: { value: journal.currencyCode },
            Line: journal.lines.map((l) => ({
              Amount: minorToDecimal(abs(l.amountMinor), l.exponent),
              Description: l.description,
              DetailType: "JournalEntryLineDetail",
              JournalEntryLineDetail: {
                PostingType: l.amountMinor >= 0n ? "Debit" : "Credit",
                AccountRef: { value: l.mapping.externalAccountId },
                ...(l.mapping.taxCode ? { TaxCodeRef: { value: l.mapping.taxCode } } : {}),
              },
            })),
          },
        },
      );
      return { externalId: response.JournalEntry.Id, version: response.JournalEntry.SyncToken };
    },
    async pushPayment(context, push) {
      const payment = push.payment;
      const amount = minorToDecimal(payment.amountMinor, payment.exponent);
      const lines = push.applications.map((a) => ({
        Amount: minorToDecimal(a.amountMinor, payment.exponent),
        LinkedTxn: [
          {
            TxnId: a.invoiceExternalId,
            TxnType: payment.direction === "Receivable" ? "Invoice" : "Bill",
          },
        ],
      }));
      if (payment.direction === "Receivable") {
        const response = await callJson<{ Payment: { Id: string; SyncToken: string } }>(
          context.http,
          "QuickBooks Online",
          {
            method: "POST",
            url: `${base(context)}/payment?minorversion=75`,
            token: token(context),
            json: {
              CustomerRef: { value: payment.counterpartyExternalId },
              TotalAmt: amount,
              TxnDate: payment.paidOn,
              CurrencyRef: { value: payment.currencyCode },
              ...(payment.reference ? { PaymentRefNum: payment.reference } : {}),
              Line: lines,
            },
          },
        );
        return { externalId: response.Payment.Id, version: response.Payment.SyncToken };
      }
      const response = await callJson<{ BillPayment: { Id: string; SyncToken: string } }>(
        context.http,
        "QuickBooks Online",
        {
          method: "POST",
          url: `${base(context)}/billpayment?minorversion=75`,
          token: token(context),
          json: {
            VendorRef: { value: payment.counterpartyExternalId },
            PayType: "Check",
            CheckPayment: { BankAccountRef: { value: setting(context, "bank_account_id") } },
            TotalAmt: amount,
            TxnDate: payment.paidOn,
            CurrencyRef: { value: payment.currencyCode },
            Line: lines,
          },
        },
      );
      return { externalId: response.BillPayment.Id, version: response.BillPayment.SyncToken };
    },
    async listPayments(context, cursor) {
      const since = cursor ?? "1970-01-01T00:00:00Z";
      const received = await query(
        context,
        `select * from Payment where MetaData.LastUpdatedTime > '${since}'`,
      );
      const paid = await query(
        context,
        `select * from BillPayment where MetaData.LastUpdatedTime > '${since}'`,
      );
      const payments: ProviderPayment[] = [];
      let latest = since;
      const add = async (
        rows: QboPayment[] | undefined,
        direction: Database["app"]["Enums"]["money_direction"],
      ) => {
        for (const p of rows ?? []) {
          const counterparty =
            direction === "Receivable" ? p.CustomerRef?.value : p.VendorRef?.value;
          if (counterparty === undefined) continue;
          const currency = p.CurrencyRef?.value ?? setting(context, "home_currency");
          payments.push({
            externalId: `${direction === "Receivable" ? "payment" : "billpayment"}:${p.Id}`,
            counterpartyExternalId: counterparty,
            direction,
            amountMinor: decimalToMinor(String(p.TotalAmt), await source.exponentOf(currency)),
            currencyCode: currency,
            paidOn: p.TxnDate,
            reference: p.PaymentRefNum ?? null,
          });
          if (p.MetaData.LastUpdatedTime > latest) latest = p.MetaData.LastUpdatedTime;
        }
      };
      await add(received.QueryResponse["Payment"], "Receivable");
      await add(paid.QueryResponse["BillPayment"], "Payable");
      return { payments, cursor: latest };
    },
  };
}

// NetSuite -------------------------------------------------------------------------------------------------------------

export function netSuiteProvider(source: Pick<AccountingSource, "exponentOf">): AccountingProvider {
  const host = (context: SyncContext) => {
    const account = accountField(context, "account_id").toLowerCase().replace(/_/g, "-");
    if (!/^[a-z0-9-]+$/.test(account))
      throw new IntegrationError("credential_incomplete", "The NetSuite account id is not valid.", {
        connectionError: true,
      });
    return `https://${account}.suitetalk.api.netsuite.com/services/rest`;
  };
  const created = async (
    context: SyncContext,
    record: string,
    body: unknown,
  ): Promise<PushResult> => {
    const response = await callRaw(context.http, "NetSuite", {
      method: "POST",
      url: `${host(context)}/record/v1/${record}`,
      headers: {
        authorization: `Bearer ${token(context)}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const id = /\/(\d+)$/.exec(response.headers["location"] ?? "")?.[1];
    if (id === undefined)
      throw new IntegrationError(
        "provider_malformed_response",
        `NetSuite did not return the new ${record} id.`,
      );
    return { externalId: id };
  };
  return {
    provider: "netsuite",
    label: "NetSuite",
    async pushJournal(context, journal) {
      return created(context, "journalEntry", {
        tranDate: journal.date,
        memo: journal.memo,
        subsidiary: { id: setting(context, "subsidiary_id") },
        currency: { refName: journal.currencyCode },
        line: {
          items: journal.lines.map((l) => ({
            account: { id: l.mapping.externalAccountId },
            ...(l.amountMinor >= 0n
              ? { debit: minorToDecimal(l.amountMinor, l.exponent) }
              : { credit: minorToDecimal(-l.amountMinor, l.exponent) }),
            memo: l.description,
            ...(l.costCenterCode ? { department: { refName: l.costCenterCode } } : {}),
          })),
        },
      });
    },
    async pushPayment(context, push) {
      const payment = push.payment;
      const apply = {
        items: push.applications.map((a) => ({
          doc: { id: a.invoiceExternalId },
          apply: true,
          amount: minorToDecimal(a.amountMinor, payment.exponent),
        })),
      };
      if (payment.direction === "Payable") {
        return created(context, "vendorPayment", {
          entity: { id: payment.counterpartyExternalId },
          account: { id: setting(context, "bank_account_id") },
          tranDate: payment.paidOn,
          currency: { refName: payment.currencyCode },
          apply,
        });
      }
      return created(context, "customerPayment", {
        customer: { id: payment.counterpartyExternalId },
        payment: minorToDecimal(payment.amountMinor, payment.exponent),
        tranDate: payment.paidOn,
        currency: { refName: payment.currencyCode },
        apply,
      });
    },
    async listPayments(context, cursor) {
      const since = cursor ?? "1970-01-01 00:00:00";
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(since))
        throw new IntegrationError("cursor_malformed", "The NetSuite cursor is not a timestamp.");
      const response = await callJson<{
        items: {
          id: string;
          entity: string;
          trandate: string;
          foreigntotal: string;
          symbol: string;
          type: string;
          tranid?: string;
          lastmodified: string;
        }[];
      }>(context.http, "NetSuite", {
        method: "POST",
        url: `${host(context)}/query/v1/suiteql`,
        token: token(context),
        headers: { prefer: "transient" },
        json: {
          q: `SELECT t.id, t.entity, t.trandate, t.foreigntotal, c.symbol, t.type, t.tranid, TO_CHAR(t.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS lastmodified FROM transaction t JOIN currency c ON c.id = t.currency WHERE t.type IN ('VendPymt', 'CustPymt') AND t.lastmodifieddate > TO_TIMESTAMP('${since}', 'YYYY-MM-DD HH24:MI:SS') ORDER BY t.lastmodifieddate`,
        },
      });
      const payments: ProviderPayment[] = [];
      let latest = since;
      for (const row of response.items) {
        payments.push({
          externalId: row.id,
          counterpartyExternalId: row.entity,
          direction: row.type === "VendPymt" ? "Payable" : "Receivable",
          amountMinor: abs(decimalToMinor(row.foreigntotal, await source.exponentOf(row.symbol))),
          currencyCode: row.symbol,
          paidOn: row.trandate,
          reference: row.tranid ?? null,
        });
        if (row.lastmodified > latest) latest = row.lastmodified;
      }
      return { payments, cursor: latest };
    },
  };
}

// Ramp ------------------------------------------------------------------------------------------------------------------

const RAMP = "https://api.ramp.com/developer/v1";

/**
 * Ramp is a spend platform, not a general ledger. Its Ledger Export projects the UPL account
 * dimension into Ramp (the mapped GL accounts of the fixed chart become Ramp's coding options), and
 * its Payment Sync brings paid Ramp bills in as Proposed payments. Ramp does not take payments from XOS.
 */
export function rampProvider(source: Pick<AccountingSource, "exponentOf">): AccountingProvider {
  return {
    provider: "ramp",
    label: "Ramp",
    async pushChart(context, accounts) {
      await callJson(context.http, "Ramp", {
        method: "POST",
        url: `${RAMP}/accounting/accounts`,
        token: token(context),
        json: {
          gl_accounts: accounts.map((a) => ({
            id: a.mapping.externalAccountId,
            code: a.code,
            name: a.name,
            classification: a.type.toUpperCase(),
          })),
        },
      });
      return accounts.length;
    },
    async listPayments(context, cursor) {
      let url: string | null =
        `${RAMP}/bills?payment_status=PAID&page_size=100${cursor ? `&from_paid_at=${encodeURIComponent(cursor)}` : ""}`;
      const payments: ProviderPayment[] = [];
      let latest = cursor;
      while (url !== null) {
        const page: {
          data: {
            id: string;
            vendor: { remote_id?: string; id: string };
            amount: { amount: number; currency_code: string };
            paid_at: string;
            invoice_number?: string;
          }[];
          page: { next: string | null };
        } = await callJson(context.http, "Ramp", { method: "GET", url, token: token(context) });
        for (const bill of page.data) {
          await source.exponentOf(bill.amount.currency_code);
          payments.push({
            externalId: bill.id,
            counterpartyExternalId: bill.vendor.remote_id ?? bill.vendor.id,
            direction: "Payable",
            // Ramp reports amounts in minor units already.
            amountMinor: BigInt(bill.amount.amount),
            currencyCode: bill.amount.currency_code,
            paidOn: bill.paid_at.slice(0, 10),
            reference: bill.invoice_number ?? null,
          });
          if (latest === null || bill.paid_at > latest) latest = bill.paid_at;
        }
        url = page.page.next;
        if (url !== null && !url.startsWith(`${RAMP}/`)) {
          throw new IntegrationError(
            "provider_malformed_response",
            "Ramp sent a next page outside its API.",
          );
        }
      }
      return { payments, cursor: latest };
    },
  };
}
