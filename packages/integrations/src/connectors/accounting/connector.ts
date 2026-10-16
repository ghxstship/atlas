import type { ProviderCode } from "../../framework/catalog.ts";
import {
  ItemTally,
  type Connector,
  type SyncContext,
  type SyncOutcome,
} from "../../framework/connector.ts";
import { StoreError } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";
import type {
  AccountingSource,
  AccountMapping,
  ChartAccount,
  LedgerLine,
  ProviderPayment,
  QueuedPayment,
} from "./source.ts";

/** A journal entry ready to project: balanced, one currency, every account mapped. */
export interface Journal {
  readonly journalEntryId: string;
  readonly memo: string;
  readonly date: string;
  readonly currencyCode: string;
  readonly exponent: number;
  readonly lines: readonly (LedgerLine & { readonly mapping: AccountMapping })[];
}

export interface PushResult {
  readonly externalId: string;
  readonly version?: string | null;
}

export interface PaymentPush {
  readonly payment: QueuedPayment;
  /** Applications whose invoice is mapped in this connection, with the provider invoice or bill id. */
  readonly applications: readonly {
    readonly invoiceExternalId: string;
    readonly amountMinor: bigint;
  }[];
}

export interface PaymentPage {
  readonly payments: readonly ProviderPayment[];
  readonly cursor: string | null;
}

/** What each accounting provider client implements. A missing method means the provider does not do it. */
export interface AccountingProvider {
  readonly provider: ProviderCode;
  readonly label: string;
  pushJournal?(context: SyncContext, journal: Journal): Promise<PushResult>;
  pushChart?(
    context: SyncContext,
    accounts: readonly (ChartAccount & { readonly mapping: AccountMapping })[],
  ): Promise<number>;
  pushPayment?(context: SyncContext, push: PaymentPush): Promise<PushResult>;
  listPayments?(context: SyncContext, cursor: string | null): Promise<PaymentPage>;
}

const QUEUE_LIMIT = 2000;

type GroupResult =
  | { readonly journal: Journal }
  | { readonly code: string; readonly message: string; readonly journalEntryId: string };

/** Groups queued lines into journals and checks each one: balanced, one currency, every account mapped. */
export function groupJournals(
  lines: readonly LedgerLine[],
  mappings: ReadonlyMap<string, AccountMapping>,
): GroupResult[] {
  const byEntry = new Map<string, LedgerLine[]>();
  for (const line of lines) {
    const group = byEntry.get(line.journalEntryId) ?? [];
    group.push(line);
    byEntry.set(line.journalEntryId, group);
  }
  const results: GroupResult[] = [];
  for (const [journalEntryId, group] of byEntry) {
    const sorted = [...group].sort((a, b) => a.lineNumber - b.lineNumber);
    const first = sorted[0] as LedgerLine;
    const currencies = new Set(sorted.map((l) => l.currencyCode));
    if (currencies.size > 1) {
      results.push({
        journalEntryId,
        code: "journal_mixed_currency",
        message: `Journal ${journalEntryId} mixes ${[...currencies].join(" and ")}.`,
      });
      continue;
    }
    const total = sorted.reduce((sum, l) => sum + l.amountMinor, 0n);
    if (total !== 0n) {
      results.push({
        journalEntryId,
        code: "journal_unbalanced",
        message: `Journal ${journalEntryId} is off by ${total} minor units.`,
      });
      continue;
    }
    const unmapped = [
      ...new Set(sorted.filter((l) => !mappings.has(l.accountCode)).map((l) => l.accountCode)),
    ];
    if (unmapped.length > 0) {
      results.push({
        journalEntryId,
        code: "account_unmapped",
        message: `GL ${unmapped.join(", ")} has no provider account mapped.`,
      });
      continue;
    }
    results.push({
      journal: {
        journalEntryId,
        memo: first.memo,
        date: first.date,
        currencyCode: first.currencyCode,
        exponent: first.exponent,
        lines: sorted.map((l) => ({
          ...l,
          mapping: mappings.get(l.accountCode) as AccountMapping,
        })),
      },
    });
  }
  return results;
}

async function exportLedger(
  provider: AccountingProvider,
  source: AccountingSource,
  context: SyncContext,
): Promise<SyncOutcome> {
  const tally = new ItemTally(context);
  const connectionId = context.connection.id;
  const mappings = await source.accountMappings(connectionId);
  if (provider.pushChart) {
    const chart = await source.chartAccounts();
    const mapped = chart.flatMap((a) => {
      const mapping = mappings.get(a.code);
      return mapping ? [{ ...a, mapping }] : [];
    });
    tally.read = chart.length;
    tally.skipped = chart.length - mapped.length;
    tally.written = mapped.length === 0 ? 0 : await provider.pushChart(context, mapped);
    return { counts: tally.counts(), cursorAfter: context.cursor };
  }
  if (!provider.pushJournal) {
    throw new IntegrationError(
      "scope_unsupported",
      `${provider.label} does not take ledger exports.`,
    );
  }
  const lines = await source.ledgerQueue(connectionId, QUEUE_LIMIT);
  for (const result of groupJournals(lines, mappings)) {
    tally.read += 1;
    if (!("journal" in result)) {
      await tally.fail(result.code, result.message, {
        entity: "Journal Entry",
        localId: result.journalEntryId,
      });
      continue;
    }
    const pushed = await provider.pushJournal(context, result.journal);
    await context.store.upsertExternalId(connectionId, {
      entity: "Journal Entry",
      localId: result.journal.journalEntryId,
      externalId: pushed.externalId,
      externalVersion: pushed.version ?? null,
      contentHash: null,
    });
    tally.written += 1;
  }
  return { counts: tally.counts(), cursorAfter: context.cursor };
}

async function pushPayments(
  provider: AccountingProvider,
  source: AccountingSource,
  context: SyncContext,
  tally: ItemTally,
) {
  if (!provider.pushPayment) {
    throw new IntegrationError(
      "direction_unsupported",
      `${provider.label} does not take payments from XOS.`,
    );
  }
  const connectionId = context.connection.id;
  const queue = await source.paymentQueue(connectionId, QUEUE_LIMIT);
  const applications = await source.paymentApplications(queue.map((p) => p.paymentId));
  const invoiceIds = new Map(
    (await context.store.externalIds(connectionId, "Invoice")).map((x) => [
      x.localId,
      x.externalId,
    ]),
  );
  for (const payment of queue) {
    tally.read += 1;
    if (payment.counterpartyExternalId === null) {
      await tally.fail(
        "counterparty_unmapped",
        "The payment's counterparty has no provider contact mapped.",
        {
          entity: "Payment",
          localId: payment.paymentId,
        },
      );
      continue;
    }
    const own = applications.filter((a) => a.paymentId === payment.paymentId);
    const unmappedInvoice = own.find((a) => !invoiceIds.has(a.invoiceId));
    if (unmappedInvoice) {
      await tally.fail(
        "invoice_unmapped",
        "An invoice the payment applies to has not been exported to the provider.",
        {
          entity: "Invoice",
          localId: unmappedInvoice.invoiceId,
        },
      );
      continue;
    }
    const pushed = await provider.pushPayment(context, {
      payment,
      applications: own.map((a) => ({
        invoiceExternalId: invoiceIds.get(a.invoiceId) as string,
        amountMinor: a.amountMinor,
      })),
    });
    await context.store.upsertExternalId(connectionId, {
      entity: "Payment",
      localId: payment.paymentId,
      externalId: pushed.externalId,
      externalVersion: pushed.version ?? null,
      contentHash: null,
    });
    tally.written += 1;
  }
}

async function pullPayments(
  provider: AccountingProvider,
  source: AccountingSource,
  context: SyncContext,
  tally: ItemTally,
) {
  if (!provider.listPayments) {
    throw new IntegrationError(
      "direction_unsupported",
      `${provider.label} does not send payments to XOS.`,
    );
  }
  const page = await provider.listPayments(context, context.cursor);
  const known = new Set(
    (await context.store.externalIds(context.connection.id, "Payment")).map((x) => x.externalId),
  );
  for (const payment of page.payments) {
    tally.read += 1;
    if (known.has(payment.externalId)) {
      tally.skipped += 1;
      continue;
    }
    try {
      await source.recordProviderPayment(context.connection.id, payment);
      tally.written += 1;
    } catch (error) {
      if (error instanceof StoreError && error.error.kind !== "unexpected") {
        const message = error.error.kind === "refusal" ? error.error.message : error.message;
        const code =
          error.error.kind === "refusal"
            ? error.error.rule
            : `payment_${error.error.kind.replace("-", "_")}`;
        await tally.fail(code, message, { entity: "Payment", externalId: payment.externalId });
        continue;
      }
      throw error;
    }
  }
  return page.cursor;
}

/** Builds the Connector for one accounting provider over the shared ledger and payment logic. */
export function accountingConnector(
  provider: AccountingProvider,
  source: AccountingSource,
): Connector {
  return {
    provider: provider.provider,
    scopes: ["Ledger Export", "Payment Sync"],
    async sync(context) {
      if (context.run.scope === "Ledger Export") return exportLedger(provider, source, context);
      const tally = new ItemTally(context);
      let cursor = context.cursor;
      if (context.run.direction !== "Inbound") await pushPayments(provider, source, context, tally);
      if (context.run.direction !== "Outbound")
        cursor = await pullPayments(provider, source, context, tally);
      return { counts: tally.counts(), cursorAfter: cursor };
    },
  };
}
