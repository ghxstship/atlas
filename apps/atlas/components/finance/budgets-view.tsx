import {
  budgetCommittedTotal,
  convertMinor,
  findFxRate,
  fxRateAgeDays,
  isFxRateStale,
  getBudget,
  listBudgets,
  listCostCenters,
  listFxRates,
  listGlAccounts,
  listGrades,
  listUridOptions,
  nullAwareSum,
  type BudgetForecastTotals,
  type BudgetLine,
  type BudgetSummary,
} from "@xos/data/finance";
import { countProjectQuotes } from "@xos/data/quotes";
import {
  compareBudgetLines,
  getBudgetVersionLines,
  listBudgetVersions,
  liveCompareLine,
} from "@xos/data/budget-versions";
import { getNode } from "@xos/ia";
import Link from "next/link";
import { observability } from "@/lib/observability";
import type { Route } from "next";
import { getFormatter, getLocale } from "next-intl/server";
import { PageHeader, TemplateCollection, TemplateGridEditor } from "./ui-collection";
import { CustomFieldList } from "@/components/custom-fields/list";
import { collectionPeek } from "@/components/shell/collection-peek";
import { customFieldList, hasCustomFields } from "@/lib/custom-fields/server";
import type { CustomFieldListView } from "@/lib/custom-fields/types";
import { clearConditions, filterBudgetLines, hasConditions } from "@/lib/finance/filtered-lines";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { exponentOf, getExponents, moneyFormatter } from "@/lib/finance/money";
import { importLinkHref } from "@/lib/imports/import-link";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { orgToday } from "@/lib/shell/time-zone";
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
 * with the rate date, and an unpriced figure stays Unpriced (journey 37). In the grid and the matrix the
 * org's filterable custom fields on budget lines (tags, 3872) show as columns and filter the lines through Add
 * filter; the figures always cover the whole budget.
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
    observability.logger.error("budgets failed to load", { error: budgets.error });
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

  const totalsFigures = (
    b: BudgetSummary,
    lines: readonly BudgetLine[],
    forecast: BudgetForecastTotals | null,
    target: string | null,
    rate: number | null,
  ) => {
    const cur = target ?? b.currency;
    const conv = (v: number | null) =>
      rate === null || target === null
        ? v
        : convertMinor(v, rate, exponentOf(exponents, b.currency), exponentOf(exponents, target));
    const variance = b.revisedTotalMinor === null ? null : b.revisedTotalMinor - b.actualMinor;
    // Committed is withheld, never partial, when any line's purchase orders are hidden from the viewer,
    // and Unpriced when a counted order line has no price (approval refuses those, so it is rare).
    const committed = budgetCommittedTotal(lines);
    const committedWithheld = lines.some((l) => l.committedWithheld);
    // Figures appear only when a line or the budget carries pricing, and only ever NULL-aware.
    const priced =
      b.defaultMarkupBp !== null ||
      lines.some((l) => l.effectiveMarkupBp !== null || l.clientUnitPriceMinor !== null);
    const quoted = lines.filter((l) => !l.excludedFromQuote);
    const clientTotal =
      quoted.length === 0 || quoted.some((l) => l.clientExtendedMinor === null)
        ? null
        : quoted.reduce((sum, l) => sum + (l.clientExtendedMinor ?? 0), 0);
    const margin =
      clientTotal === null || quoted.some((l) => l.marginMinor === null)
        ? null
        : quoted.reduce((sum, l) => sum + (l.marginMinor ?? 0), 0);
    // app.budget_forecast_totals, so approved changes with no line count and EFC reconciles with Revised.
    const forecastWithheld = forecast?.isWithheld ?? true;
    const unallocated = forecast?.unallocatedChangeMinor ?? 0;
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
        label: t("finance.budgets.figures.committed"),
        value: committed
          ? money(conv(committed.totalMinor), cur)
          : committedWithheld
            ? t("finance.budgets.figures.withheld")
            : t("finance.budgets.figures.unpriced"),
        caption: committed
          ? t("finance.budgets.figures.committedCaption", {
              count: committed.committedLineCount,
              other: committed.otherCurrencyLineCount,
            })
          : committedWithheld
            ? t("finance.budgets.committedWithheld")
            : t("finance.budgets.figures.committedUnpricedCaption"),
      },
      {
        label: t("finance.budgets.figures.actual"),
        value: money(conv(b.actualMinor), cur),
        caption:
          variance === null
            ? t("finance.budgets.figures.varianceUnknown")
            : t("finance.budgets.figures.variance", { amount: money(conv(variance), cur) }),
        tone: variance !== null && variance < 0 ? ("danger" as const) : undefined,
      },
      ...(priced
        ? [
            {
              label: t("finance.budgets.figures.clientTotal"),
              value: money(conv(clientTotal), cur),
            },
            { label: t("finance.budgets.figures.margin"), value: money(conv(margin), cur) },
          ]
        : []),
      {
        label: t("finance.budgets.figures.efc"),
        value: forecastWithheld
          ? t("finance.budgets.figures.withheld")
          : money(conv(forecast?.efcMinor ?? null), cur),
        caption: forecastWithheld
          ? t("finance.budgets.committedWithheld")
          : unallocated !== 0
            ? t("finance.budgets.figures.efcUnallocated", {
                amount: money(conv(unallocated), cur),
              })
            : undefined,
      },
      {
        label: t("finance.budgets.figures.forwardExposure"),
        value: forecastWithheld
          ? t("finance.budgets.figures.withheld")
          : money(conv(forecast?.forwardExposureMinor ?? null), cur),
      },
    ];
  };

  let body;
  // The budget lines' custom fields, for the grid and the matrix only; the table lists budgets, not lines.
  let lineFieldView: CustomFieldListView | null = null;
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
    const [detail, urids, accounts, centers, grades, rates, custom, lineFields] = await Promise.all(
      [
        getBudget(db, ctx.org.id, selected.id),
        listUridOptions(db),
        listGlAccounts(db),
        listCostCenters(db, ctx.org.id),
        listGrades(db),
        listFxRates(db, ctx.org.id),
        customFieldList(ctx, "app.budget_lines", query.extra),
        canWrite ? hasCustomFields(ctx, "app.budget_lines") : Promise.resolve(false),
      ],
    );
    if (!detail.ok || !urids.ok || !accounts.ok || !centers.ok || !grades.ok || !rates.ok) {
      // Which read failed, so an intermittent failure (journey 34's paste in CI) names its cause in the server log.
      const failed = Object.entries({ detail, urids, accounts, centers, grades, rates }).flatMap(
        ([name, result]) => (result.ok ? [] : [{ name, error: result.error }]),
      );
      observability.logger.error("budget failed to load", { budgetId: selected.id, failed });
      body = <ErrorPanel sentence={t("finance.budgets.loadError")} />;
    } else {
      const b = detail.data.budget;
      const lines = filterBudgetLines(detail.data.lines, custom.keep, hasConditions(query.extra));
      lineFieldView = await custom.view(lines.shown.map((l) => l.id));
      const filteredNote = lines.filtered ? (
        <p role="status" className="m-0 flex flex-wrap items-center gap-8 text-text-13">
          {t("finance.budgets.filteredLines", { shown: lines.shown.length, total: lines.total })}
          <Link
            className="text-accent-text underline"
            href={withQuery(page, clearConditions(query.extra)) as Route}
          >
            {t("finance.common.clearFilters")}
          </Link>
        </p>
      ) : null;
      const target =
        query.extra["in"] && query.extra["in"] !== b.currency ? query.extra["in"] : null;
      const today = await orgToday(ctx);
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
              items={totalsFigures(
                b,
                detail.data.lines,
                detail.data.forecast,
                target,
                fx?.rate ?? null,
              )}
            />
            {fx && target ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {/* Every converted figure shows its rate date (Section 15), and a cross rate says so. */}
                {t(fx.via ? "finance.budgets.convertedVia" : "finance.budgets.converted", {
                  rate: format.number(fx.rate, { maximumFractionDigits: 6 }),
                  from: b.currency,
                  to: target,
                  via: fx.via ?? "",
                  date: format.dateTime(new Date(`${fx.effectiveOn}T00:00:00`), {
                    dateStyle: "medium",
                  }),
                })}
              </p>
            ) : null}
            {fx && target && isFxRateStale(fx.effectiveOn, today) ? (
              <p role="status" className="m-0 text-text-12 text-warning-text">
                {t("finance.budgets.staleRate", { days: fxRateAgeDays(fx.effectiveOn, today) })}
              </p>
            ) : null}
          </>
        );
      if (page.view === "matrix") {
        const centerCode = new Map(centers.data.map((c) => [c.id, c.code]));
        const cols = [
          ...new Set(
            lines.shown.map((l) => (l.costCenterId ? (centerCode.get(l.costCenterId) ?? "") : "")),
          ),
        ].sort();
        const accts = [...new Set(lines.shown.map((l) => l.accountCode ?? ""))].sort();
        const cell = (account: string, center: string) =>
          nullAwareSum(
            lines.shown
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
            {filteredNote}
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
                    lines.shown
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
                      lines.shown
                        .filter(
                          (l) =>
                            (l.costCenterId ? (centerCode.get(l.costCenterId) ?? "") : "") === c,
                        )
                        .map((l) => l.extendedMinor),
                    ).total,
                    b.currency,
                  ),
                ),
                // While conditions apply the footer adds up the shown lines; the figures stay whole-budget.
                money(lines.filtered ? lines.subtotal.total : b.totalMinor, b.currency),
              ]}
            />
          </div>
        );
      } else if (query.extra["compare"]) {
        const fromId = query.extra["compare"];
        const toId = query.extra["to"] ?? "live";
        const [from, to, known] = await Promise.all([
          getBudgetVersionLines(db, fromId),
          toId === "live" ? Promise.resolve(null) : getBudgetVersionLines(db, toId),
          listBudgetVersions(db, b.id),
        ]);
        if (!from.ok || (to && !to.ok) || !known.ok) {
          body = <ErrorPanel sentence={t("finance.budgets.versions.loadError")} />;
        } else {
          const after = to?.ok ? to.data : detail.data.lines.map(liveCompareLine);
          const compared = compareBudgetLines(from.data, after);
          const changedOnly = query.extra["show"] !== "all";
          const listed = compared.lines.filter((l) => !changedOnly || l.status !== "unchanged");
          const fromVersion = known.data.find((v) => v.id === fromId);
          const toVersion = known.data.find((v) => v.id === toId);
          const delta = (v: number | null) => money(v, b.currency);
          body = (
            <div className="flex flex-col gap-12">
              <div className="flex flex-wrap items-center justify-between gap-8">
                <h2 className="m-0 text-heading-16 font-semibold">
                  {t("finance.budgets.versions.compareTitle", {
                    from: fromVersion?.label ?? "",
                    to: toVersion?.label ?? t("finance.budgets.versions.live"),
                  })}
                </h2>
                <Link
                  className="text-text-13 text-accent-text underline"
                  href={
                    withQuery(page, { compare: null, to: null, show: null, budget: b.id }) as Route
                  }
                >
                  {t("finance.budgets.versions.backToGrid")}
                </Link>
              </div>
              <Figures
                label={t("finance.budgets.versions.compare")}
                items={[
                  {
                    label: t("finance.budgets.versions.costChange"),
                    value: delta(compared.costDeltaMinor),
                  },
                  {
                    label: t("finance.budgets.versions.clientChange"),
                    value: delta(compared.clientDeltaMinor),
                  },
                  { label: t("finance.budgets.versions.added"), value: String(compared.added) },
                  {
                    label: t("finance.budgets.versions.changedRemoved"),
                    value: `${compared.changed} / ${compared.removed}`,
                  },
                ]}
              />
              <nav
                aria-label={t("finance.budgets.versions.compare")}
                className="flex gap-8 text-text-13"
              >
                <Link
                  aria-current={changedOnly ? "true" : undefined}
                  className="rounded-chip border border-border-subtle px-8 py-2 aria-[current=true]:bg-bg-hover"
                  href={withQuery(page, { show: null }) as Route}
                >
                  {t("finance.budgets.versions.changedOnly")}
                </Link>
                <Link
                  aria-current={changedOnly ? undefined : "true"}
                  className="rounded-chip border border-border-subtle px-8 py-2 aria-[current=true]:bg-bg-hover"
                  href={withQuery(page, { show: "all" }) as Route}
                >
                  {t("finance.budgets.versions.allLines")}
                </Link>
              </nav>
              <SimpleTable
                caption={t("finance.budgets.versions.compare")}
                head={[
                  t("finance.common.description"),
                  t("finance.budgets.versions.status"),
                  t("finance.budgets.versions.fieldsChanged"),
                  t("finance.budgets.versions.costBefore"),
                  t("finance.budgets.versions.costAfter"),
                  t("finance.budgets.versions.costChange"),
                  t("finance.budgets.versions.clientChange"),
                ]}
                numeric={[3, 4, 5, 6]}
                rows={listed.map((l) => [
                  l.description,
                  t(`finance.budgets.versions.statuses.${l.status}`),
                  l.changed.map((f) => t(`finance.budgets.versions.changedFields.${f}`)).join(", "),
                  delta(l.costBeforeMinor),
                  delta(l.costAfterMinor),
                  delta(l.costDeltaMinor),
                  delta(l.clientDeltaMinor),
                ])}
              />
            </div>
          );
        }
      } else {
        const columnSet =
          query.extra["columns"] === "client" || query.extra["columns"] === "forecast"
            ? query.extra["columns"]
            : "cost";
        const quoteCount = await countProjectQuotes(db, b.projectId);
        const columnLinks = (
          <nav
            aria-label={t("finance.budgets.columnSets.label")}
            className="flex flex-wrap items-center gap-8 text-text-13"
          >
            {(["cost", "client", "forecast"] as const).map((set) => (
              <Link
                key={set}
                href={
                  withQuery(page, { columns: set === "cost" ? null : set, budget: b.id }) as Route
                }
                aria-current={columnSet === set ? "true" : undefined}
                className="rounded-chip border border-border-subtle px-8 py-2 aria-[current=true]:bg-bg-hover aria-[current=true]:text-text-primary"
              >
                {t(`finance.budgets.columnSets.${set}`)}
              </Link>
            ))}
            <Link
              className="text-accent-text underline"
              href={
                `/${ctx.org.slug}/finance/quotes?project=${encodeURIComponent(b.projectKey ?? "")}` as Route
              }
            >
              {t("finance.budgets.quotesLink", { count: quoteCount.ok ? quoteCount.data : 0 })}
            </Link>
          </nav>
        );
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
                {columnLinks}
                {figures}
                {filteredNote}
              </div>
            }
          >
            <BudgetEditor
              org={ctx.org.slug}
              budgetId={b.id}
              projectId={b.projectId}
              me={
                ctx.viewer.person
                  ? {
                      key: ctx.viewer.person.id,
                      name: ctx.viewer.person.fullName ?? t("collab.history.someone"),
                    }
                  : null
              }
              currency={b.currency}
              exponent={exponentOf(exponents, b.currency)}
              lines={lines.shown}
              allLines={detail.data.lines}
              lineFields={lineFields}
              urids={urids.data}
              costCenters={centers.data.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
              grades={grades.data}
              canWrite={canWrite}
              columnSet={columnSet}
              defaultMarkupBp={b.defaultMarkupBp}
              importHref={importLinkHref(ctx.org.slug, ctx.nav, canWrite, {
                target: "budget_lines",
                budgetId: b.id,
              })}
            />
          </TemplateGridEditor>
        );
      }
    }
  }

  // The grid's Add filter and its custom field columns read the budget lines' fields (A117 CollectionViews).
  return (
    <CustomFieldList value={lineFieldView}>
      <TemplateCollection
        header={header}
        filters={filters}
        // The full page (`&full=1`) shows the `?peek` budget's grid; a key with no budget goes to the
        // shell's peek.
        peek={collectionPeek(
          query.full ? null : query.peek,
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
          ) : null,
        )}
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
              budget={{
                id: peek.id,
                name: peek.name,
                isBaseline: peek.isBaseline,
                defaultMarkupBp: peek.defaultMarkupBp,
              }}
            />
          </FormSheet>
        ) : null}
      </TemplateCollection>
    </CustomFieldList>
  );
}
