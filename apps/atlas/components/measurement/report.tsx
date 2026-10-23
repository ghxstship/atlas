import {
  OUTCOMES,
  inDisplayUnit,
  listEarnedMediaItems,
  listMeasurementCatalog,
  listMeasurementSummary,
  rollupByMetric,
  rollupByProject,
  type MeasurementCatalog,
  type MeasurementSummaryRow,
  type UnitPreference,
} from "@xos/data/measurements";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Figures, Section, SimpleTable } from "@/components/finance/figures";
import { FilterBar } from "@/components/finance/kit-filter-bar";
import { ViewSwitcher } from "@/components/finance/kit-view-switcher";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "@/components/finance/panels";
import { PageHeader, TemplateCollection } from "@/components/finance/ui";
import { ExportCsvButton } from "@/components/reports/client";
import { Chart } from "@/components/lazy-ui";
import type { FinancePage } from "@/lib/finance/context";
import { getFinanceCopy, type FinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { getShellSettings } from "@/lib/shell/org-settings";
import { figureText, metricLabel, outcomeLabel, type MeasurementT } from "./format";
import { CoverageTable } from "./coverage-table";
import { SummaryTable, summaryCsv, summaryHeader, summaryLines, type SummaryLine } from "./summary";

/**
 * Reports > Objectives and Measurement (A98, Section 4.10, finding A65-030). For one project (`?project=KEY`): every
 * metric's gate 1 objective against what was measured, in the person's units, and the earned media coverage behind
 * the gate 8 figures. For the org: how each project's objectives stand, and each figure across the projects that
 * measured it. A figure nothing measured reads Unmeasured, never 0; a total over some unmeasured figures says so.
 * Every view has a table; the chart loads on demand and keeps its table beside it. Export uses the report CSV path.
 */
const NODE = "reports.measurement";

/**
 * The report's frame, as the built-in reports have it: title, views, the project filter on the org page and the CSV
 * export of what the report shows (Section 4.6.4) through the reports' ExportCsvButton. Kept here rather than imported
 * from the other reports, whose module carries the eagerly loaded chart into every route that imports it (ADR 0027).
 */
function Frame({
  page,
  c,
  exportData,
  children,
}: {
  page: FinancePage;
  c: FinanceCopy;
  exportData?: { filename: string; header: string[]; rows: string[][] } | undefined;
  children: ReactNode;
}) {
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={c.t(getNode(sitemap, NODE).node.label)}
          views={<ViewSwitcher views={page.views} value={page.view} />}
          actions={
            exportData && exportData.rows.length > 0 ? (
              <ExportCsvButton
                filename={exportData.filename}
                header={exportData.header}
                rows={exportData.rows}
                label={c.t("reports.exportCsv")}
              />
            ) : undefined
          }
        />
      }
      filters={
        page.inProject ? null : (
          <FilterBar
            projects={page.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))}
            project={page.query.project}
            showSearch={false}
          />
        )
      }
    >
      <div className="flex flex-col gap-16">{children}</div>
    </TemplateCollection>
  );
}

function refused(page: FinancePage, c: FinanceCopy) {
  return (
    <TemplateCollection header={<PageHeader title={c.t(getNode(sitemap, NODE).node.label)} />}>
      <RefusalPanel capability="projects.gate.read" href={`/${page.ctx.org.slug}/home`} />
    </TemplateCollection>
  );
}

function failed(page: FinancePage, c: FinanceCopy) {
  return (
    <Frame page={page} c={c}>
      <ErrorPanel sentence={c.t("reports.loadError")} />
    </Frame>
  );
}

export async function MeasurementReport({ page }: { page: FinancePage }) {
  const c = await getFinanceCopy(page.ctx);
  if (!page.access.can("projects.gate.read")) return refused(page, c);
  const db = page.ctx.viewer.db;
  const [catalog, summary, shell, translations, locale] = await Promise.all([
    listMeasurementCatalog(db),
    listMeasurementSummary(db, { orgId: page.ctx.org.id, projectId: page.project?.id ?? null }),
    getShellSettings(db, page.ctx.org.id, null),
    getTranslations("measurement"),
    getLocale(),
  ]);
  if (!catalog.ok || !summary.ok) return failed(page, c);
  const t = translations as unknown as MeasurementT;
  const view = {
    page,
    c,
    t,
    locale,
    catalog: catalog.data,
    rows: summary.data,
    preference: shell.preferences.units,
    canExport: page.access.can("reports.report.export"),
  };
  return page.project ? (
    <ProjectReport {...view} project={page.project} />
  ) : (
    <OrgReport {...view} />
  );
}

interface ReportView {
  readonly page: FinancePage;
  readonly c: FinanceCopy;
  readonly t: MeasurementT;
  readonly locale: string;
  readonly catalog: MeasurementCatalog;
  readonly rows: readonly MeasurementSummaryRow[];
  readonly preference: UnitPreference;
  readonly canExport: boolean;
}

function outcomeCounts(lines: readonly { readonly outcome: SummaryLine["outcome"] }[]) {
  return OUTCOMES.map((o) => lines.filter((l) => l.outcome === o).length);
}

function OutcomeFigures({ t, c, counts }: { t: MeasurementT; c: FinanceCopy; counts: number[] }) {
  const [met = 0, notMet = 0, incomplete = 0, unmeasured = 0] = counts;
  return (
    <Figures
      label={t("report.summary")}
      items={[
        { label: t("report.objectives"), value: c.number(met + notMet + incomplete + unmeasured) },
        { label: outcomeLabel(t, "Met"), value: c.number(met), tone: "success" },
        { label: outcomeLabel(t, "Not Met"), value: c.number(notMet), tone: "danger" },
        {
          label: t("report.openOutcomes"),
          value: c.number(incomplete + unmeasured),
          tone: "warning",
          caption: t("report.openCaption", { incomplete, unmeasured }),
        },
      ]}
    />
  );
}

function empty(page: FinancePage, t: MeasurementT): ReactNode {
  return (
    <EmptyPanel
      icon="Gauge"
      sentence={t("report.empty")}
      actionLabel={t("report.emptyAction")}
      href={`/${page.ctx.org.slug}/projects`}
    />
  );
}

// One project --------------------------------------------------------------------------------------------------------

async function ProjectReport({
  page,
  c,
  t,
  locale,
  catalog,
  rows,
  preference,
  canExport,
  project,
}: ReportView & { project: NonNullable<FinancePage["project"]> }) {
  const coverage = await listEarnedMediaItems(page.ctx.viewer.db, project.id);
  if (!coverage.ok) return failed(page, c);
  const lines = summaryLines(t, locale, catalog, rows, project.id, preference);
  const counts = outcomeCounts(lines);
  const header = [c.t("finance.common.project"), ...summaryHeader(t)];
  const csv = summaryCsv(lines).map((r) => [project.key, ...r]);
  const gates = `/${page.ctx.org.slug}/p/${project.key}/gates`;
  const table = (
    <SummaryTable
      t={t}
      lines={lines}
      caption={t("report.projectCaption", { project: project.key })}
      date={c.date}
    />
  );
  return (
    <Frame
      page={page}
      c={c}
      exportData={
        canExport ? { filename: `measurement-${project.key}.csv`, header, rows: csv } : undefined
      }
    >
      <OutcomeFigures t={t} c={c} counts={counts} />
      <p className="m-0 text-text-13 text-text-secondary">
        {t("report.projectLead")}{" "}
        <Link href={gates as Route} className="text-accent-text underline">
          {t("report.openGates", { project: project.key })}
        </Link>
      </p>
      {page.view === "chart" ? (
        <div className="flex flex-col gap-12">
          <Chart
            type="bar"
            title={t("report.chartTitle")}
            categoryLabel={t("summary.outcome")}
            categories={OUTCOMES.map((o) => outcomeLabel(t, o))}
            series={[{ name: t("report.objectives"), values: counts }]}
          />
          {table}
        </div>
      ) : (
        table
      )}
      <Section id="report-coverage" title={t("coverage.title")}>
        {coverage.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("coverage.empty")}</p>
        ) : (
          <CoverageTable
            t={t}
            locale={locale}
            date={c.date}
            items={coverage.data}
            withdraw={null}
          />
        )}
      </Section>
    </Frame>
  );
}

// The org ------------------------------------------------------------------------------------------------------------

function OrgReport({ page, c, t, locale, catalog, rows, preference, canExport }: ReportView) {
  const org = page.ctx.org.slug;
  const projectOf = new Map(page.projects.map((p) => [p.id, p]));
  const byProject = rollupByProject(rows)
    .map((r) => ({ ...r, project: projectOf.get(r.projectId) }))
    .filter((r) => r.project !== undefined)
    .sort((a, b) => (a.project?.key ?? "").localeCompare(b.project?.key ?? ""));
  const byMetric = rollupByMetric(catalog.metrics, rows);
  const metricOf = new Map(catalog.metrics.map((m) => [m.code, m]));
  const counts = OUTCOMES.map((o) => byProject.reduce((n, r) => n + r.outcomes[o], 0));

  // The export is the long form: every project's every metric that has an objective or a figure.
  const header = [c.t("finance.common.project"), ...summaryHeader(t)];
  const csv = byProject.flatMap((r) =>
    summaryCsv(
      summaryLines(t, locale, catalog, rows, r.projectId, preference).filter(
        (l) => l.objective !== null || l.measuredCount > 0 || l.unmeasured > 0,
      ),
    ).map((cells) => [r.project?.key ?? "", ...cells]),
  );

  const projectHead = [
    c.t("finance.common.project"),
    t("report.objectives"),
    ...OUTCOMES.map((o) => outcomeLabel(t, o)),
  ];
  const projectRows = byProject.map((r) => [
    <Link
      key="p"
      href={
        `/${org}/reports/measurement?project=${encodeURIComponent(r.project?.key ?? "")}` as Route
      }
      className="text-accent-text underline"
    >
      {r.project?.key} · {r.project?.name}
    </Link>,
    c.number(r.objectives),
    ...OUTCOMES.map((o) => c.number(r.outcomes[o])),
  ]);
  const projectTable = (
    <SimpleTable
      caption={t("report.byProjectCaption")}
      head={projectHead}
      rows={projectRows}
      numeric={[1, 2, 3, 4, 5]}
    />
  );

  let body: ReactNode;
  if (rows.length === 0) {
    body = empty(page, t);
  } else {
    body = (
      <>
        <OutcomeFigures t={t} c={c} counts={counts} />
        <Section id="report-by-project" title={t("report.byProject")}>
          {page.view === "chart" ? (
            <div className="flex flex-col gap-12">
              <Chart
                type="bar"
                title={t("report.orgChartTitle")}
                categoryLabel={c.t("finance.common.project")}
                categories={byProject.map((r) => r.project?.key ?? "")}
                series={OUTCOMES.map((o) => ({
                  name: outcomeLabel(t, o),
                  values: byProject.map((r) => r.outcomes[o]),
                }))}
              />
              {projectTable}
            </div>
          ) : (
            projectTable
          )}
        </Section>
        <Section id="report-by-metric" title={t("report.byMetric")}>
          <SimpleTable
            caption={t("report.byMetricCaption")}
            head={[
              t("summary.metric"),
              t("report.orgFigure"),
              t("report.projectsMeasured"),
              t("report.projectsUnmeasured"),
            ]}
            numeric={[2, 3]}
            rows={byMetric.map((m) => {
              const metric = metricOf.get(m.metricCode);
              const shown = metric
                ? inDisplayUnit(m.value, metric.dimension, catalog.units, preference)
                : { value: null, unit: null };
              const text = figureText(t, locale, shown.value, shown.unit?.code ?? null);
              return [
                metricLabel(t, m.metricCode),
                <span key="v" className="flex flex-col gap-2">
                  <span className={m.value === null ? "text-text-secondary" : undefined}>
                    {m.value !== null && metric?.aggregation === "Latest"
                      ? t("report.mean", { figure: text })
                      : text}
                  </span>
                  {m.projectsPartial > 0 ? (
                    <span className="text-text-12 text-text-secondary">
                      {t("report.partialProjects", { count: m.projectsPartial })}
                    </span>
                  ) : null}
                </span>,
                c.number(m.projectsMeasured),
                c.number(m.projectsUnmeasured),
              ];
            })}
          />
        </Section>
      </>
    );
  }
  return (
    <Frame
      page={page}
      c={c}
      exportData={canExport ? { filename: "measurement.csv", header, rows: csv } : undefined}
    >
      {body}
    </Frame>
  );
}
