import { totalsByCurrency, type ExternalRow, type Payment } from "@xos/data/gateway";
import { minorDigits } from "./format";

/**
 * Money overview (Section 4.5.8: earned, pending, next payment). Earned is what orgs paid; pending
 * is what open invoices still owe; the next payment is the open invoice due soonest. Totals stay
 * per currency, and a missing amount stays missing.
 */
export function moneyOverview(input: {
  readonly payments: readonly Payment[];
  readonly invoices: readonly ExternalRow<"invoices">[];
  readonly today: string;
}) {
  const earned = totalsByCurrency(
    input.payments
      .filter((p) => p.state !== "Canceled")
      .map((p) => ({ amountMinor: p.amountMinor, currency: p.currency })),
  );
  const open = input.invoices.filter(
    (i) =>
      i.invoice_state !== "Canceled" &&
      i.balance_minor !== null &&
      i.balance_minor > 0 &&
      i.currency_code !== null,
  );
  const pending = totalsByCurrency(
    open.map((i) => ({
      amountMinor: i.balance_minor as number,
      currency: i.currency_code as string,
    })),
  );
  const next =
    [...open]
      .filter((i) => i.due_on !== null)
      .sort((a, b) => (a.due_on ?? "").localeCompare(b.due_on ?? ""))[0] ?? null;
  return { earned, pending, next };
}

/** Paid amounts by month for one currency, in major units for the chart (last six months). */
export function paidByMonth(
  payments: readonly Payment[],
  currency: string,
  today: string,
): { months: string[]; values: number[] } {
  const months: string[] = [];
  const end = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  const digits = minorDigits(currency);
  const values = months.map(
    (m) =>
      payments
        .filter((p) => p.currency === currency && p.paidOn?.startsWith(m) && p.state !== "Canceled")
        .reduce((sum, p) => sum + p.amountMinor, 0) /
      10 ** digits,
  );
  return { months, values };
}
