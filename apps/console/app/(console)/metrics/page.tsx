import { failureRate, getPlatformMetrics, type PlatformMetrics } from "@xos/data/console-metrics";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Chart, StatTile } from "@/components/metrics-charts";
import { Empty, PageHeader, Section, Table } from "@/components/page";
import { getConsoleFormat, type ConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("metrics.title") };
}

/** UTC calendar days and months (weeks start on Monday, months on the 1st, both in UTC). */
function dayFormats(locale: string) {
  const week = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const at = (day: string) => new Date(`${day}T00:00:00Z`);
  return {
    week: (day: string) => week.format(at(day)),
    month: (day: string) => month.format(at(day)),
  };
}

function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

function Growth({ m, f }: { m: PlatformMetrics; f: ConsoleFormat }) {
  const { t } = f;
  const days = dayFormats(f.locale);
  return (
    <Section id="growth" title={t("metrics.growth.title")} intro={t("metrics.growth.intro")}>
      <Tiles>
        <StatTile
          label={t("metrics.growth.liveOrgs")}
          value={m.orgs.live}
          caption={t("metrics.growth.clients", { count: m.orgs.clients })}
        />
        <StatTile
          label={t("metrics.growth.newOrgs")}
          value={m.weeks.reduce((sum, w) => sum + w.newOrgs, 0)}
          caption={t("metrics.growth.inWeeks", { count: m.weeks.length })}
        />
        <StatTile
          label={t("metrics.growth.signUps")}
          value={m.weeks.reduce((sum, w) => sum + w.signUps, 0)}
          caption={t("metrics.growth.inWeeks", { count: m.weeks.length })}
        />
        <StatTile label={t("metrics.growth.withAccount")} value={m.people.withAccount} />
      </Tiles>
      <Chart
        type="bar"
        title={t("metrics.growth.chart")}
        categoryLabel={t("metrics.week")}
        categories={m.weeks.map((w) => days.week(w.weekStart))}
        series={[
          { name: t("metrics.growth.newOrgs"), values: m.weeks.map((w) => w.newOrgs) },
          { name: t("metrics.growth.signUps"), values: m.weeks.map((w) => w.signUps) },
        ]}
      />
    </Section>
  );
}

function Active({ m, f }: { m: PlatformMetrics; f: ConsoleFormat }) {
  const { t } = f;
  return (
    <Section id="active" title={t("metrics.active.title")} intro={t("metrics.active.intro")}>
      <Tiles>
        <StatTile label={t("metrics.active.day")} value={m.people.active1d} />
        <StatTile label={t("metrics.active.week")} value={m.people.active7d} />
        <StatTile label={t("metrics.active.month")} value={m.people.active30d} />
      </Tiles>
    </Section>
  );
}

function Plans({ m, f }: { m: PlatformMetrics; f: ConsoleFormat }) {
  const { t, label, number } = f;
  return (
    <Section id="plans" title={t("metrics.plans.title")} intro={t("metrics.plans.intro")}>
      <Tiles>
        <StatTile label={t("metrics.plans.trialing")} value={m.trials.trialing} />
        <StatTile label={t("metrics.plans.ending")} value={m.trials.ending7d} />
        <StatTile
          label={t("metrics.plans.withoutSubscription")}
          value={m.orgs.withoutSubscription}
        />
      </Tiles>
      <Chart
        type="bar"
        title={t("metrics.plans.chart")}
        categoryLabel={t("metrics.plans.plan")}
        categories={m.plans.map((p) => label("plans", p.planCode))}
        series={[
          { name: t("subscription.trialing"), values: m.plans.map((p) => p.trialing) },
          { name: t("subscription.active"), values: m.plans.map((p) => p.active) },
          { name: t("subscription.past_due"), values: m.plans.map((p) => p.pastDue) },
          { name: t("subscription.read_only"), values: m.plans.map((p) => p.readOnly) },
        ]}
      />
      <Table
        caption={t("metrics.plans.title")}
        testId="metrics-plans"
        columns={[
          t("metrics.plans.plan"),
          t("metrics.plans.orgs"),
          t("subscription.trialing"),
          t("subscription.active"),
          t("subscription.past_due"),
          t("subscription.read_only"),
        ]}
        rows={m.plans.map((p) => ({
          key: p.planCode,
          cells: [
            label("plans", p.planCode),
            number(p.orgs),
            number(p.trialing),
            number(p.active),
            number(p.pastDue),
            number(p.readOnly),
          ],
        }))}
      />
    </Section>
  );
}

function Usage({ m, f }: { m: PlatformMetrics; f: ConsoleFormat }) {
  const { t, label, number } = f;
  const days = dayFormats(f.locale);
  return (
    <Section id="usage" title={t("metrics.usage.title")} intro={t("metrics.usage.intro")}>
      {m.usage.length === 0 ? (
        <Empty>{t("metrics.usage.none")}</Empty>
      ) : (
        <Table
          caption={t("metrics.usage.title")}
          testId="metrics-usage"
          columns={[
            t("metrics.usage.month"),
            t("metrics.usage.meter"),
            t("metrics.usage.quantity"),
            t("metrics.usage.orgs"),
          ]}
          rows={m.usage.map((u) => ({
            key: `${u.periodStart}-${u.meterCode}`,
            cells: [
              days.month(u.periodStart),
              label("metrics.meters", u.meterCode),
              t("metrics.usage.amount", {
                quantity: number(u.quantity),
                unit: label("metrics.units", u.unit),
              }),
              number(u.orgs),
            ],
          }))}
        />
      )}
    </Section>
  );
}

function Aurora({ m, f }: { m: PlatformMetrics; f: ConsoleFormat }) {
  const { t, label, number } = f;
  const days = dayFormats(f.locale);
  return (
    <Section id="aurora" title={t("metrics.aurora.title")} intro={t("metrics.aurora.intro")}>
      <Tiles>
        <StatTile label={t("metrics.aurora.requests")} value={m.aurora.requests30d} />
        <StatTile label={t("metrics.aurora.inputTokens")} value={m.aurora.inputTokens30d} />
        <StatTile label={t("metrics.aurora.outputTokens")} value={m.aurora.outputTokens30d} />
      </Tiles>
      <Chart
        type="line"
        title={t("metrics.aurora.chart")}
        categoryLabel={t("metrics.week")}
        categories={m.weeks.map((w) => days.week(w.weekStart))}
        series={[
          {
            name: t("metrics.aurora.requestsSeries"),
            values: m.weeks.map((w) => w.auroraRequests),
          },
        ]}
      />
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2">
        <Table
          caption={t("metrics.aurora.byOutcome")}
          testId="metrics-aurora-outcomes"
          columns={[t("metrics.aurora.outcome"), t("metrics.aurora.requestsSeries")]}
          rows={m.aurora.outcomes.map((o) => ({
            key: o.outcome,
            cells: [label("metrics.outcomes", o.outcome), number(o.requests)],
          }))}
        />
        <Table
          caption={t("metrics.aurora.byFeature")}
          testId="metrics-aurora-features"
          columns={[t("metrics.aurora.feature"), t("metrics.aurora.requestsSeries")]}
          rows={m.aurora.features.map((x) => ({
            key: x.feature,
            cells: [label("metrics.features", x.feature), number(x.requests)],
          }))}
        />
      </div>
    </Section>
  );
}

function Jobs({ m, f }: { m: PlatformMetrics; f: ConsoleFormat }) {
  const { t, number, instant } = f;
  return (
    <Section id="jobs" title={t("metrics.jobs.title")} intro={t("metrics.jobs.intro")}>
      {m.jobs.length === 0 ? (
        <Empty>{t("metrics.jobs.none")}</Empty>
      ) : (
        <Table
          caption={t("metrics.jobs.title")}
          testId="metrics-jobs"
          columns={[
            t("metrics.jobs.kind"),
            t("metrics.jobs.ready"),
            t("metrics.jobs.scheduled"),
            t("metrics.jobs.running"),
            t("metrics.jobs.stalled"),
            t("metrics.jobs.failed"),
            t("metrics.jobs.succeeded"),
            t("metrics.jobs.oldestReady"),
          ]}
          rows={m.jobs.map((j) => ({
            key: j.jobKind,
            cells: [
              <code key="kind">{j.jobKind}</code>,
              number(j.ready),
              number(j.scheduled),
              number(j.running),
              number(j.stalled),
              number(j.failed24h),
              number(j.succeeded24h),
              j.oldestReadyAt ? instant(j.oldestReadyAt) : t("common.none"),
            ],
          }))}
        />
      )}
    </Section>
  );
}

function Deliveries({ m, f }: { m: PlatformMetrics; f: ConsoleFormat }) {
  const { t, label, number, locale } = f;
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  return (
    <Section
      id="notifications"
      title={t("metrics.notifications.title")}
      intro={t("metrics.notifications.intro")}
    >
      <Table
        caption={t("metrics.notifications.title")}
        testId="metrics-notifications"
        columns={[
          t("metrics.notifications.channel"),
          t("metrics.notifications.total"),
          t("metrics.notifications.sent"),
          t("metrics.notifications.pending"),
          t("metrics.notifications.failed"),
          t("metrics.notifications.bounced"),
          t("metrics.notifications.suppressed"),
          t("metrics.notifications.failureRate"),
        ]}
        rows={m.notifications.map((c) => {
          const rate = failureRate(c);
          return {
            key: c.channel,
            cells: [
              label("metrics.channels", c.channel),
              number(c.total),
              number(c.sent),
              number(c.pending),
              number(c.failed),
              number(c.bounced),
              number(c.suppressed),
              rate === null ? t("common.none") : percent.format(rate),
            ],
          };
        })}
      />
    </Section>
  );
}

/**
 * Platform metrics (A137, Section 4.10): growth, active people, plans and trials, closed usage, Aurora, the job queue
 * and notification delivery, platform-wide. Read from XOS's own database through app.console_platform_metrics
 * (ADR 0046), aggregates only, so no figure names a tenant.
 */
export default async function MetricsPage() {
  const ctx = await requirePermission("tenants.read");
  const [result, f] = await Promise.all([getPlatformMetrics(ctx.db), getConsoleFormat()]);
  const { t, instant } = f;
  if (!result.ok) {
    return (
      <>
        <PageHeader title={t("metrics.title")} intro={t("metrics.intro")} />
        <Empty>{t("common.loadError")}</Empty>
      </>
    );
  }
  const m = result.data;
  return (
    <>
      <PageHeader title={t("metrics.title")} intro={t("metrics.intro")}>
        <p className="m-0 text-text-12 text-text-secondary" data-testid="metrics-generated">
          {t("metrics.generatedAt", { when: instant(m.generatedAt) })}
        </p>
      </PageHeader>
      <Growth m={m} f={f} />
      <Active m={m} f={f} />
      <Plans m={m} f={f} />
      <Usage m={m} f={f} />
      <Aurora m={m} f={f} />
      <Jobs m={m} f={f} />
      <Deliveries m={m} f={f} />
    </>
  );
}
