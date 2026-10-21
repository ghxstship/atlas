import { listPayments, readView } from "@xos/data/gateway";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { PaymentSteps } from "@/components/engagement/payment-steps";
import { PageTitle, RegionError, Section } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { Card, EmptyStateLink } from "@/components/ui";
import { Chart } from "@/components/ui-chart";
import { formatMoney } from "@/lib/format";
import { personToday } from "@/lib/time-zone";
import { moneyOverview, paidByMonth } from "@/lib/money";
import { requireNode } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.money.overview") };
}

/** Money, Overview (Section 4.5.8): earned, pending and the next payment, with paid by month. */
export default async function MoneyOverviewPage() {
  const ctx = await requireNode("money.overview");
  const [t, locale, payments, invoices] = await Promise.all([
    getTranslate(),
    getLocale(),
    listPayments(ctx.db),
    readView(ctx.db, "invoices", { order: ["due_on", "asc"] }),
  ]);
  // Money from every org, on the person's own calendar (their locale.time_zone), not UTC's.
  const today = await personToday(ctx);
  const failed = !payments.ok || !invoices.ok;
  const overview = moneyOverview({
    payments: payments.ok ? payments.data : [],
    invoices: invoices.ok ? invoices.data : [],
    today,
  });
  const currency = overview.earned[0]?.currency ?? overview.pending[0]?.currency ?? null;
  const chart = currency && payments.ok ? paidByMonth(payments.data, currency, today) : null;
  const amounts = (rows: { currency: string; amountMinor: number }[]) =>
    rows.length === 0
      ? t("gateway.money.overview.none")
      : rows.map((r) => formatMoney(locale, r.amountMinor, r.currency)).join(" · ");
  return (
    <>
      <PageTitle title={t("nav.gateway.primary.money")} />
      <DestinationTabs ctx={ctx} destination="money" active="money.overview" t={t} />
      {failed ? <RegionError /> : null}
      {!failed && overview.earned.length === 0 && overview.pending.length === 0 ? (
        <EmptyStateLink
          icon="Wallet"
          sentence={t(
            // Someone the org never pays (client or sponsor) has nothing to earn (finding A59-033).
            [...(ctx.nav.conditions ?? [])].includes("paid-work")
              ? "gateway.money.overview.empty"
              : "gateway.money.overview.emptyUnpaid",
          )}
          actionLabel={t("gateway.money.overview.emptyAction")}
          href="/work/engagements"
        />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12">
            <Card title={t("gateway.money.overview.earned")}>
              <strong className="text-heading-20 font-semibold tabular-nums">
                {amounts(overview.earned)}
              </strong>
            </Card>
            <Card title={t("gateway.money.overview.pending")}>
              <strong className="text-heading-20 font-semibold tabular-nums">
                {amounts(overview.pending)}
              </strong>
            </Card>
          </div>
          {overview.next ? (
            <Section title={t("gateway.money.overview.next")}>
              <PaymentSteps invoice={overview.next} locale={locale} t={t} />
            </Section>
          ) : null}
          {chart && currency ? (
            <Section title={t("gateway.money.overview.chartTitle")}>
              <Chart
                type="bar"
                title={t("gateway.money.overview.chartTitle")}
                subtitle={t("gateway.money.overview.chartSubtitle", { currency })}
                categoryLabel={t("gateway.money.overview.month")}
                categories={chart.months}
                series={[{ name: t("gateway.money.overview.paid"), values: chart.values }]}
                format="money"
                currency={currency}
              />
            </Section>
          ) : null}
        </>
      )}
    </>
  );
}
