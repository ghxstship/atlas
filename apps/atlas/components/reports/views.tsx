import type { DepartmentCode, PhaseCode } from "@xos/ui";
import {
  BUDGET_DIMENSIONS,
  MATRIX_SOURCES,
  type MatrixSource,
  budgetVersusActual,
  coordinateMatrix,
  finalCostReport,
  gateReadiness,
  incidentsReport,
  laborReport,
  purchaseOrderExposure,
  type BudgetDimension,
} from "@xos/data/reports";
import { listGlAccounts } from "@xos/data/finance";
import { listGateCriteria } from "@xos/data/projects";
import { getNode } from "@xos/ia";
import { workflowMarker } from "@xos/data/workflow-signal";
import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy, type FinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { Figures, Section, SimpleTable } from "@/components/finance/figures";
import { FilterBar } from "@/components/finance/kit-filter-bar";
import { ViewSwitcher } from "@/components/finance/kit-view-switcher";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "@/components/finance/panels";
import { PageHeader, TemplateCollection } from "@/components/finance/ui";
import { Chart } from "@/components/platform/client/chart";
import { ExportCsvButton, MatrixWithDrill } from "./client";

/** A figure opened to the records behind it completes the Reports funnel (A146). */
const DRILL = workflowMarker("atlas.reports:done");
import { DocumentActions } from "@/components/documents/document-actions";

/**
 * The built-in reports (Section 4.2 Reports, Section 4.5.5): gate readiness, the coordinate matrix,
 * budget versus actual, labor, purchase order exposure, incidents and the final cost report. Each
 * shows a table with real headers, a chart with its table beside it (Section 11.3: every chart has a
 * table view), exports what it shows as CSV, and links every figure to the records behind it
 * (Section 11.11 Reports). Blank amounts stay Unpriced and their totals stay blank with a count.
 */

type T = FinanceCopy["t"];

function ReportFrame({
  page,
  node,
  t,
  views,
  controls,
  exportData,
  children,
}: {
  page: FinancePage;
  node: string;
  t: T;
  views?: readonly string[];
  controls?: ReactNode;
  exportData?: { filename: string; header: string[]; rows: string[][] };
  children: ReactNode;
}) {
  const title = t(getNode(sitemap, node).node.label);
  const shown = (views ?? page.views).filter((v) => page.views.includes(v));
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={title}
          views={
            <ViewSwitcher
              views={shown}
              value={shown.includes(page.view) ? page.view : (shown[0] ?? "table")}
            />
          }
          actions={
            exportData && exportData.rows.length > 0 ? (
              <ExportCsvButton
                filename={exportData.filename}
                header={exportData.header}
                rows={exportData.rows}
                label={t("reports.exportCsv")}
              />
            ) : undefined
          }
        />
      }
      filters={
        <>
          {page.inProject ? null : (
            <FilterBar
              projects={page.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))}
              project={page.query.project}
              showSearch={false}
            />
          )}
          {controls}
        </>
      }
    >
      <div className="flex flex-col gap-16">{children}</div>
    </TemplateCollection>
  );
}

function refusal(page: FinancePage, node: string, t: T, capability: string) {
  return (
    <TemplateCollection header={<PageHeader title={t(getNode(sitemap, node).node.label)} />}>
      <RefusalPanel capability={capability} href={`/${page.ctx.org.slug}/home`} />
    </TemplateCollection>
  );
}

function failure(page: FinancePage, node: string, t: T) {
  return (
    <TemplateCollection header={<PageHeader title={t(getNode(sitemap, node).node.label)} />}>
      <ErrorPanel sentence={t("reports.loadError")} />
    </TemplateCollection>
  );
}

function ChipNav({
  label,
  items,
}: {
  label: string;
  items: { href: string; label: string; current: boolean }[];
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-8 text-text-13">
      <span className="text-text-secondary">{label}</span>
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href as Route}
          aria-current={i.current ? "true" : undefined}
          className="rounded-chip border border-border-subtle px-8 py-2 text-text-12 aria-[current=true]:bg-bg-hover aria-[current=true]:text-text-primary"
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

const major = (minor: number | null, exponent: number) =>
  minor === null ? null : minor / 10 ** exponent;

// Gate readiness ------------------------------------------------------------------------------------------

export async function GateReadinessReport({ page }: { page: FinancePage }) {
  const node = "reports.gate-readiness";
  const c = await getFinanceCopy(page.ctx);
  const { t } = c;
  if (!page.access.can("projects.project.read"))
    return refusal(page, node, t, "projects.project.read");
  const result = await gateReadiness(page.ctx.viewer.db, {
    orgId: page.ctx.org.id,
    projectId: page.project?.id ?? null,
  });
  if (!result.ok) return failure(page, node, t);
  const rows = result.data;
  const org = page.ctx.org.slug;
  // Canon codes appear next to their plain name, never alone (Section 11.10 item 2, A59-017).
  const criteria = await listGateCriteria(page.ctx.viewer.db);
  const statement = new Map(criteria.ok ? criteria.data.map((c) => [c.id, c.statement]) : []);
  const criterionName = (code: string) => {
    const sentence = statement.get(code);
    return sentence ? `${sentence.replace(/\.$/, "")} (${code})` : code;
  };
  const phaseName = (code: string) => (code ? t(`projects.phases.${code}`) : "");
  const header = [
    t("finance.common.project"),
    t("reports.gates.phase"),
    t("reports.gates.nextGate"),
    t("reports.gates.blocking"),
    t("reports.gates.other"),
    t("reports.gates.ready"),
  ];
  const csv = rows.map((r) => [
    r.project.key,
    phaseName(r.project.phase),
    r.nextGate === null ? t("reports.gates.allPassed") : t("reports.gates.gate", { n: r.nextGate }),
    `${r.blockingMet}/${r.blockingTotal}`,
    `${r.otherMet}/${r.otherTotal}`,
    r.ready ? t("reports.gates.yes") : t("reports.gates.no"),
  ]);
  let body: ReactNode;
  if (rows.length === 0) {
    body = (
      <EmptyPanel
        icon="Gauge"
        sentence={t("reports.gates.empty")}
        actionLabel={t("reports.gates.emptyAction")}
        href={`/${org}/projects`}
      />
    );
  } else if (page.view === "chart") {
    body = (
      <div className="flex flex-col gap-12">
        <Chart
          type="bar"
          title={t("reports.gates.chartTitle")}
          categoryLabel={t("finance.common.project")}
          categories={rows.map((r) => r.project.key)}
          series={[
            { name: t("reports.gates.blockingMet"), values: rows.map((r) => r.blockingMet) },
            {
              name: t("reports.gates.blockingOpen"),
              values: rows.map((r) => r.blockingTotal - r.blockingMet),
            },
          ]}
        />
        <SimpleTable caption={t("reports.gates.chartTitle")} head={header} rows={csv} />
      </div>
    );
  } else if (page.view === "matrix") {
    body = (
      <SimpleTable
        caption={t("reports.gates.matrixCaption")}
        head={[
          t("finance.common.project"),
          ...Array.from({ length: 9 }, (_, i) => t("reports.gates.gate", { n: i + 1 })),
        ]}
        rows={rows.map((r) => [
          <Link
            key="p"
            className="text-accent-text underline"
            href={`/${org}/p/${r.project.key}/gates` as Route}
            {...DRILL}
          >
            {r.project.key}
          </Link>,
          ...Array.from({ length: 9 }, (_, i) => {
            const gate = i + 1;
            if (r.nextGate === null || gate < r.nextGate) return t("reports.gates.passed");
            if (gate === r.nextGate) return `${r.blockingMet}/${r.blockingTotal}`;
            return "";
          }),
        ])}
      />
    );
  } else {
    body = (
      <SimpleTable
        caption={t("reports.gates.tableCaption")}
        head={[...header, t("reports.gates.unmet")]}
        rows={rows.map((r, i) => [
          <Link
            key="p"
            className="text-accent-text underline"
            href={`/${org}/p/${r.project.key}/gates` as Route}
            {...DRILL}
          >
            {r.project.key} · {r.project.name}
          </Link>,
          ...(csv[i] ?? []).slice(1),
          r.unmetBlocking.map(criterionName).join("; "),
        ])}
      />
    );
  }
  return (
    <ReportFrame
      page={page}
      node={node}
      t={t}
      exportData={{ filename: "gate-readiness.csv", header, rows: csv }}
    >
      <Figures
        label={t("reports.summary")}
        items={[
          { label: t("reports.gates.projects"), value: c.number(rows.length) },
          {
            label: t("reports.gates.readyCount"),
            value: c.number(rows.filter((r) => r.ready).length),
            tone: "success",
          },
          {
            label: t("reports.gates.blockedCount"),
            value: c.number(rows.filter((r) => !r.ready && r.nextGate !== null).length),
            tone: "warning",
          },
        ]}
      />
      {body}
    </ReportFrame>
  );
}

// Coordinate matrix -----------------------------------------------------------------------------------------

export async function CoordinateMatrixReport({ page }: { page: FinancePage }) {
  const node = "reports.coordinate-matrix";
  const c = await getFinanceCopy(page.ctx);
  const { t } = c;
  const source = (MATRIX_SOURCES as readonly string[]).includes(page.query.extra["source"] ?? "")
    ? (page.query.extra["source"] as MatrixSource)
    : "scope";
  const capability =
    source === "records" ? "work.record.read" : source === "scope" ? "finance.budget.read" : null;
  if (capability && !page.access.can(capability)) return refusal(page, node, t, capability);
  const result = await coordinateMatrix(page.ctx.viewer.db, {
    orgId: page.ctx.org.id,
    projectId: page.project?.id ?? null,
    source,
  });
  if (!result.ok) return failure(page, node, t);
  const { departments, phases, cells, total } = result.data;
  const org = page.ctx.org.slug;
  const recordsHref = (dept: string, phase: string) =>
    source === "records"
      ? `/${org}/work/all-records?${new URLSearchParams({ ...(page.project ? { project: page.project.key } : {}), dept, phase }).toString()}`
      : source === "scope"
        ? `/${org}/finance/budgets?${new URLSearchParams({ view: "table", ...(page.project ? { project: page.project.key } : {}) }).toString()}`
        : `/${org}/canon/elements?${new URLSearchParams({ dept, phase }).toString()}`;
  const sources = (
    <ChipNav
      label={t("reports.matrix.source")}
      items={MATRIX_SOURCES.map((s) => ({
        href: withQuery(page, { source: s === "scope" ? null : s }),
        label: t(`reports.matrix.sources.${s}`),
        current: s === source,
      }))}
    />
  );
  const hrefFor: Record<string, string> = {};
  for (const d of departments)
    for (const p of phases) hrefFor[`${d.code}|${p.code}`] = recordsHref(d.code, p.code);
  const header = [
    t("reports.matrix.department"),
    ...phases.map((p) => t("reports.matrix.phase", { gate: p.gate, name: p.name })),
  ];
  const csv = departments.map((d) => [
    `${d.code} · ${d.name}`,
    ...phases.map((p) => String(cells[`${d.code}|${p.code}`] ?? 0)),
  ]);
  return (
    <ReportFrame
      page={page}
      node={node}
      t={t}
      controls={sources}
      exportData={{ filename: `coordinate-matrix-${source}.csv`, header, rows: csv }}
    >
      <p className="m-0 max-w-layout-reading text-text-13 text-text-secondary">
        {t(`reports.matrix.sentences.${source}`, { count: total })}
      </p>
      {total === 0 ? (
        <EmptyPanel
          icon="Grid3x3"
          sentence={t(`reports.matrix.empties.${source}`)}
          actionLabel={t(`reports.matrix.emptyActions.${source}`)}
          href={
            source === "records" ? `/${org}/work/all-records?create=1` : `/${org}/finance/budgets`
          }
        />
      ) : page.view === "table" ? (
        <SimpleTable
          caption={t("reports.matrix.caption")}
          head={header}
          numeric={phases.map((_, i) => i + 1)}
          rows={departments.map((d) => [
            `${d.name} · ${d.code}`,
            ...phases.map((p) => {
              const n = cells[`${d.code}|${p.code}`] ?? 0;
              return n === 0 ? (
                "0"
              ) : (
                <Link
                  key={p.code}
                  className="text-accent-text underline"
                  href={recordsHref(d.code, p.code) as Route}
                  {...DRILL}
                >
                  {c.number(n)}
                </Link>
              );
            }),
          ])}
        />
      ) : (
        <MatrixWithDrill
          label={t("reports.matrix.caption")}
          corner={t("reports.matrix.corner")}
          rows={departments.map((d) => ({ code: d.code as DepartmentCode, name: d.name }))}
          cols={phases.map((p) => ({ gate: p.gate, code: p.code as PhaseCode, name: p.name }))}
          cells={cells}
          hrefFor={hrefFor}
        />
      )}
    </ReportFrame>
  );
}

// Budget versus actual --------------------------------------------------------------------------------------

export async function BudgetVersusActualReport({ page }: { page: FinancePage }) {
  const node = "reports.budget-versus-actual";
  const c = await getFinanceCopy(page.ctx);
  const { t } = c;
  if (!page.access.can("finance.budget.read")) return refusal(page, node, t, "finance.budget.read");
  const dimension = (BUDGET_DIMENSIONS as readonly string[]).includes(page.query.extra["by"] ?? "")
    ? (page.query.extra["by"] as BudgetDimension)
    : "account";
  const [result, accounts] = await Promise.all([
    budgetVersusActual(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      projectId: page.project?.id ?? null,
      dimension,
    }),
    listGlAccounts(page.ctx.viewer.db),
  ]);
  if (!result.ok || !accounts.ok) return failure(page, node, t);
  const accountName = new Map(accounts.data.map((a) => [a.code, a.name]));
  const keyLabel = (key: string) =>
    key === ""
      ? t(`reports.bva.unassigned.${dimension}`)
      : dimension === "account"
        ? `${accountName.get(key) ?? key} · ${key}`
        : key;
  const { rows, totals } = result.data;
  const org = page.ctx.org.slug;
  const header = [
    t(`reports.bva.dimensions.${dimension}`),
    t("finance.common.currency"),
    t("reports.bva.budget"),
    t("reports.bva.changes"),
    t("reports.bva.revised"),
    t("reports.bva.actual"),
    t("reports.bva.variance"),
  ];
  const line = (r: (typeof rows)[number], label: string) => [
    label,
    r.currency,
    r.unpricedCount > 0
      ? t("reports.unpricedCount", { count: r.unpricedCount })
      : c.money(r.budgetMinor, r.currency),
    c.money(r.approvedChangeMinor, r.currency),
    c.money(r.revisedMinor, r.currency),
    c.money(r.actualMinor, r.currency),
    c.money(r.varianceMinor, r.currency),
  ];
  const csv = rows.map((r) => line(r, keyLabel(r.key)));
  const drill = (key: string) =>
    withQuery(
      { path: `/${org}/finance/budgets`, query: { ...page.query, extra: {} } },
      {
        view: "table",
        ...(page.project
          ? { project: page.project.key }
          : dimension === "project" && key
            ? { project: key }
            : {}),
      },
    );
  const dims = (
    <ChipNav
      label={t("reports.bva.groupBy")}
      items={BUDGET_DIMENSIONS.filter((d) => !(page.project && d === "project")).map((d) => ({
        href: withQuery(page, { by: d === "account" ? null : d }),
        label: t(`reports.bva.dimensions.${d}`),
        current: d === dimension,
      }))}
    />
  );
  let body: ReactNode;
  if (rows.length === 0) {
    body = (
      <EmptyPanel
        icon="Wallet"
        sentence={t("reports.bva.empty")}
        actionLabel={t("reports.bva.emptyAction")}
        href={`/${org}/finance/budgets?create=1`}
      />
    );
  } else if (page.view === "chart") {
    const cur = rows[0]?.currency ?? "USD";
    const exp = c.exponents.get(cur) ?? 2;
    const same = rows.filter((r) => r.currency === cur);
    body = (
      <div className="flex flex-col gap-12">
        <Chart
          type="bar"
          title={t("reports.bva.chartTitle", { currency: cur })}
          subtitle={t("reports.bva.chartSubtitle")}
          categoryLabel={t(`reports.bva.dimensions.${dimension}`)}
          categories={same.map((r) => keyLabel(r.key))}
          series={[
            { name: t("reports.bva.revised"), values: same.map((r) => major(r.revisedMinor, exp)) },
            { name: t("reports.bva.actual"), values: same.map((r) => major(r.actualMinor, exp)) },
          ]}
          format="money"
          currency={cur}
        />
        <SimpleTable
          caption={t("reports.bva.chartTitle", { currency: cur })}
          head={header}
          numeric={[2, 3, 4, 5, 6]}
          rows={same.map((r) => line(r, keyLabel(r.key)))}
        />
      </div>
    );
  } else if (page.view === "matrix") {
    const result2 = await budgetVersusActual(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      projectId: page.project?.id ?? null,
      dimension: dimension === "costCenter" ? "account" : "costCenter",
    });
    const other = result2.ok ? result2.data.rows : [];
    body = (
      <div className="flex flex-col gap-12">
        <p className="m-0 text-text-12 text-text-secondary">{t("reports.bva.matrixSentence")}</p>
        <SimpleTable
          caption={t("reports.bva.tableCaption")}
          head={header}
          numeric={[2, 3, 4, 5, 6]}
          rows={rows.map((r) => line(r, keyLabel(r.key)))}
        />
        <SimpleTable
          caption={t("reports.bva.otherCaption", {
            dimension: t(
              `reports.bva.dimensions.${dimension === "costCenter" ? "account" : "costCenter"}`,
            ),
          })}
          head={[
            t(`reports.bva.dimensions.${dimension === "costCenter" ? "account" : "costCenter"}`),
            ...header.slice(1),
          ]}
          numeric={[2, 3, 4, 5, 6]}
          rows={other.map((r) => line(r, r.key || t("reports.bva.unassigned.costCenter")))}
        />
      </div>
    );
  } else {
    body = (
      <SimpleTable
        caption={t("reports.bva.tableCaption")}
        head={header}
        numeric={[2, 3, 4, 5, 6]}
        rows={rows.map((r) => [
          <Link
            key="k"
            className="text-accent-text underline"
            href={drill(r.key) as Route}
            {...DRILL}
          >
            {keyLabel(r.key)}
          </Link>,
          ...line(r, "").slice(1),
        ])}
        foot={
          totals.length === 1 && totals[0] ? line(totals[0], t("finance.common.total")) : undefined
        }
      />
    );
  }
  return (
    <ReportFrame
      page={page}
      node={node}
      t={t}
      controls={dims}
      exportData={{ filename: `budget-versus-actual-${dimension}.csv`, header, rows: csv }}
    >
      <Figures
        label={t("reports.summary")}
        items={totals.flatMap((tot) => [
          {
            label: t("reports.bva.revisedIn", { currency: tot.currency }),
            value: c.money(tot.revisedMinor, tot.currency),
            caption:
              tot.unpricedCount > 0
                ? t("reports.unpricedCount", { count: tot.unpricedCount })
                : undefined,
            tone: tot.unpricedCount > 0 ? ("warning" as const) : undefined,
          },
          {
            label: t("reports.bva.actualIn", { currency: tot.currency }),
            value: c.money(tot.actualMinor, tot.currency),
          },
          {
            label: t("reports.bva.varianceIn", { currency: tot.currency }),
            value: c.money(tot.varianceMinor, tot.currency),
            tone:
              tot.varianceMinor !== null && tot.varianceMinor < 0 ? ("danger" as const) : undefined,
          },
        ])}
      />
      {body}
    </ReportFrame>
  );
}

// Labor -------------------------------------------------------------------------------------------------------

export async function LaborReport({ page }: { page: FinancePage }) {
  const node = "reports.labor";
  const c = await getFinanceCopy(page.ctx);
  const { t } = c;
  if (!page.access.can("finance.budget.read") && !page.access.can("crew.timesheet.read"))
    return refusal(page, node, t, "crew.timesheet.read");
  const result = await laborReport(page.ctx.viewer.db, {
    orgId: page.ctx.org.id,
    projectId: page.project?.id ?? null,
  });
  if (!result.ok) return failure(page, node, t);
  const { projects, payrollRuns } = result.data;
  const org = page.ctx.org.slug;
  const hours = (m: number) => c.number(Math.round((m / 60) * 10) / 10);
  const header = [
    t("finance.common.project"),
    t("reports.labor.budget"),
    t("reports.labor.hours"),
    t("reports.labor.timesheets"),
    t("reports.labor.open"),
  ];
  const csv = projects.map((p) => [
    p.project.key,
    p.unpricedCount > 0
      ? t("reports.unpricedCount", { count: p.unpricedCount })
      : p.currency
        ? c.money(p.budgetMinor, p.currency)
        : t("reports.labor.noBudget"),
    hours(p.workedMinutes),
    String(p.timesheetCount),
    String(p.openEntryCount),
  ]);
  return (
    <ReportFrame
      page={page}
      node={node}
      t={t}
      exportData={{ filename: "labor.csv", header, rows: csv }}
    >
      {projects.length === 0 ? (
        <EmptyPanel
          icon="Users"
          sentence={t("reports.labor.empty")}
          actionLabel={t("reports.labor.emptyAction")}
          href={`/${org}/crew/timesheets`}
        />
      ) : page.view === "chart" ? (
        <div className="flex flex-col gap-12">
          <Chart
            type="bar"
            title={t("reports.labor.chartTitle")}
            categoryLabel={t("finance.common.project")}
            categories={projects.map((p) => p.project.key)}
            series={[
              {
                name: t("reports.labor.hours"),
                values: projects.map((p) => Math.round(p.workedMinutes / 6) / 10),
              },
            ]}
          />
          <SimpleTable
            caption={t("reports.labor.chartTitle")}
            head={header}
            numeric={[1, 2, 3, 4]}
            rows={csv}
          />
        </div>
      ) : (
        <SimpleTable
          caption={t("reports.labor.caption")}
          head={header}
          numeric={[1, 2, 3, 4]}
          rows={projects.map((p, i) => [
            <Link
              key="p"
              className="text-accent-text underline"
              href={`/${org}/p/${p.project.key}/crew` as Route}
              {...DRILL}
            >
              {p.project.key} · {p.project.name}
            </Link>,
            ...(csv[i] ?? []).slice(1),
          ])}
        />
      )}
      {payrollRuns.length > 0 ? (
        <Section id="payroll-runs" title={t("reports.labor.payrollRuns")}>
          <SimpleTable
            caption={t("reports.labor.payrollRuns")}
            head={[
              t("reports.labor.run"),
              t("reports.labor.lines"),
              t("reports.labor.hours"),
              t("finance.common.amount"),
            ]}
            numeric={[1, 2, 3]}
            rows={payrollRuns.map((r) => [
              <Link
                key="r"
                className="text-accent-text underline"
                href={`/${org}/crew/payroll-exports?peek=${r.payrollRunId}` as Route}
                {...DRILL}
              >
                {r.payrollRunId.slice(0, 8)}
              </Link>,
              String(r.lineCount),
              c.number(r.hours),
              r.isMasked || r.currency === null
                ? t("reports.labor.masked")
                : c.money(r.amountMinor, r.currency),
            ])}
          />
          {payrollRuns.some((r) => r.isMasked) ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("reports.labor.maskedSentence")}
            </p>
          ) : null}
        </Section>
      ) : null}
    </ReportFrame>
  );
}

// Purchase order exposure -------------------------------------------------------------------------------------

export async function PurchaseOrderExposureReport({ page }: { page: FinancePage }) {
  const node = "reports.purchase-order-exposure";
  const c = await getFinanceCopy(page.ctx);
  const { t } = c;
  if (!page.access.can("procurement.po.read")) return refusal(page, node, t, "procurement.po.read");
  const result = await purchaseOrderExposure(page.ctx.viewer.db, {
    orgId: page.ctx.org.id,
    projectId: page.project?.id ?? null,
  });
  if (!result.ok) return failure(page, node, t);
  const rows = result.data.filter((r) => r.state !== "Canceled");
  const org = page.ctx.org.slug;
  const header = [
    t("reports.po.number"),
    t("finance.common.project"),
    t("reports.po.vendor"),
    t("finance.common.state"),
    t("reports.po.committed"),
    t("reports.po.received"),
    t("reports.po.exposure"),
  ];
  const csv = rows.map((r) => [
    String(r.poNumber),
    r.projectKey ?? "",
    r.vendorName ?? "",
    r.state,
    r.unpricedCount > 0
      ? t("reports.unpricedCount", { count: r.unpricedCount })
      : c.money(r.committedMinor, r.currency),
    c.money(r.receivedMinor, r.currency),
    c.money(r.exposureMinor, r.currency),
  ]);
  const byCurrency = new Map<string, (number | null)[]>();
  for (const r of rows)
    byCurrency.set(r.currency, [...(byCurrency.get(r.currency) ?? []), r.exposureMinor]);
  return (
    <ReportFrame
      page={page}
      node={node}
      t={t}
      exportData={{ filename: "purchase-order-exposure.csv", header, rows: csv }}
    >
      <Figures
        label={t("reports.summary")}
        items={[...byCurrency.entries()].map(([cur, values]) => {
          const unpriced = values.filter((v) => v === null).length;
          return {
            label: t("reports.po.exposureIn", { currency: cur }),
            value: c.money(
              unpriced > 0 ? null : values.reduce<number>((s, v) => s + (v ?? 0), 0),
              cur,
            ),
            caption: unpriced > 0 ? t("reports.unpricedCount", { count: unpriced }) : undefined,
          };
        })}
      />
      {rows.length === 0 ? (
        <EmptyPanel
          icon="ShoppingCart"
          sentence={t("reports.po.empty")}
          actionLabel={t("reports.po.emptyAction")}
          href={`/${org}/procurement/purchase-orders`}
        />
      ) : page.view === "chart" ? (
        <div className="flex flex-col gap-12">
          <Chart
            type="bar"
            title={t("reports.po.chartTitle")}
            categoryLabel={t("reports.po.number")}
            categories={rows.map((r) => String(r.poNumber))}
            series={[
              {
                name: t("reports.po.exposure"),
                values: rows.map((r) => major(r.exposureMinor, c.exponents.get(r.currency) ?? 2)),
              },
            ]}
            format="money"
            currency={rows[0]?.currency ?? "USD"}
          />
          <SimpleTable
            caption={t("reports.po.chartTitle")}
            head={header}
            numeric={[4, 5, 6]}
            rows={csv}
          />
        </div>
      ) : (
        <SimpleTable
          caption={t("reports.po.caption")}
          head={header}
          numeric={[4, 5, 6]}
          rows={rows.map((r, i) => [
            <Link
              key="n"
              className="text-accent-text underline"
              href={`/${org}/procurement/purchase-orders?peek=${r.purchaseOrderId}` as Route}
            >
              {String(r.poNumber)}
            </Link>,
            ...(csv[i] ?? []).slice(1),
          ])}
        />
      )}
    </ReportFrame>
  );
}

// Incidents ---------------------------------------------------------------------------------------------------

export async function IncidentsReport({ page }: { page: FinancePage }) {
  const node = "reports.incidents";
  const c = await getFinanceCopy(page.ctx);
  const { t } = c;
  if (!page.access.can("safety.incident.read"))
    return refusal(page, node, t, "safety.incident.read");
  const result = await incidentsReport(page.ctx.viewer.db, {
    orgId: page.ctx.org.id,
    projectId: page.project?.id ?? null,
  });
  if (!result.ok) return failure(page, node, t);
  const { rows, total, open } = result.data;
  const org = page.ctx.org.slug;
  const header = [
    t("reports.incidents.severity"),
    t("finance.common.state"),
    t("reports.incidents.count"),
  ];
  const csv = rows.map((r) => [
    r.severityLabel ?? t("reports.incidents.unrated"),
    t(`reports.incidents.states.${r.state}`),
    String(r.count),
  ]);
  const severities = [
    ...new Set(rows.map((r) => r.severityLabel ?? t("reports.incidents.unrated"))),
  ];
  return (
    <ReportFrame
      page={page}
      node={node}
      t={t}
      views={["table", "chart"]}
      exportData={{ filename: "incidents.csv", header, rows: csv }}
    >
      <Figures
        label={t("reports.summary")}
        items={[
          { label: t("reports.incidents.total"), value: c.number(total) },
          {
            label: t("reports.incidents.open"),
            value: c.number(open),
            tone: open > 0 ? "warning" : undefined,
          },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyPanel
          icon="ShieldAlert"
          sentence={t("reports.incidents.empty")}
          actionLabel={t("reports.incidents.emptyAction")}
          href={`/${org}/safety/incidents`}
        />
      ) : page.view === "chart" ? (
        <div className="flex flex-col gap-12">
          <Chart
            type="bar"
            title={t("reports.incidents.chartTitle")}
            categoryLabel={t("reports.incidents.severity")}
            categories={severities}
            series={[
              {
                name: t("reports.incidents.count"),
                values: severities.map((s) =>
                  rows
                    .filter((r) => (r.severityLabel ?? t("reports.incidents.unrated")) === s)
                    .reduce((n, r) => n + r.count, 0),
                ),
              },
            ]}
          />
          <SimpleTable
            caption={t("reports.incidents.chartTitle")}
            head={header}
            numeric={[2]}
            rows={csv}
          />
        </div>
      ) : (
        <SimpleTable
          caption={t("reports.incidents.caption")}
          head={header}
          numeric={[2]}
          rows={rows.map((r, i) => [
            ...(csv[i] ?? []).slice(0, 2),
            <Link
              key="c"
              className="text-accent-text underline"
              href={
                `/${org}/safety/incidents?${r.state === "Closed" ? "" : "state=" + r.state}` as Route
              }
            >
              {c.number(r.count)}
            </Link>,
          ])}
        />
      )}
    </ReportFrame>
  );
}

// Final cost report ----------------------------------------------------------------------------------------------

export async function FinalCostReport({ page }: { page: FinancePage }) {
  const node = "reports.final-cost-report";
  const c = await getFinanceCopy(page.ctx);
  const { t } = c;
  if (!page.access.can("finance.budget.read")) return refusal(page, node, t, "finance.budget.read");
  const org = page.ctx.org.slug;
  if (!page.project) {
    return (
      <ReportFrame page={page} node={node} t={t}>
        <p className="m-0 text-text-13 text-text-secondary">{t("reports.final.chooseProject")}</p>
        {page.projects.length === 0 ? (
          <EmptyPanel
            icon="FileCheck"
            sentence={t("reports.final.noProjects")}
            actionLabel={t("reports.final.noProjectsAction")}
            href={`/${org}/projects`}
          />
        ) : (
          <ul className="m-0 flex max-w-layout-form list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
            {page.projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={withQuery(page, { project: p.key }) as Route}
                  className="flex min-h-row-comfortable items-center px-16 text-text-14 text-text-primary hover:bg-bg-hover"
                >
                  {p.key} · {p.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ReportFrame>
    );
  }
  const [result, accounts] = await Promise.all([
    finalCostReport(page.ctx.viewer.db, { orgId: page.ctx.org.id, projectId: page.project.id }),
    listGlAccounts(page.ctx.viewer.db),
  ]);
  if (!result.ok || !accounts.ok) return failure(page, node, t);
  const report = result.data;
  const accountName = new Map(accounts.data.map((a) => [a.code, a.name]));
  const header = [
    t("reports.final.account"),
    t("finance.common.currency"),
    t("reports.final.baseline"),
    t("reports.final.changes"),
    t("reports.final.revised"),
    t("reports.final.actual"),
    t("reports.final.variance"),
  ];
  const line = (r: (typeof report.rows)[number], label: string) => [
    label,
    r.currency,
    r.baselineUnpricedCount > 0
      ? t("reports.unpricedCount", { count: r.baselineUnpricedCount })
      : c.money(r.baselineMinor, r.currency),
    c.money(r.approvedChangeMinor, r.currency),
    c.money(r.revisedMinor, r.currency),
    c.money(r.actualMinor, r.currency),
    c.money(r.varianceMinor, r.currency),
  ];
  const label = (code: string) =>
    code ? `${accountName.get(code) ?? code} · ${code}` : t("finance.budgets.unmappedAccount");
  const csv = report.rows.map((r) => line(r, label(r.accountCode)));
  return (
    <ReportFrame
      page={page}
      node={node}
      t={t}
      exportData={{ filename: `final-cost-report-${report.project.key}.csv`, header, rows: csv }}
    >
      <h2 className="m-0 text-heading-16 font-semibold">
        {t("reports.final.heading", { project: `${report.project.key} · ${report.project.name}` })}
      </h2>
      <DocumentActions org={org} kind="final-cost-report" id={report.project.id} />
      {!report.hasBaseline ? (
        <EmptyPanel
          icon="FileCheck"
          sentence={t("reports.final.noBaseline", { project: report.project.key })}
          actionLabel={t("reports.final.noBaselineAction")}
          href={`/${org}/p/${report.project.key}/budget`}
        />
      ) : (
        <>
          <Figures
            label={t("reports.summary")}
            items={report.totals.flatMap((tot) => [
              {
                label: t("reports.final.baselineIn", { currency: tot.currency }),
                value: c.money(tot.baselineMinor, tot.currency),
                caption:
                  tot.baselineUnpricedCount > 0
                    ? t("reports.unpricedCount", { count: tot.baselineUnpricedCount })
                    : undefined,
                tone: tot.baselineUnpricedCount > 0 ? ("warning" as const) : undefined,
              },
              {
                label: t("reports.final.revisedIn", { currency: tot.currency }),
                value: c.money(tot.revisedMinor, tot.currency),
              },
              {
                label: t("reports.final.actualIn", { currency: tot.currency }),
                value: c.money(tot.actualMinor, tot.currency),
              },
              {
                label: t("reports.final.varianceIn", { currency: tot.currency }),
                value: c.money(tot.varianceMinor, tot.currency),
                tone:
                  tot.varianceMinor !== null && tot.varianceMinor < 0
                    ? ("danger" as const)
                    : undefined,
              },
            ])}
          />
          {page.view === "chart" ? (
            <div className="flex flex-col gap-12">
              <Chart
                type="bar"
                title={t("reports.final.chartTitle")}
                categoryLabel={t("reports.final.account")}
                categories={report.rows.map(
                  (r) => r.accountCode || t("finance.budgets.unmappedAccount"),
                )}
                series={[
                  {
                    name: t("reports.final.revised"),
                    values: report.rows.map((r) =>
                      major(r.revisedMinor, c.exponents.get(r.currency) ?? 2),
                    ),
                  },
                  {
                    name: t("reports.final.actual"),
                    values: report.rows.map((r) =>
                      major(r.actualMinor, c.exponents.get(r.currency) ?? 2),
                    ),
                  },
                ]}
                format="money"
                currency={report.rows[0]?.currency ?? "USD"}
              />
              <SimpleTable
                caption={t("reports.final.chartTitle")}
                head={header}
                numeric={[2, 3, 4, 5, 6]}
                rows={csv}
              />
            </div>
          ) : (
            <SimpleTable
              caption={t("reports.final.caption")}
              head={header}
              numeric={[2, 3, 4, 5, 6]}
              rows={report.rows.map((r) => [
                <Link
                  key="a"
                  className="text-accent-text underline"
                  href={
                    `/${org}/finance/budgets?project=${report.project.key}&view=matrix` as Route
                  }
                >
                  {label(r.accountCode)}
                </Link>,
                ...line(r, "").slice(1),
              ])}
              foot={
                report.totals.length === 1 && report.totals[0]
                  ? line(report.totals[0], t("finance.common.total"))
                  : undefined
              }
            />
          )}
          <p className="m-0 text-text-12 text-text-secondary">{t("reports.final.sentence")}</p>
        </>
      )}
    </ReportFrame>
  );
}
