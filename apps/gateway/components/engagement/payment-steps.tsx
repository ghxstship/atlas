import { invoiceTrackerStep, type ExternalRow } from "@xos/data/gateway";
import { Icon } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { enumLabelKey, type Translate } from "@/lib/shell/translate";

/**
 * An invoice followed like a package (Section 11.12, Get paid): Submitted, Approved, Scheduled,
 * Paid, each with its date. Amounts are formatted in the invoice's own currency from minor units;
 * a missing amount reads Unpriced, never zero.
 */
export function PaymentSteps({
  invoice: inv,
  locale,
  t,
}: {
  invoice: ExternalRow<"invoices">;
  locale: string;
  t: Translate;
}) {
  const step = invoiceTrackerStep(inv);
  const date = (iso: string | null | undefined) => (iso ? formatDate(locale, iso) : "");
  const steps = [
    { key: "submitted", date: date(inv.submitted_at ?? inv.issued_at) },
    { key: "approved", date: date(inv.approved_at) },
    {
      key: "scheduled",
      date:
        step >= 2
          ? date(inv.last_paid_on)
          : inv.due_on
            ? t("gateway.money.invoices.due", { date: date(inv.due_on) })
            : "",
    },
    { key: "paid", date: step === 3 ? date(inv.last_paid_on) : "" },
  ];
  return (
    <section
      aria-label={t("gateway.money.invoices.tracker", { number: inv.invoice_number ?? "" })}
      className="flex flex-col gap-12 rounded-card border border-border-subtle bg-bg-raised p-16"
    >
      <div className="flex flex-wrap items-start justify-between gap-8">
        <div className="flex flex-col">
          <span className="font-mono text-text-12 text-text-secondary">{inv.invoice_number}</span>
          <strong className="font-semibold">
            {[inv.org_name, inv.project_name].filter(Boolean).join(" · ")}
          </strong>
          {inv.invoice_state ? (
            <span className="text-text-12 text-text-secondary">
              {t(enumLabelKey("invoiceState", inv.invoice_state))}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col items-end">
          <strong className="text-heading-16 font-semibold tabular-nums">
            {formatMoney(locale, inv.total_minor, inv.currency_code) ??
              t("gateway.common.unpriced")}
          </strong>
          <span className="text-text-12 text-text-secondary tabular-nums">
            {t("gateway.money.invoices.balance", {
              amount:
                formatMoney(locale, inv.balance_minor, inv.currency_code) ??
                t("gateway.common.unpriced"),
            })}
          </span>
        </div>
      </div>
      <ol className="m-0 grid grid-cols-4 gap-8 p-0 list-none">
        {steps.map((s, i) => {
          const state = i < step ? "done" : i === step ? "current" : "todo";
          return (
            <li
              key={s.key}
              aria-current={state === "current" ? "step" : undefined}
              className={`flex flex-col gap-4 border-t-(length:--stroke-width-accent) pt-6 text-text-12 ${
                state === "done"
                  ? "border-t-success"
                  : state === "current"
                    ? "border-t-accent font-medium"
                    : "border-t-border-subtle text-text-secondary"
              }`}
            >
              <span className="inline-flex items-center gap-4">
                {state === "done" ? (
                  <span className="text-success">
                    <Icon name="Check" size={12} />
                  </span>
                ) : null}
                {t(`gateway.money.invoices.steps.${s.key}`)}
              </span>
              <span className="tabular-nums text-text-secondary">{s.date}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
