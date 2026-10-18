import {
  convertMinor,
  findFxRate,
  getBudget,
  listBudgets,
  listCostCenters,
  listFxRates,
  listGlAccounts,
  listGrades,
  listUridOptions,
  nullAwareSum,
  type BudgetSummary,
} from "@xos/data/finance";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter, getLocale } from "next-intl/server";
import { PageHeader, TemplateCollection, TemplateGridEditor } from "./ui";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { exponentOf, getExponents, moneyFormatter } from "@/lib/finance/money";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { deleteBudgetAction } from "@/app/[org]/finance/actions";
import { Figures, Section, SimpleTable } from "./figures";
import { CreateButton } from "./kit-create-button";
import { FilterBar } from "./kit-filter-bar";
import { ViewSwitcher } from "./kit-view-switcher";
import { type Row } from "./kit.types";
// The grid, table view, peek and sheets render only in some states (A24-009).
import {
  BudgetEditor,
  BudgetForm,
  CollectionTable,
  EditButton,
  FormSheet,
  InlineActionButton,
  RecordPeek,
} from "./lazy";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "./panels";
import { RecordCollab } from "./record";

/**
 * Finance > Budgets and the project Budget tab (Section 4.5.5, 4.5.4): the budgets as a table, one
 * budget's lines in the spreadsheet grid (the default view, Section 11.15), and the budget as a matrix
 * of GL account by cost center. Totals are NULL-aware with the unpriced count beside them and are
 * revised by approved change orders; any figure can be shown in another currency at a recorded rate
 * with the rate date, and an unpriced figure stays Unpriced (journey 37).
 */
export async function BudgetsView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const [t, format, locale] = await Promise.all([getTranslate(), getFormatter(), getLocale()]);
  const title = t(
    getNode(sitemap, page.inProject ? "project.budget" : "finance.budgets").node.label,
  );
  const homeHref = `/${ctx.org.slug}/home`;
  if (!access.can("finance.budget.read")) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <RefusalPanel capability="finance.budget.read" href={homeHref} />
      </TemplateCollection>
    );
  }
  const db = ctx.viewer.db;
  const [budgets, exponents] = await Promise.all([
    listBudgets(db, { orgId: ctx.org.id, projectId: page.project?.id ?? null }),
    getExponents(ctx),
  ]);
  if (!budgets.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("finance.budgets.loadError")} />
      </TemplateCollection>
    );
  }
  const money = moneyFormatter(locale, exponents, t("finance.common.unpriced"));
  const canWrite = access.can("finance.budget.write");
  const term = query.q?.toLowerCase() ?? null;
  const shown = budgets.data.filter(
    (b) =>
      term === null ||
      b.name.toLowerCase().includes(term) ||
      (b.projectKey ?? "").toLowerCase().includes(term),
  );
  const selected =
    shown.find((b) => b.id === (query.extra["budget"] ?? (query.full ? query.peek : null))) ??
    (page.project
      ? (shown.find((b) => !b.isBaseline) ?? shown[0])
      : shown.length === 1
        ? shown[0]
        : undefined);
  const peek = query.peek ? budgets.data.find((b) => b.id === query.peek) : undefined;
  const projectOptions = page.projects.map((p) => ({
    value: p.key,
    label: `${p.key} · ${p.name}`,
  }));
  const currencies = [...exponents.keys()].sort();
  const header = (
    <PageHeader
      title={title}
      count={shown.length}
      views={<ViewSwitcher views={page.views} value={page.view} />}
      actions={canWrite ? <CreateButton label={t("finance.budgets.create")} /> : undefined}
    />
  );
  const filters = (
    <FilterBar
      projects={page.inProject ? undefined : projectOptions}
      project={query.project}
      q={query.q}
    />
  );

  const totalsFigures = (b: BudgetSummary, target: string | null, rate: number | null) => {
    const cur = target ?? b.currency;
    const conv = (v: number | null) =>
      rate === null || target === null
        ? v
        : convertMinor(v, rate, exponentOf(exponents, b.currency), exponentOf(exponents, target));
    const variance = b.revisedTotalMinor === null ? null : b.revisedTotalMinor - b.actualMinor;
    return [
      {
        label: t("finance.budgets.figures.total"),
        value: money(conv(b.totalMinor), cur),
        caption:
          b.unpricedCount > 0
            ? t("finance.budgets.figures.unpricedCaption", {
                count: b.unpricedCount,
                priced: money(conv(b.pricedTotalMinor), cur),
              })
            : t("finance.budgets.figures.lines", { count: b.lineCount }),
        tone: b.unpricedCount > 0 ? ("warning" as const) : undefined,
      },
      {
        label: t("finance.budgets.figures.changes"),
        value: money(conv(b.approvedChangeMinor), cur),
        caption: t("finance.budgets.figures.changeCount", { count: b.approvedChangeCount }),
      },
      { label: t("finance.budgets.figures.revised"), value: money(conv(b.revisedTotalMinor), cur) },
      {
        label: t("finance.budgets.figures.actual"),
        value: money(conv(b.actualMinor), cur),
        caption:
          variance === null
            ? t("finance.budgets.figures.varianceUnknown")
            : t("finance.budgets.figures.variance", { amount: money(conv(variance), cur) }),
        tone: variance !== null && variance < 0 ? ("danger" as const) : undefined,
      },
    ];
  };

  let body;
  if (shown.length === 0) {
    body = (
      <EmptyPanel
        icon="Wallet"
        sentence={
          page.project
            ? t("finance.budgets.emptyProject", { project: page.project.key })
            : t("finance.budgets.empty")
        }
        actionLabel={t("finance.budgets.create")}
        href={withQuery(page, { create: "1" })}
      />
    );
  } else if (page.view === "table") {
    const rows: Row[] = shown.map((b) => ({
      id: b.id,
      project: b.projectKey ?? "",
      name: b.name,
      baseline: b.isBaseline ? t("finance.budgets.baseline") : "",
      lines: b.lineCount,
      unpriced: b.unpricedCount,
      total: money(b.totalMinor, b.currency),
      revised: money(b.revisedTotalMinor, b.currency),
      actual: money(b.actualMinor, b.currency),
    }));
    body = (
      <CollectionTable
        label={title}
        rows={rows}
        columns={[
          { key: "project", label: t("finance.common.project"), type: "code" },
          { key: "name", label: t("finance.budgets.fields.name"), wrap: true },
          { key: "baseline", label: t("finance.budgets.fields.isBaseline") },
          { key: "lines", label: t("finance.budgets.columns.lines"), type: "number" },
          { key: "unpriced", label: t("finance.budgets.columns.unpriced"), type: "number" },
          { key: "total", label: t("finance.budgets.figures.total"), type: "number" },
          { key: "revised", label: t("finance.budgets.figures.revised"), type: "number" },
          { key: "actual", label: t("finance.budgets.figures.actual"), type: "number" },
        ]}
      />
    );
  } else if (!selected) {
    body = (
      <Section id="choose-budget" title={t("finance.budgets.choose")}>
        <ul className="m-0 flex max-w-layout-form list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {shown.map((b) => (
            <li key={b.id}>
              <Link
                href={withQuery(page, { budget: b.id }) as Route}
                className="flex min-h-row-comfortable items-center justify-between gap-12 px-16 text-text-14 text-text-primary hover:bg-bg-hover"
              >
                <span>
                  <span className="font-mono text-text-12 text-text-secondary">{b.projectKey}</span>{" "}
                  {b.name}
                </span>
                <span className="tabular-nums text-text-secondary">
                  {money(b.totalMinor, b.currency)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    );
  } else {
    const [detail, urids, accounts, centers, grades, rates] = await Promise.all([
      getBudget(db, ctx.org.id, selected.id),
      listUridOptions(db),
      listGlAccounts(db),
      listCostCenters(db, ctx.org.id),
      listGrades(db),
      listFxRates(db, ctx.org.id),
    ]);
    if (!detail.ok || !urids.ok || !accounts.ok || !centers.ok || !grades.ok || !rates.ok) {
      body = <ErrorPanel sentence={t("finance.budgets.loadError")} />;
    } else {
      const b = detail.data.budget;
      const target =
        query.extra["in"] && query.extra["in"] !== b.currency ? query.extra["in"] : null;
      const today = new Date().toISOString().slice(0, 10);
      const fx = target ? findFxRate(rates.data, b.currency, target, today) : null;
      const switcher = (
        <nav
          aria-label={t("finance.budgets.showIn")}
          className="flex flex-wrap items-center gap-8 text-text-13"
        >
          <span className="text-text-secondary">{t("finance.budgets.showIn")}</span>
          {[
            b.currency,
            ...new Set(
              rates.data.flatMap((r) => [r.base, r.quote]).filter((c) => c !== b.currency),
            ),
          ].map((c) => (
            <Link
              key={c}
              href={withQuery(page, { in: c === b.currency ? null : c, budget: b.id }) as Route}
              aria-current={(target ?? b.currency) === c ? "true" : undefined}
              className="rounded-chip border border-border-subtle px-8 py-2 font-mono text-text-12 aria-[current=true]:bg-bg-hover aria-[current=true]:text-text-primary"
            >
              {c}
            </Link>
          ))}
        </nav>
      );
      const figures =
        target && !fx ? (
          <p
            role="status"
            className="m-0 rounded-card border border-border-subtle p-12 text-text-13"
          >
            {t("finance.budgets.noRate", { from: b.currency, to: target })}{" "}
            <Link
              className="text-accent-text underline"
              href={`/${ctx.org.slug}/finance/cost-centers#rates` as Route}
            >
              {t("finance.budgets.recordRate")}
            </Link>
          </p>
        ) : (
          <>
            <Figures
              label={t("finance.budgets.figures.label")}
              items={totalsFigures(b, target, fx?.rate ?? null)}
            />
            {fx && target ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("finance.budgets.converted", {
                  rate: format.number(fx.rate, { maximumFractionDigits: 6 }),
                  from: b.currency,
                  to: target,
                  date: format.dateTime(new Date(`${fx.effectiveOn}T00:00:00`), {
                    dateStyle: "medium",
                  }),
                })}
              </p>
            ) : null}
          </>
        );
      if (page.view === "matrix") {
        const centerCode = new Map(centers.data.map((c) => [c.id, c.code]));
        const cols = [
          ...new Set(
            detail.data.lines.map((l) =>
              l.costCenterId ? (centerCode.get(l.costCenterId) ?? "") : "",
            ),
          ),
        ].sort();
        const accts = [...new Set(detail.data.lines.map((l) => l.accountCode ?? ""))].sort();
        const cell = (account: string, center: string) =>
          nullAwareSum(
            detail.data.lines
              .filter(
                (l) =>
                  (l.accountCode ?? "") === account &&
                  (l.costCenterId ? (centerCode.get(l.costCenterId) ?? "") : "") === center,
              )
              .map((l) => l.extendedMinor),
          );
        const nameOf = new Map(accounts.data.map((a) => [a.code, a.name]));
        body = (
          <div className="flex flex-col gap-12">
            {switcher}
            {figures}
            <SimpleTable
              caption={t("finance.budgets.matrixCaption", { budget: b.name })}
              head={[
                t("finance.budgets.columns.account"),
                ...cols.map((c) => c || t("finance.budgets.noCostCenter")),
                t("finance.common.total"),
              ]}
              numeric={cols.map((_, i) => i + 1).concat(cols.length + 1)}
              rows={accts.map((a) => [
                a ? `${nameOf.get(a) ?? a} · ${a}` : t("finance.budgets.unmappedAccount"),
                ...cols.map((c) => {
                  const s = cell(a, c);
                  return s.unpricedCount === 0 && s.total === null
                    ? ""
                    : money(s.total, b.currency);
                }),
                money(
                  nullAwareSum(
                    detail.data.lines
                      .filter((l) => (l.accountCode ?? "") === a)
                      .map((l) => l.extendedMinor),
                  ).total,
                  b.currency,
                ),
              ])}
              foot={[
                t("finance.common.total"),
                ...cols.map((c) =>
                  money(
                    nullAwareSum(
                      detail.data.lines
                        .filter(
                          (l) =>
                            (l.costCenterId ? (centerCode.get(l.costCenterId) ?? "") : "") === c,
                        )
                        .map((l) => l.extendedMinor),
                    ).total,
                    b.currency,
                  ),
                ),
                money(b.totalMinor, b.currency),
              ]}
            />
          </div>
        );
      } else {
        body = (
          <TemplateGridEditor
            header={
              <div className="flex flex-col gap-8">
                <h2 className="m-0 text-heading-16 font-semibold">
                  {b.name}{" "}
                  <span className="font-mono text-text-12 text-text-secondary">
                    {b.projectKey} · {b.currency}
                    {b.isBaseline ? ` · ${t("finance.budgets.baseline")}` : ""}
                  </span>
                </h2>
                {switcher}
                {figures}
              </div>
            }
          >
            <BudgetEditor
              org={ctx.org.slug}
              budgetId={b.id}
              currency={b.currency}
              exponent={exponentOf(exponents, b.currency)}
              lines={detail.data.lines}
              urids={urids.data}
              accounts={accounts.data}
              costCenters={centers.data.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
              grades={grades.data}
              canWrite={canWrite}
            />
          </TemplateGridEditor>
        );
      }
    }
  }

  return (
    <TemplateCollection
      header={header}
      filters={filters}
      peek={
        peek && !query.full ? (
          <RecordPeek
            kindLabel={t("finance.budgets.kind")}
            recordKey={peek.projectKey ?? ""}
            title={peek.name}
            state={peek.isBaseline ? "complete" : "active"}
            stateLabel={
              peek.isBaseline ? t("finance.budgets.baseline") : t("finance.budgets.working")
            }
            properties={[
              {
                label: t("finance.common.project"),
                value: `${peek.projectKey ?? ""} · ${peek.projectName ?? ""}`,
              },
              { label: t("finance.common.currency"), value: peek.currency },
              {
                label: t("finance.budgets.figures.total"),
                value: money(peek.totalMinor, peek.currency),
              },
              { label: t("finance.budgets.columns.unpriced"), value: String(peek.unpricedCount) },
              {
                label: t("finance.budgets.figures.revised"),
                value: money(peek.revisedTotalMinor, peek.currency),
              },
              {
                label: t("finance.budgets.figures.actual"),
                value: money(peek.actualMinor, peek.currency),
              },
            ]}
          >
            <div className="flex flex-wrap gap-8">
              <Link
                className="text-text-13 text-accent-text underline"
                href={
                  withQuery(page, { view: "spreadsheet", budget: peek.id, peek: null }) as Route
                }
              >
                {t("finance.budgets.openGrid")}
              </Link>
              {canWrite ? <EditButton label={t("finance.common.edit")} /> : null}
              {canWrite ? (
                <InlineActionButton
                  action={deleteBudgetAction}
                  fields={{ org: ctx.org.slug, id: peek.id }}
                  label={t("finance.budgets.delete")}
                  variant="danger"
                  icon="Trash2"
                />
              ) : null}
            </div>
            <RecordCollab ctx={ctx} table="app.budgets" id={peek.id} canUpload={canWrite} />
          </RecordPeek>
        ) : null
      }
    >
      {body}
      {query.create && canWrite ? (
        <FormSheet title={t("finance.budgets.create")} flag="create">
          <BudgetForm
            org={ctx.org.slug}
            projects={page.projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
            projectId={page.project?.id ?? null}
            currencies={currencies}
            defaultCurrency={page.project?.currency || "USD"}
          />
        </FormSheet>
      ) : null}
      {query.edit && peek && canWrite ? (
        <FormSheet title={t("finance.budgets.edit")} flag="edit">
          <BudgetForm
            org={ctx.org.slug}
            projects={[]}
            projectId={peek.projectId}
            currencies={currencies}
            defaultCurrency={peek.currency}
            budget={{ id: peek.id, name: peek.name, isBaseline: peek.isBaseline }}
          />
        </FormSheet>
      ) : null}
    </TemplateCollection>
  );
}
