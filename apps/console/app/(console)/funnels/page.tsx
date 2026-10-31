import { getConsoleFunnels, type ConsoleFunnel, type FunnelAlert } from "@xos/data/console-funnels";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { Empty, PageHeader, Section, Table } from "@/components/page";
import { acknowledgeFunnelAlertAction } from "@/lib/actions/funnels";
import { getConsoleFormat, type ConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("funnels.title") };
}

/** A rate from 0 to 1 as a whole percent in the reader's locale, or a dash when there is none. */
function percent(format: ConsoleFormat, rate: number | null): string {
  return rate === null
    ? format.t("funnels.noRate")
    : new Intl.NumberFormat(format.locale, { style: "percent" }).format(rate);
}

function workflowName(format: ConsoleFormat, code: string): string {
  return format.label("funnels.workflows", code.replace(".", "_"));
}

function AlertList({ alerts, format }: { alerts: readonly FunnelAlert[]; format: ConsoleFormat }) {
  const { t, label, instant, number } = format;
  return (
    <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="funnel-alerts">
      {alerts.map((a) => (
        <li
          key={a.id}
          className="flex flex-col gap-8 rounded-card border border-border-subtle p-12 text-text-13"
        >
          <span className="flex flex-wrap gap-8">
            <span className="font-medium">{workflowName(format, a.workflow)}</span>
            <span>{t("funnels.team", { team: label("funnels.teams", a.owningTeam) })}</span>
            <span className="text-text-secondary">
              {a.resolvedAt
                ? t("funnels.resolvedAt", { when: instant(a.resolvedAt) })
                : t("funnels.raisedAt", { when: instant(a.raisedAt) })}
            </span>
          </span>
          <span>
            {t("funnels.alertFigures", {
              rate: percent(format, a.completionRate),
              target: percent(format, a.targetCompletion),
              baseline: percent(format, a.baselineRate),
              started: number(a.startedSessions),
            })}
          </span>
          <span className="text-text-12 text-text-secondary">
            {[
              a.belowTarget ? t("funnels.reasons.belowTarget") : null,
              a.belowBaseline ? t("funnels.reasons.belowBaseline") : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </span>
          {a.acknowledgedAt ? (
            <span className="text-text-12 text-text-secondary">
              {t("funnels.acknowledgedBy", {
                name: a.acknowledgedByName ?? t("common.unknownPerson"),
                when: instant(a.acknowledgedAt),
              })}
            </span>
          ) : a.resolvedAt ? null : (
            <ActionForm
              action={acknowledgeFunnelAlertAction}
              hidden={{ alertId: a.id }}
              submitLabel={t("funnels.acknowledge")}
              successLabel={t("funnels.acknowledged")}
              variant="secondary"
              label={t("funnels.acknowledgeLabel", { workflow: workflowName(format, a.workflow) })}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function funnelRow(format: ConsoleFormat, f: ConsoleFunnel) {
  const { t, label, number } = format;
  return {
    key: f.workflow,
    cells: [
      workflowName(format, f.workflow),
      label("funnels.teams", f.owningTeam),
      f.stages.map((n) => number(n)).join(" › "),
      percent(format, f.completionRate),
      percent(format, f.baselineRate),
      percent(format, f.targetCompletion),
      t(`funnels.statuses.${f.status.replace(/ /g, "")}`),
    ],
  };
}

/**
 * Workflow funnels (A146, Section 11.14): each Sections 11.11 to 11.13 workflow's funnel over the last 24 hours
 * against its target and the 7 days before, and the regression alerts the hourly check raised for the owning team.
 * Counts only; no person, org or path.
 */
export default async function FunnelsPage() {
  const ctx = await requirePermission("tenants.read");
  const format = await getConsoleFormat();
  const { t, instant } = format;
  const result = await getConsoleFunnels(ctx.db);
  if (!result.ok) {
    return (
      <>
        <PageHeader title={t("funnels.title")} intro={t("funnels.intro")} />
        <Empty>{t("common.loadError")}</Empty>
      </>
    );
  }
  const open = result.data.alerts.filter((a) => a.resolvedAt === null);
  const resolved = result.data.alerts.filter((a) => a.resolvedAt !== null);
  return (
    <>
      <PageHeader title={t("funnels.title")} intro={t("funnels.intro")}>
        <p className="m-0 text-text-12 text-text-secondary">
          {t("funnels.checkedAt", { when: instant(result.data.checkedAt) })}
        </p>
      </PageHeader>
      <Section id="funnel-alerts" title={t("funnels.openAlerts")} intro={t("funnels.alertsIntro")}>
        {open.length === 0 ? (
          <Empty>{t("funnels.noAlerts")}</Empty>
        ) : (
          <AlertList alerts={open} format={format} />
        )}
      </Section>
      <Section id="funnel-list" title={t("funnels.funnels")} intro={t("funnels.funnelsIntro")}>
        <Table
          caption={t("funnels.funnels")}
          testId="funnels"
          columns={[
            t("funnels.workflow"),
            t("funnels.owningTeam"),
            t("funnels.stages"),
            t("funnels.completion"),
            t("funnels.baseline"),
            t("funnels.target"),
            t("funnels.status"),
          ]}
          rows={result.data.funnels.map((f) => funnelRow(format, f))}
        />
      </Section>
      {resolved.length > 0 ? (
        <Section id="funnel-resolved" title={t("funnels.resolvedAlerts")}>
          <AlertList alerts={resolved} format={format} />
        </Section>
      ) : null}
    </>
  );
}
