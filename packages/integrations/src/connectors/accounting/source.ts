import { unwrap, type DbClient } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";

/** One Universal Posting Line waiting for export (app.integration_ledger_queue, migration 0610). */
export interface LedgerLine {
  readonly journalEntryId: string;
  readonly memo: string;
  readonly postingLineId: string;
  readonly lineNumber: number;
  readonly date: string;
  readonly projectId: string | null;
  readonly accountCode: string;
  readonly costCenterCode: string | null;
  readonly urid: string | null;
  readonly counterpartyId: string | null;
  readonly description: string;
  readonly quantity: number | null;
  /** Signed minor units: debits positive, credits negative. */
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly exponent: number;
}

export interface AccountMapping {
  readonly externalAccountId: string;
  readonly taxCode: string | null;
}

/** An Approved payment waiting to be pushed (app.integration_payment_queue). */
export interface QueuedPayment {
  readonly paymentId: string;
  readonly counterpartyId: string;
  readonly counterpartyExternalId: string | null;
  readonly direction: "Payable" | "Receivable";
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly exponent: number;
  readonly paidOn: string;
  readonly reference: string | null;
}

export interface PaymentApplication {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountMinor: bigint;
}

/** A payment as the provider holds it, normalized to minor units. */
export interface ProviderPayment {
  readonly externalId: string;
  readonly counterpartyExternalId: string;
  readonly direction: "Payable" | "Receivable";
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly paidOn: string;
  readonly reference: string | null;
}

export interface ChartAccount {
  readonly code: string;
  readonly name: string;
  readonly type: string;
}

/** The domain reads and writes accounting connectors need. */
export interface AccountingSource {
  ledgerQueue(connectionId: string, limit: number): Promise<readonly LedgerLine[]>;
  accountMappings(connectionId: string): Promise<ReadonlyMap<string, AccountMapping>>;
  paymentQueue(connectionId: string, limit: number): Promise<readonly QueuedPayment[]>;
  paymentApplications(paymentIds: readonly string[]): Promise<readonly PaymentApplication[]>;
  recordProviderPayment(connectionId: string, payment: ProviderPayment): Promise<string>;
  chartAccounts(): Promise<readonly ChartAccount[]>;
  exponentOf(currencyCode: string): Promise<number>;
}

interface LedgerRow {
  journal_entry_id: string;
  memo: string;
  posting_line_id: string;
  line_number: number;
  date: string;
  project_id: string | null;
  account_code: string;
  cost_center_code: string | null;
  urid: string | null;
  counterparty_id: string | null;
  description: string;
  quantity: number | null;
  amount_minor: number | string;
  currency_code: string;
  minor_unit_exponent: number;
}

interface PaymentRow {
  payment_id: string;
  counterparty_id: string;
  counterparty_external_id: string | null;
  direction: "Payable" | "Receivable";
  amount_minor: number | string;
  currency_code: string;
  minor_unit_exponent: number;
  paid_on: string;
  reference_identifier: string | null;
}

/**
 * The accounting source over the service-role client (schema `app`) and a canon client (schema
 * `xpms`) for the fixed chart. Amounts arrive as numbers or strings and become bigint, so no
 * floating point ever touches money.
 */
export function supabaseAccountingSource(db: DbClient, canon: DbClient): AccountingSource {
  return {
    async ledgerQueue(connectionId, limit) {
      const rows = await unwrap<LedgerRow[]>(
        db
          .from("integration_ledger_queue")
          .select("*")
          .eq("integration_connection_id", connectionId)
          .order("journal_entry_id")
          .order("line_number")
          .limit(limit),
      );
      return rows.map((r) => ({
        journalEntryId: r.journal_entry_id,
        memo: r.memo,
        postingLineId: r.posting_line_id,
        lineNumber: r.line_number,
        date: r.date,
        projectId: r.project_id,
        accountCode: r.account_code,
        costCenterCode: r.cost_center_code,
        urid: r.urid,
        counterpartyId: r.counterparty_id,
        description: r.description,
        quantity: r.quantity,
        amountMinor: BigInt(r.amount_minor),
        currencyCode: r.currency_code,
        exponent: r.minor_unit_exponent,
      }));
    },
    async accountMappings(connectionId) {
      const rows = await unwrap<
        { account_code: string; external_account_id: string; external_tax_code: string | null }[]
      >(
        db
          .from("integration_account_mappings")
          .select("account_code, external_account_id, external_tax_code")
          .eq("integration_connection_id", connectionId)
          .is("deleted_at", null),
      );
      return new Map(
        rows.map((r) => [
          r.account_code,
          { externalAccountId: r.external_account_id, taxCode: r.external_tax_code },
        ]),
      );
    },
    async paymentQueue(connectionId, limit) {
      const rows = await unwrap<PaymentRow[]>(
        db
          .from("integration_payment_queue")
          .select("*")
          .eq("integration_connection_id", connectionId)
          .order("paid_on")
          .limit(limit),
      );
      return rows.map((r) => ({
        paymentId: r.payment_id,
        counterpartyId: r.counterparty_id,
        counterpartyExternalId: r.counterparty_external_id,
        direction: r.direction,
        amountMinor: BigInt(r.amount_minor),
        currencyCode: r.currency_code,
        exponent: r.minor_unit_exponent,
        paidOn: r.paid_on,
        reference: r.reference_identifier,
      }));
    },
    async paymentApplications(paymentIds) {
      if (paymentIds.length === 0) return [];
      const rows = await unwrap<
        { payment_id: string; invoice_id: string; amount_minor: number | string }[]
      >(
        db
          .from("payment_applications")
          .select("payment_id, invoice_id, amount_minor")
          .in("payment_id", paymentIds)
          .is("deleted_at", null),
      );
      return rows.map((r) => ({
        paymentId: r.payment_id,
        invoiceId: r.invoice_id,
        amountMinor: BigInt(r.amount_minor),
      }));
    },
    async recordProviderPayment(connectionId, payment) {
      return unwrap<string>(
        db.rpc("record_provider_payment", {
          p_connection_id: connectionId,
          p_external_id: payment.externalId,
          p_counterparty_external_id: payment.counterpartyExternalId,
          p_direction: payment.direction,
          p_amount_minor: payment.amountMinor.toString(),
          p_currency_code: payment.currencyCode,
          p_paid_on: payment.paidOn,
          p_reference: payment.reference,
        }),
      );
    },
    async chartAccounts() {
      const rows = await unwrap<
        { account_code: string; account_name: string; account_type: string }[]
      >(
        canon
          .from("dim_gl_account")
          .select("account_code, account_name, account_type")
          .order("account_code"),
      );
      return rows.map((r) => ({
        code: r.account_code,
        name: r.account_name,
        type: r.account_type,
      }));
    },
    async exponentOf(currencyCode) {
      const row = await unwrap<{ minor_unit_exponent: number } | null>(
        db
          .from("currencies")
          .select("minor_unit_exponent")
          .eq("currency_code", currencyCode)
          .maybeSingle(),
      );
      if (row === null) {
        throw new IntegrationError(
          "currency_unknown",
          `${currencyCode} is not an ISO 4217 currency the database knows.`,
        );
      }
      return row.minor_unit_exponent;
    },
  };
}
