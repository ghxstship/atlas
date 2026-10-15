import {
  JOURNAL_STATES,
  NEXT_STATES,
  PERIOD_STATES,
  listCostCenters,
  listGlAccounts,
  listJournalEntries,
  listPeriods,
  listTransitions,
  type AccountingPeriod,
} from "@xos/data/finance";
import { getNode } from "@xos/ia";
import type { FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { iconState } from "@/lib/finance/states";
import { sitemap } from "@/lib/shell/sitemap";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Section, SimpleTable } from "./figures";
import { JournalForm, PeriodForm } from "./forms";
import { FormSheet, TransitionBar, type Row } from "./kit";
import { RecordActivity, RecordCollab } from "./record";

/**
 * Finance > Journal and Finance > Periods (Section 4.5.5, invariant 13). Entries are prepared by one
 * person and posted by another (Section 8.2), only when balanced and only into a period that accepts
 * postings; documents the platform posts (approved expenses and invoices, payroll runs) appear here
 * with their source. A period moves Open, In Period, Closing, Closed, Audited, Archived one step at a
 * time, and a Closed period refuses every posting (journey 7).
 */
export async function JournalView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.journal").node.label);
  const empty = {
    icon: "BookOpen",
    sentence: t("finance.journal.empty"),
    actionLabel: t("finance.journal.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.journal.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.journal.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.journal.read" />;
  }
  const db = ctx.viewer.db;
  const [entries, periods, accounts, centers] = await Promise.all([
    listJournalEntries(db, { orgId: ctx.org.id, projectId: page.project?.id ?? null }),
    listPeriods(db, ctx.org.id),
    listGlAccounts(db),
    listCostCenters(db, ctx.org.id),
  ]);
  if (!entries.ok || !periods.ok || !accounts.ok || !centers.ok) {
    return <FinanceCollection {...base} canCreate={false} error={t("finance.journal.loadError")} />;
  }
  const canWrite = access.can("finance.journal.write");
  const canPost = access.can("finance.journal.post");
  const me = ctx.viewer.person?.id ?? null;
  const projectKey = new Map(page.projects.map((p) => [p.id, p.key]));
  const accountName = new Map(accounts.data.map((a) => [a.code, a.name]));
  const centerCode = new Map(centers.data.map((cc) => [cc.id, cc.code]));
  const term = query.q?.toLowerCase() ?? null;
  const shown = entries.data.filter(
    (e) =>
      (!query.state || e.state === query.state) &&
      (term === null || e.memo.toLowerCase().includes(term)),
  );
  const sourceLabel = (s: string | null) =>
    s ? t(`finance.journal.sources.${s}`) : t("finance.journal.sources.manual");
  const rows: Row[] = shown.map((e) => ({
    id: e.id,
    date: c.date(e.entryDate),
    memo: e.memo,
    project: e.projectId ? (projectKey.get(e.projectId) ?? "") : "",
    source: sourceLabel(e.sourceTable),
    amount: e.currency ? c.money(e.debitMinor, e.currency) : "",
    state: { state: iconState(e.state), label: c.state("journal", e.state) },
  }));

  const peek = query.peek ? entries.data.find((e) => e.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const ledger = await listTransitions(db, "journal_state_transitions", peek.id);
    const allowed = NEXT_STATES.journal[peek.state].filter((n) =>
      n === "Posted" ? canPost && peek.preparedBy !== me : canWrite,
    );
    const cur = peek.currency ?? "USD";
    detail = {
      kindLabel: t("finance.journal.kind"),
      recordKey: c.date(peek.entryDate),
      title: peek.memo,
      state: iconState(peek.state),
      stateLabel: c.state("journal", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.journal.debits"), value: c.money(peek.debitMinor, cur) },
        { label: t("finance.journal.credits"), value: c.money(peek.creditMinor, cur) },
        {
          label: t("finance.journal.fields.period"),
          value: (() => {
            const p = periods.data.find((x) => x.id === peek.periodId);
            return p ? `${c.date(p.startsOn)} · ${c.state("accounting_period", p.state)}` : "";
          })(),
        },
        { label: t("finance.journal.source"), value: sourceLabel(peek.sourceTable) },
        {
          label: t("finance.common.project"),
          value: peek.projectId ? (projectKey.get(peek.projectId) ?? "") : t("finance.common.none"),
        },
      ],
      content: (
        <>
          <TransitionBar
            org={ctx.org.slug}
            lifecycle="journal"
            id={peek.id}
            state={peek.state}
            allowed={allowed}
          />
          {peek.preparedBy === me && peek.state === "Proposed" ? (
            <p className="m-0 text-text-12 text-text-secondary">{t("finance.journal.ownEntry")}</p>
          ) : null}
          <Section id="journal-lines" title={t("finance.journal.fields.lines")}>
            <SimpleTable
              caption={t("finance.journal.fields.lines")}
              head={[
                t("finance.budgets.columns.account"),
                t("finance.budgets.columns.costCenter"),
                t("finance.budgets.columns.urid"),
                t("finance.common.description"),
                t("finance.journal.fields.debit"),
                t("finance.journal.fields.credit"),
              ]}
              numeric={[4, 5]}
              rows={peek.lines.map((l) => [
                `${accountName.get(l.accountCode) ?? ""} · ${l.accountCode}`,
                l.costCenterId ? (centerCode.get(l.costCenterId) ?? "") : "",
                l.urid ?? "",
                l.description,
                l.debitMinor ? c.money(l.debitMinor, l.currency) : "",
                l.creditMinor ? c.money(l.creditMinor, l.currency) : "",
              ])}
              foot={[
                t("finance.common.total"),
                "",
                "",
                "",
                c.money(peek.debitMinor, cur),
                c.money(peek.creditMinor, cur),
              ]}
            />
          </Section>
          <RecordActivity
            ctx={ctx}
            transitions={ledger.ok ? ledger.data : []}
            stateLabel={(s) => c.state("journal", s)}
            t={t}
            format={c.dateTime}
          />
          <RecordCollab ctx={ctx} table="app.journal_entries" id={peek.id} canUpload={canWrite} />
        </>
      ),
    };
  }

  const postable = periods.data.filter((p) => ["Open", "In Period", "Closing"].includes(p.state));
  return (
    <FinanceCollection
      {...base}
      canCreate={canWrite}
      count={shown.length}
      states={JOURNAL_STATES.map((s) => ({ value: s, label: c.state("journal", s) }))}
      columns={[
        { key: "date", label: t("finance.journal.fields.entryDate") },
        { key: "memo", label: t("finance.journal.fields.memo"), wrap: true },
        { key: "project", label: t("finance.common.project"), type: "code" },
        { key: "source", label: t("finance.journal.source") },
        { key: "amount", label: t("finance.common.amount"), type: "number" },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={rows}
      detail={detail}
      sheet={
        query.create && canWrite ? (
          <FormSheet title={t("finance.journal.create")} flag="create">
            <JournalForm
              org={ctx.org.slug}
              periods={postable.map((p) => ({
                value: p.id,
                label: t("finance.periods.range", {
                  from: c.date(p.startsOn),
                  to: c.date(p.endsOn),
                }),
              }))}
              projects={page.projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
              projectId={page.project?.id ?? null}
              accounts={accounts.data.map((a) => ({
                value: a.code,
                label: `${a.code} · ${a.name}`,
              }))}
              costCenters={centers.data.map((cc) => ({
                value: cc.id,
                label: `${cc.code} · ${cc.name}`,
              }))}
              currencies={[...c.exponents.keys()].sort()}
              defaultCurrency="USD"
              today={new Date().toISOString().slice(0, 10)}
            />
          </FormSheet>
        ) : null
      }
    />
  );
}

/** The day after a period ends and the last day of that month, for the next period's defaults. */
function nextPeriod(periods: readonly AccountingPeriod[]): { startsOn: string; endsOn: string } {
  const latest = periods
    .map((p) => p.endsOn)
    .sort()
    .at(-1);
  const start = latest
    ? new Date(`${latest}T00:00:00Z`)
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0));
  start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) };
}

export async function PeriodsView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.periods").node.label);
  const empty = {
    icon: "CalendarRange",
    sentence: t("finance.periods.empty"),
    actionLabel: t("finance.periods.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.periods.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.journal.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.journal.read" />;
  }
  const db = ctx.viewer.db;
  const [periods, entries] = await Promise.all([
    listPeriods(db, ctx.org.id),
    listJournalEntries(db, { orgId: ctx.org.id }),
  ]);
  if (!periods.ok || !entries.ok) {
    return <FinanceCollection {...base} canCreate={false} error={t("finance.periods.loadError")} />;
  }
  const canManage = access.can("finance.period.manage");
  const canClose = access.can("finance.period.close");
  const shown = periods.data.filter((p) => !query.state || p.state === query.state);
  const counts = (id: string) => {
    const mine = entries.data.filter((e) => e.periodId === id);
    return {
      posted: mine.filter((e) => e.state === "Posted").length,
      prepared: mine.filter((e) => e.state === "Proposed").length,
    };
  };
  const label = (p: AccountingPeriod) =>
    t("finance.periods.range", { from: c.date(p.startsOn), to: c.date(p.endsOn) });
  const rows: Row[] = shown.map((p) => ({
    id: p.id,
    period: label(p),
    posted: counts(p.id).posted,
    prepared: counts(p.id).prepared,
    accepts: ["Closed", "Audited", "Archived"].includes(p.state)
      ? t("finance.periods.refuses")
      : t("finance.periods.accepts"),
    state: { state: iconState(p.state), label: c.state("accounting_period", p.state) },
  }));

  const peek = query.peek ? periods.data.find((p) => p.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const ledger = await listTransitions(db, "accounting_period_state_transitions", peek.id);
    const allowed = NEXT_STATES.accounting_period[peek.state].filter((n) =>
      ["Closed", "Audited", "Archived"].includes(n) ? canClose : canManage,
    );
    const n = counts(peek.id);
    detail = {
      kindLabel: t("finance.periods.kind"),
      recordKey: peek.startsOn.slice(0, 7),
      title: label(peek),
      state: iconState(peek.state),
      stateLabel: c.state("accounting_period", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.periods.fields.startsOn"), value: c.date(peek.startsOn) },
        { label: t("finance.periods.fields.endsOn"), value: c.date(peek.endsOn) },
        { label: t("finance.periods.postedEntries"), value: String(n.posted) },
        { label: t("finance.periods.preparedEntries"), value: String(n.prepared) },
        {
          label: t("finance.periods.postings"),
          value: ["Closed", "Audited", "Archived"].includes(peek.state)
            ? t("finance.periods.refuses")
            : t("finance.periods.accepts"),
        },
      ],
      content: (
        <>
          <TransitionBar
            org={ctx.org.slug}
            lifecycle="accounting_period"
            id={peek.id}
            state={peek.state}
            allowed={allowed}
          />
          {peek.state === "Closing" && n.prepared > 0 ? (
            <p className="m-0 text-text-12 text-warning-text">
              {t("finance.periods.preparedBlockClose", { count: n.prepared })}
            </p>
          ) : null}
          <RecordActivity
            ctx={ctx}
            transitions={ledger.ok ? ledger.data : []}
            stateLabel={(s) => c.state("accounting_period", s)}
            t={t}
            format={c.dateTime}
          />
          <RecordCollab
            ctx={ctx}
            table="app.accounting_periods"
            id={peek.id}
            canUpload={canManage}
          />
        </>
      ),
    };
  }

  const defaults = nextPeriod(periods.data);
  return (
    <FinanceCollection
      {...base}
      canCreate={canManage}
      count={shown.length}
      states={PERIOD_STATES.map((s) => ({ value: s, label: c.state("accounting_period", s) }))}
      columns={[
        { key: "period", label: t("finance.periods.period"), wrap: true },
        { key: "posted", label: t("finance.periods.postedEntries"), type: "number" },
        { key: "prepared", label: t("finance.periods.preparedEntries"), type: "number" },
        { key: "accepts", label: t("finance.periods.postings") },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={rows}
      listItems={shown.map((p) => ({
        id: p.id,
        recordKey: p.startsOn.slice(0, 7),
        title: label(p),
        state: iconState(p.state),
        stateLabel: c.state("accounting_period", p.state),
      }))}
      detail={detail}
      sheet={
        query.create && canManage ? (
          <FormSheet title={t("finance.periods.create")} flag="create">
            <PeriodForm org={ctx.org.slug} startsOn={defaults.startsOn} endsOn={defaults.endsOn} />
          </FormSheet>
        ) : null
      }
    />
  );
}
