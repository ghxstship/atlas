import {
  CHANGE_ORDER_STATES,
  NEXT_STATES,
  listBudgetLineRefs,
  listBudgets,
  listChangeOrderLines,
  listChangeOrders,
  listOrderTypes,
  listTransitions,
  listUridOptions,
  type ChangeOrder,
} from "@xos/data/finance";
import { getNode } from "@xos/ia";
import type { FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { iconState } from "@/lib/finance/states";
import { sitemap } from "@/lib/shell/sitemap";
import { saveChangeOrderLineAction } from "@/app/[org]/finance/actions";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Section, SimpleTable } from "./figures";
import { ChangeOrderForm, ChangeOrderLineForm } from "./forms";
import { EditButton, FormSheet, InlineActionButton, TransitionBar, type Row } from "./kit";
import { RecordActivity, RecordCollab } from "./record";

/**
 * Finance > Change orders (Section 4.5.5, journey 6): a change order raised without a price is stored
 * unpriced, never at zero, and totals Unpriced with its unpriced count; once every line is priced (or
 * declared no-cost) it is priced, then approved under spend authority by someone other than its
 * requester, and the budget's revised total includes it.
 */
export async function ChangeOrdersView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.change-orders").node.label);
  const empty = {
    icon: "FilePlus2",
    sentence: page.project
      ? t("finance.changeOrders.emptyProject", { project: page.project.key })
      : t("finance.changeOrders.empty"),
    actionLabel: t("finance.changeOrders.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.changeOrders.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.change_order.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.change_order.read" />;
  }
  const db = ctx.viewer.db;
  const scope = { orgId: ctx.org.id, projectId: page.project?.id ?? null };
  const [orders, budgets, orderTypes] = await Promise.all([
    listChangeOrders(db, scope),
    listBudgets(db, scope),
    listOrderTypes(db),
  ]);
  if (!orders.ok || !budgets.ok || !orderTypes.ok) {
    return (
      <FinanceCollection {...base} canCreate={false} error={t("finance.changeOrders.loadError")} />
    );
  }
  const canWrite = access.can("finance.change_order.write");
  const canPrice = access.can("finance.change_order.price");
  const canApprove = access.can("finance.change_order.approve");
  const me = ctx.viewer.person?.id ?? null;
  const projectKey = new Map(page.projects.map((p) => [p.id, p.key]));
  const budgetOf = new Map(budgets.data.map((b) => [b.id, b]));
  const typeLabel = new Map(orderTypes.data.map((o) => [o.id, o.label]));
  const keyOf = (o: ChangeOrder) => `${projectKey.get(o.projectId) ?? ""}-CO${o.number}`;
  const totalOf = (o: ChangeOrder) =>
    c.money(o.totalMinor, budgetOf.get(o.budgetId)?.currency ?? "USD");
  const term = query.q?.toLowerCase() ?? null;
  const shown = orders.data.filter(
    (o) =>
      (!query.state || o.state === query.state) &&
      (term === null ||
        o.title.toLowerCase().includes(term) ||
        keyOf(o).toLowerCase().includes(term)),
  );
  const rows: Row[] = shown.map((o) => ({
    id: o.id,
    key: keyOf(o),
    title: o.title,
    budget: budgetOf.get(o.budgetId)?.name ?? "",
    type: o.orderTypeId ? (typeLabel.get(o.orderTypeId) ?? "") : "",
    lines: o.lineCount,
    unpriced: o.unpricedCount,
    total: totalOf(o),
    state: { state: iconState(o.state), label: c.state("change_order", o.state) },
  }));

  const peek = query.peek ? orders.data.find((o) => o.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const budget = budgetOf.get(peek.budgetId);
    const currency = budget?.currency ?? "USD";
    const [lines, ledger, urids, budgetLines] = await Promise.all([
      listChangeOrderLines(db, peek.id),
      listTransitions(db, "change_order_state_transitions", peek.id),
      listUridOptions(db),
      listBudgetLineRefs(db, { orgId: ctx.org.id, projectId: peek.projectId }),
    ]);
    const editable = peek.state === "Proposed" && canWrite;
    const own = peek.requestedBy === me;
    const allowed = NEXT_STATES.change_order[peek.state].filter((next) =>
      next === "Priced"
        ? canPrice
        : next === "Approved" || next === "Rejected"
          ? canApprove && !own
          : canWrite,
    );
    detail = {
      kindLabel: t("finance.changeOrders.kind"),
      recordKey: keyOf(peek),
      title: peek.title,
      state: iconState(peek.state),
      stateLabel: c.state("change_order", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        {
          label: t("finance.common.total"),
          value:
            peek.unpricedCount > 0
              ? t("finance.changeOrders.unpricedTotal", { count: peek.unpricedCount })
              : totalOf(peek),
        },
        { label: t("finance.changeOrders.fields.budget"), value: budget?.name ?? "" },
        {
          label: t("finance.changeOrders.fields.orderType"),
          value: peek.orderTypeId
            ? (typeLabel.get(peek.orderTypeId) ?? "")
            : t("finance.common.none"),
        },
        {
          label: t("finance.changeOrders.fields.reason"),
          value: peek.reason ?? t("finance.common.none"),
        },
        { label: t("finance.common.project"), value: projectKey.get(peek.projectId) ?? "" },
      ],
      content: (
        <>
          <div className="flex flex-wrap gap-8">
            <TransitionBar
              org={ctx.org.slug}
              lifecycle="change_order"
              id={peek.id}
              state={peek.state}
              allowed={allowed}
            />
            {editable ? <EditButton label={t("finance.common.edit")} /> : null}
          </div>
          {own && peek.state === "Priced" ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("finance.changeOrders.ownOrder")}
            </p>
          ) : null}
          <Section id="co-lines" title={t("finance.changeOrders.lines")}>
            {lines.ok && lines.data.length > 0 ? (
              <SimpleTable
                caption={t("finance.changeOrders.lines")}
                head={[
                  t("finance.common.description"),
                  t("finance.budgets.columns.urid"),
                  t("finance.budgets.columns.quantity"),
                  t("finance.budgets.columns.unitPrice"),
                  t("finance.budgets.columns.extended"),
                  ...(editable ? [t("finance.common.actions")] : []),
                ]}
                numeric={[2, 3, 4]}
                rows={lines.data.map((l) => [
                  l.description,
                  <span key="u" className="font-mono text-text-12">
                    {l.urid}
                  </span>,
                  c.number(l.quantity),
                  l.isNoCost
                    ? t("finance.changeOrders.noCost")
                    : c.money(l.unitPriceMinor, currency),
                  c.money(l.extendedMinor, currency),
                  ...(editable
                    ? [
                        <InlineActionButton
                          key="d"
                          action={saveChangeOrderLineAction}
                          fields={{ org: ctx.org.slug, id: l.id, delete: "1" }}
                          label={t("finance.common.remove")}
                          icon="Trash2"
                        />,
                      ]
                    : []),
                ])}
                foot={[
                  t("finance.common.total"),
                  "",
                  "",
                  "",
                  totalOf(peek),
                  ...(editable ? [""] : []),
                ]}
              />
            ) : (
              <p className="m-0 text-text-13 text-text-secondary">
                {editable
                  ? t("finance.changeOrders.noLines")
                  : t("finance.changeOrders.noLinesRead")}
              </p>
            )}
            {editable && urids.ok && budgetLines.ok ? (
              <ChangeOrderLineForm
                org={ctx.org.slug}
                changeOrderId={peek.id}
                currency={currency}
                urids={urids.data.map((u) => ({ value: u.urid, label: `${u.name} · ${u.urid}` }))}
                budgetLines={budgetLines.data
                  .filter((l) => l.budgetId === peek.budgetId)
                  .map((l) => ({ value: l.id, label: `${l.lineNumber} · ${l.description}` }))}
              />
            ) : null}
          </Section>
          <RecordActivity
            ctx={ctx}
            transitions={ledger.ok ? ledger.data : []}
            stateLabel={(s) => c.state("change_order", s)}
            t={t}
            format={c.dateTime}
          />
          <RecordCollab ctx={ctx} table="app.change_orders" id={peek.id} canUpload={canWrite} />
        </>
      ),
    };
  }

  const budgetOptions = budgets.data.map((b) => ({
    value: b.id,
    label: `${b.projectKey ?? ""} · ${b.name}`,
    projectId: b.projectId,
  }));
  const typeOptions = orderTypes.data.map((o) => ({ value: o.id, label: o.label }));
  const sheet =
    query.create && canWrite ? (
      <FormSheet title={t("finance.changeOrders.create")} flag="create">
        <ChangeOrderForm org={ctx.org.slug} budgets={budgetOptions} orderTypes={typeOptions} />
      </FormSheet>
    ) : query.edit && peek && peek.state === "Proposed" && canWrite ? (
      <FormSheet title={t("finance.changeOrders.edit")} flag="edit">
        <ChangeOrderForm
          org={ctx.org.slug}
          budgets={budgetOptions}
          orderTypes={typeOptions}
          order={{
            id: peek.id,
            title: peek.title,
            orderTypeId: peek.orderTypeId,
            reason: peek.reason,
          }}
        />
      </FormSheet>
    ) : null;

  return (
    <FinanceCollection
      {...base}
      canCreate={canWrite}
      count={shown.length}
      states={CHANGE_ORDER_STATES.map((s) => ({ value: s, label: c.state("change_order", s) }))}
      columns={[
        { key: "key", label: t("finance.common.key"), type: "code" },
        { key: "title", label: t("finance.changeOrders.fields.title"), wrap: true },
        { key: "budget", label: t("finance.changeOrders.fields.budget") },
        { key: "type", label: t("finance.changeOrders.fields.orderType") },
        { key: "lines", label: t("finance.budgets.columns.lines"), type: "number" },
        { key: "unpriced", label: t("finance.budgets.columns.unpriced"), type: "number" },
        { key: "total", label: t("finance.common.total"), type: "number" },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={rows}
      listItems={shown.map((o) => ({
        id: o.id,
        recordKey: keyOf(o),
        title: o.title,
        state: iconState(o.state),
        stateLabel: c.state("change_order", o.state),
        next: totalOf(o),
      }))}
      board={CHANGE_ORDER_STATES.map((s) => ({
        state: iconState(s),
        label: c.state("change_order", s),
        cards: shown
          .filter((o) => o.state === s)
          .map((o) => ({ key: o.id, title: `${keyOf(o)} ${o.title}`, meta: totalOf(o) })),
      }))}
      detail={detail}
      sheet={sheet}
    />
  );
}
