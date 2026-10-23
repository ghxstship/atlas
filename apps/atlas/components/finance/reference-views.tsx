import {
  COST_CENTER_KINDS,
  UPL_FIELDS,
  listCostCenters,
  getFxFeedStatus,
  latestFxRates,
  listFxRates,
  listGlAccounts,
  type FxFeedStatus,
  listPeriods,
  listPostingLines,
  listScopeNodes,
  listUplMappings,
  toUplRow,
} from "@xos/data/finance";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { exponentOf } from "@/lib/finance/money";
import { sitemap } from "@/lib/shell/sitemap";
import { getOrgTimeZone, orgToday } from "@/lib/shell/time-zone";
import { dateIn } from "@xos/data/calendar";
import { saveCostCenterAction } from "@/app/[org]/finance/actions";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Figures, Section, SimpleTable } from "./figures";
import { CostCenterForm } from "./forms-cost-center-form";
import { FxRateForm } from "./forms-fx-rate-form";
import { UplExportForm } from "./forms-upl-export-form";
import { CollectionTable } from "./kit-collection-table";
import { EditButton } from "./kit-edit-button";
import { FilterBar } from "./kit-filter-bar";
import { FormSheet } from "./kit-form-sheet";
import { InlineActionButton } from "./kit-inline-action-button";
import { ViewSwitcher } from "./kit-view-switcher";
import { type Row } from "./kit.types";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "./panels";
import { RecordCollab } from "./record";
import { PageHeader, TemplateCollection } from "./ui";

/**
 * Finance reference pages (Section 4.5.5): the Universal Posting Line export (Section 3.11, journey 8),
 * the fixed chart of accounts (read-only, Bible tab 29) and cost centers with the exchange rates the
 * budget conversions use.
 */

export async function UplView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.universal-posting-line-export").node.label);
  const header = (
    <PageHeader title={title} views={<ViewSwitcher views={page.views} value={page.view} />} />
  );
  if (!access.can("finance.journal.read")) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <RefusalPanel capability="finance.journal.read" href={`/${ctx.org.slug}/home`} />
      </TemplateCollection>
    );
  }
  const db = ctx.viewer.db;
  const [periods, mappings] = await Promise.all([listPeriods(db, ctx.org.id), listUplMappings(db)]);
  if (!periods.ok || !mappings.ok) {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={t("finance.upl.loadError")} />
      </TemplateCollection>
    );
  }
  const period =
    periods.data.find((p) => p.id === query.extra["period"]) ??
    periods.data.find((p) => p.state === "In Period") ??
    periods.data[0];
  if (!period) {
    return (
      <TemplateCollection header={header}>
        <EmptyPanel
          icon="FileSpreadsheet"
          sentence={t("finance.upl.noPeriods")}
          actionLabel={t("finance.periods.create")}
          href={`/${ctx.org.slug}/finance/periods?create=1`}
        />
      </TemplateCollection>
    );
  }
  const lines = await listPostingLines(db, {
    orgId: ctx.org.id,
    from: period.startsOn,
    to: period.endsOn,
    projectId: page.project?.id ?? null,
  });
  if (!lines.ok) {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={t("finance.upl.loadError")} />
      </TemplateCollection>
    );
  }
  const canExport = access.can("finance.upl.export");
  const target = mappings.data.find((m) => m.target === query.extra["target"]) ?? null;
  const upl = lines.data.map((l) => ({
    id: l.id,
    row: toUplRow(l, exponentOf(c.exponents, l.currency)),
    line: l,
  }));
  const byCurrency = new Map<string, { debits: number; credits: number; count: number }>();
  for (const { line } of upl) {
    const s = byCurrency.get(line.currency) ?? { debits: 0, credits: 0, count: 0 };
    if (line.amountMinor >= 0) s.debits += line.amountMinor;
    else s.credits -= line.amountMinor;
    s.count += 1;
    byCurrency.set(line.currency, s);
  }
  const periodNav = (
    <nav
      aria-label={t("finance.upl.periods")}
      className="flex flex-wrap items-center gap-8 text-text-13"
    >
      <span className="text-text-secondary">{t("finance.upl.periods")}</span>
      {periods.data.slice(0, 12).map((p) => (
        <Link
          key={p.id}
          href={withQuery(page, { period: p.id }) as Route}
          aria-current={p.id === period.id ? "true" : undefined}
          className="rounded-chip border border-border-subtle px-8 py-2 text-text-12 aria-[current=true]:bg-bg-hover aria-[current=true]:text-text-primary"
        >
          {p.startsOn.slice(0, 7)} · {c.state("accounting_period", p.state)}
        </Link>
      ))}
    </nav>
  );
  const columnsFor = target ? UPL_FIELDS.map((f) => target.columns[f] ?? f) : [...UPL_FIELDS];
  const tableRows: Row[] = upl.slice(0, 500).map(({ id, row }) => ({ id, ...row }));
  return (
    <TemplateCollection
      header={header}
      filters={
        <FilterBar
          projects={
            page.inProject
              ? undefined
              : page.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))
          }
          project={query.project}
          showSearch={false}
        />
      }
    >
      <div className="flex flex-col gap-16">
        {periodNav}
        <Figures
          label={t("finance.upl.summary")}
          items={[
            { label: t("finance.upl.lineCount"), value: c.number(upl.length) },
            ...[...byCurrency.entries()].flatMap(([cur, s]) => [
              { label: t("finance.upl.debits", { currency: cur }), value: c.money(s.debits, cur) },
              {
                label: t("finance.upl.credits", { currency: cur }),
                value: c.money(s.credits, cur),
                caption:
                  s.debits === s.credits ? t("finance.upl.balanced") : t("finance.upl.unbalanced"),
                tone: s.debits === s.credits ? ("success" as const) : ("danger" as const),
              },
            ]),
          ]}
        />
        {canExport ? (
          <UplExportForm
            org={ctx.org.slug}
            from={period.startsOn}
            to={period.endsOn}
            projectId={page.project?.id ?? null}
            targets={mappings.data.map((m) => ({
              value: m.target,
              label: t(`finance.upl.targets.${m.target}`),
            }))}
          />
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("finance.upl.exportNeedsCapability")}
          </p>
        )}
        <nav
          aria-label={t("finance.upl.preview")}
          className="flex flex-wrap items-center gap-8 text-text-13"
        >
          <span className="text-text-secondary">{t("finance.upl.preview")}</span>
          {[null, ...mappings.data.map((m) => m.target)].map((m) => (
            <Link
              key={m ?? "upl"}
              href={withQuery(page, { target: m }) as Route}
              aria-current={(target?.target ?? null) === m ? "true" : undefined}
              className="rounded-chip border border-border-subtle px-8 py-2 text-text-12 aria-[current=true]:bg-bg-hover aria-[current=true]:text-text-primary"
            >
              {t(`finance.upl.targets.${m ?? "upl"}`)}
            </Link>
          ))}
        </nav>
        {upl.length === 0 ? (
          <EmptyPanel
            icon="FileSpreadsheet"
            sentence={t("finance.upl.empty", { period: period.startsOn.slice(0, 7) })}
            actionLabel={t("finance.upl.openJournal")}
            href={`/${ctx.org.slug}/finance/journal`}
          />
        ) : page.view === "list" ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {upl.map(({ id, row }) => (
              <li
                key={id}
                className="flex flex-wrap items-baseline justify-between gap-8 py-8 text-text-13"
              >
                <span>
                  <span className="font-mono text-text-12 text-text-secondary">
                    {row.date} · {row.account_code}
                  </span>{" "}
                  {row.description}
                </span>
                <span className="tabular-nums">
                  {row.amount} {row.currency}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <CollectionTable
            label={t("finance.upl.tableLabel")}
            // A posting line has no record panel: its row opens nothing.
            activatable={false}
            columns={UPL_FIELDS.map((f, i) => ({
              key: f,
              label: columnsFor[i] ?? f,
              ...(f === "amount" || f === "quantity"
                ? { type: "number" as const }
                : f === "description"
                  ? { wrap: true }
                  : { type: "code" as const }),
            }))}
            rows={tableRows}
          />
        )}
        {target ? (
          <Section
            id="upl-mapping"
            title={t("finance.upl.mappingTitle", {
              target: t(`finance.upl.targets.${target.target}`),
            })}
          >
            <p className="m-0 text-text-12 text-text-secondary">
              {t("finance.upl.mappingSentence")}
            </p>
            <SimpleTable
              caption={t("finance.upl.mappingTitle", {
                target: t(`finance.upl.targets.${target.target}`),
              })}
              head={[t("finance.upl.uplField"), t("finance.upl.targetColumn")]}
              rows={UPL_FIELDS.map((f) => [f, target.columns[f] ?? t("finance.upl.unchanged")])}
            />
          </Section>
        ) : null}
      </div>
    </TemplateCollection>
  );
}

export async function AccountsView({ page }: { page: FinancePage }) {
  const { ctx, access } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.chart-of-accounts").node.label);
  if (!access.can("finance.gl.read")) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <RefusalPanel capability="finance.gl.read" href={`/${ctx.org.slug}/home`} />
      </TemplateCollection>
    );
  }
  const accounts = await listGlAccounts(ctx.viewer.db);
  if (!accounts.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("finance.accounts.loadError")} />
      </TemplateCollection>
    );
  }
  const header = (
    <PageHeader
      title={title}
      count={accounts.data.length}
      views={<ViewSwitcher views={page.views} value={page.view} />}
    />
  );
  const types = [...new Set(accounts.data.map((a) => a.type))];
  return (
    <TemplateCollection header={header}>
      <p className="m-0 max-w-layout-reading text-text-13 text-text-secondary">
        {t("finance.accounts.sentence")}
      </p>
      {page.view === "tree" ? (
        <div className="flex flex-col gap-16">
          {types.map((type) => (
            <Section key={type} id={`accounts-${type}`} title={t(`finance.accounts.types.${type}`)}>
              <ul className="m-0 flex list-none flex-col gap-4 border-s border-border-subtle p-0 ps-12">
                {accounts.data
                  .filter((a) => a.type === type)
                  .map((a) => (
                    <li key={a.code} className="text-text-13">
                      <span className="font-mono text-text-12 text-text-secondary">{a.code}</span>{" "}
                      {a.name}
                    </li>
                  ))}
              </ul>
            </Section>
          ))}
        </div>
      ) : (
        <CollectionTable
          label={title}
          // The chart is read-only and an account has no record panel: its row opens nothing.
          activatable={false}
          columns={[
            { key: "code", label: t("finance.accounts.code"), type: "code" },
            { key: "name", label: t("finance.accounts.name"), wrap: true },
            { key: "type", label: t("finance.accounts.type") },
            { key: "classCode", label: t("finance.accounts.class"), type: "code" },
            { key: "taxType", label: t("finance.accounts.taxType") },
          ]}
          rows={accounts.data.map((a) => ({
            id: a.code,
            code: a.code,
            name: a.name,
            type: t(`finance.accounts.types.${a.type}`),
            classCode: a.classCode ?? "",
            taxType: a.taxType,
          }))}
        />
      )}
    </TemplateCollection>
  );
}

export async function CostCentersView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.cost-centers").node.label);
  const empty = {
    icon: "Landmark",
    sentence: t("finance.costCenters.empty"),
    actionLabel: t("finance.costCenters.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.costCenters.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.budget.read") && !access.can("finance.cost_center.write")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.budget.read" />;
  }
  const db = ctx.viewer.db;
  const [centers, scopes, rates, feed, zone] = await Promise.all([
    listCostCenters(db, ctx.org.id),
    listScopeNodes(db, ctx.org.id),
    listFxRates(db, ctx.org.id),
    getFxFeedStatus(db),
    getOrgTimeZone(ctx),
  ]);
  if (!centers.ok || !scopes.ok || !rates.ok) {
    return (
      <FinanceCollection {...base} canCreate={false} error={t("finance.costCenters.loadError")} />
    );
  }
  const canWrite = access.can("finance.cost_center.write");
  const scopeName = new Map(scopes.data.map((s) => [s.id, `${s.code} · ${s.name}`]));
  const term = query.q?.toLowerCase() ?? null;
  const shown = centers.data.filter(
    (cc) =>
      term === null || cc.code.toLowerCase().includes(term) || cc.name.toLowerCase().includes(term),
  );
  const peek = query.peek ? centers.data.find((cc) => cc.id === query.peek) : undefined;
  const detail: RecordDetail | null = peek
    ? {
        kindLabel: t("finance.costCenters.kind"),
        recordKey: peek.code,
        title: peek.name,
        state: "active",
        stateLabel: t(`finance.costCenters.kinds.${peek.kind}`),
        propertiesLabel: t("finance.common.properties"),
        properties: [
          { label: t("finance.costCenters.fields.code"), value: peek.code },
          {
            label: t("finance.costCenters.fields.kind"),
            value: t(`finance.costCenters.kinds.${peek.kind}`),
          },
          {
            label: t("finance.costCenters.fields.scopeNode"),
            value: peek.scopeNodeId
              ? (scopeName.get(peek.scopeNodeId) ?? "")
              : t("finance.common.none"),
          },
          {
            label: t("finance.costCenters.template"),
            value: peek.templateId ?? t("finance.common.none"),
          },
        ],
        content: (
          <>
            {canWrite ? (
              <div className="flex flex-wrap gap-8">
                <EditButton label={t("finance.common.edit")} />
                <InlineActionButton
                  action={saveCostCenterAction}
                  fields={{ org: ctx.org.slug, id: peek.id, delete: "1" }}
                  label={t("finance.costCenters.delete")}
                  variant="danger"
                  icon="Trash2"
                />
              </div>
            ) : null}
            <RecordCollab ctx={ctx} table="app.cost_centers" id={peek.id} canUpload={canWrite} />
          </>
        ),
      }
    : null;
  const scopeOptions = scopes.data.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }));
  const currencies = [...c.exponents.keys()].sort();
  return (
    <FinanceCollection
      {...base}
      canCreate={canWrite}
      count={shown.length}
      columns={[
        { key: "code", label: t("finance.costCenters.fields.code"), type: "code" },
        { key: "name", label: t("finance.costCenters.fields.name"), wrap: true },
        { key: "kind", label: t("finance.costCenters.fields.kind") },
        { key: "scope", label: t("finance.costCenters.fields.scopeNode") },
      ]}
      rows={shown.map((cc) => ({
        id: cc.id,
        code: cc.code,
        name: cc.name,
        kind: t(`finance.costCenters.kinds.${cc.kind}`),
        scope: cc.scopeNodeId ? (scopeName.get(cc.scopeNodeId) ?? "") : "",
      }))}
      detail={detail}
      above={
        page.view === "tree" ? (
          <div className="flex flex-col gap-12">
            {COST_CENTER_KINDS.map((kind) => (
              <Section key={kind} id={`cc-${kind}`} title={t(`finance.costCenters.kinds.${kind}`)}>
                <ul className="m-0 flex list-none flex-col gap-4 border-s border-border-subtle p-0 ps-12">
                  {shown
                    .filter((cc) => cc.kind === kind)
                    .map((cc) => (
                      <li key={cc.id} className="text-text-13">
                        <Link
                          href={withQuery(page, { peek: cc.id }) as Route}
                          className="text-text-primary hover:underline"
                        >
                          <span className="font-mono text-text-12 text-text-secondary">
                            {cc.code}
                          </span>{" "}
                          {cc.name}
                        </Link>
                      </li>
                    ))}
                </ul>
              </Section>
            ))}
          </div>
        ) : null
      }
      sheet={
        <>
          {query.create && canWrite ? (
            <FormSheet title={t("finance.costCenters.create")} flag="create">
              <CostCenterForm org={ctx.org.slug} scopeNodes={scopeOptions} />
            </FormSheet>
          ) : query.edit && peek && canWrite ? (
            <FormSheet title={t("finance.costCenters.edit")} flag="edit">
              <CostCenterForm
                org={ctx.org.slug}
                scopeNodes={scopeOptions}
                center={{
                  id: peek.id,
                  code: peek.code,
                  name: peek.name,
                  kind: peek.kind,
                  scopeNodeId: peek.scopeNodeId,
                }}
              />
            </FormSheet>
          ) : null}
          <div id="rates" className="mt-24 flex flex-col gap-12">
            <Section id="fx-rates" title={t("finance.fx.title")}>
              <p className="m-0 text-text-12 text-text-secondary">{t("finance.fx.sentence")}</p>
              {feed.ok ? <FxFeedNote status={feed.data} zone={zone} date={c.date} t={t} /> : null}
              {rates.data.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">{t("finance.fx.empty")}</p>
              ) : (
                <SimpleTable
                  caption={t("finance.fx.title")}
                  head={[
                    t("finance.fx.fields.base"),
                    t("finance.fx.fields.quote"),
                    t("finance.fx.fields.rate"),
                    t("finance.fx.fields.effectiveOn"),
                    t("finance.fx.fields.source"),
                  ]}
                  numeric={[2]}
                  rows={latestFxRates(rates.data).map((r) => [
                    r.base,
                    r.quote,
                    String(r.rate),
                    c.date(r.effectiveOn),
                    r.source,
                  ])}
                />
              )}
              {rates.data.length > 0 ? (
                <p className="m-0 text-text-12 text-text-secondary">{t("finance.fx.latestOnly")}</p>
              ) : null}
              {canWrite ? (
                <FxRateForm
                  org={ctx.org.slug}
                  currencies={currencies}
                  base="USD"
                  quote="EUR"
                  today={await orgToday(ctx)}
                />
              ) : null}
            </Section>
          </div>
        </>
      }
    />
  );
}

/**
 * Where the ECB reference rates stand (Section 15, ADR 0053): when they last arrived and for which publication
 * date, or that the feed is failing and why, so a stale conversion is never presented as current.
 */
function FxFeedNote({
  status,
  zone,
  date,
  t,
}: {
  status: FxFeedStatus;
  zone: string;
  date: (iso: string) => string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const day = (at: string) => date(dateIn(new Date(at), zone));
  if (status.lastSuccessAt === null) {
    return (
      <p role="status" className="m-0 text-text-12 text-text-secondary">
        {status.lastFailureAt
          ? t("finance.fx.feed.neverFailed", {
              date: day(status.lastFailureAt),
              error: status.lastError ?? "",
            })
          : t("finance.fx.feed.never")}
      </p>
    );
  }
  if (status.failuresSinceSuccess > 0 && status.lastFailureAt) {
    return (
      <p role="status" className="m-0 text-text-12 text-warning-text">
        {t("finance.fx.feed.failing", {
          count: status.failuresSinceSuccess,
          date: day(status.lastFailureAt),
          error: status.lastError ?? "",
        })}
      </p>
    );
  }
  return (
    <p className="m-0 text-text-12 text-text-secondary">
      {t("finance.fx.feed.arrived", {
        date: day(status.lastSuccessAt),
        rateDate: status.lastRateDate ? date(status.lastRateDate) : "",
      })}
    </p>
  );
}
