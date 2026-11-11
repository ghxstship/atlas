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

/**
 * Paid amounts by month for one currency, in major units for the chart (last six months). `months` are the ISO
 * months (YYYY-MM) the amounts belong to; `labels` name them in the person's locale for the axis, with the year only
 * when the six months cross one. `paid` is false when nothing was paid in them, so the page shows a sentence instead
 * of an all-zero chart.
 */
export function paidByMonth(
  payments: readonly Payment[],
  currency: string,
  today: string,
  locale: string,
): { months: string[]; labels: string[]; values: number[]; paid: boolean } {
  const starts: Date[] = [];
  const end = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCMonth(d.getUTCMonth() - i);
    starts.push(d);
  }
  const months = starts.map((d) => d.toISOString().slice(0, 7));
  const oneYear = months[0]?.slice(0, 4) === months[months.length - 1]?.slice(0, 4);
  const label = new Intl.DateTimeFormat(locale, {
    month: "short",
    ...(oneYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
  const digits = minorDigits(currency);
  const values = months.map(
    (m) =>
      payments
        .filter((p) => p.currency === currency && p.paidOn?.startsWith(m) && p.state !== "Canceled")
        .reduce((sum, p) => sum + p.amountMinor, 0) /
      10 ** digits,
  );
  return {
    months,
    labels: starts.map((d) => label.format(d)),
    values,
    paid: values.some((v) => v !== 0),
  };
}
