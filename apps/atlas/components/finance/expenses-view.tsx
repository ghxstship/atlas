import {
  EXPENSE_STATES,
  NEXT_STATES,
  listBudgetLineRefs,
  listCounterparties,
  listExpenses,
  listTransitions,
  type Expense,
} from "@xos/data/finance";
import { getNode } from "@xos/ia";
import type { FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { toInputValue, exponentOf } from "@/lib/finance/money";
import { iconState } from "@/lib/finance/states";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { FinanceCollection, type RecordDetail } from "./collection";
import { ExpenseForm } from "./forms-expense-form";
import { EditButton } from "./kit-edit-button";
import { FormSheet } from "./kit-form-sheet";
import { TransitionBar } from "./kit-transition-bar";
import { type Row } from "./kit.types";
import { RecordActivity, RecordCollab } from "./record";

/**
 * Finance > Expenses (Section 4.5.5): expenses as a table, list or board by state. One expense posts
 * to exactly one budget line (invariant 12). Approval runs spend authority and refuses the submitter
 * (Sections 8.1, 8.2), and an approved expense posts to the ledger in the period of its date
 * (invariant 13); every refusal names its rule.
 */
export async function ExpensesView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.expenses").node.label);
  const empty = {
    icon: "Receipt",
    sentence: page.project
      ? t("finance.expenses.emptyProject", { project: page.project.key })
      : t("finance.expenses.empty"),
    actionLabel: t("finance.expenses.create"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = {
    page,
    title,
    createLabel: t("finance.expenses.create"),
    columns: [],
    rows: [],
    count: 0,
    empty,
  };
  if (!access.can("finance.expense.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.expense.read" />;
  }
  const db = ctx.viewer.db;
  const [expenses, lines, counterparties] = await Promise.all([
    listExpenses(db, { orgId: ctx.org.id, projectId: page.project?.id ?? null }),
    listBudgetLineRefs(db, { orgId: ctx.org.id, projectId: page.project?.id ?? null }),
    listCounterparties(db, ctx.org.id),
  ]);
  if (!expenses.ok || !lines.ok || !counterparties.ok) {
    return (
      <FinanceCollection {...base} canCreate={false} error={t("finance.expenses.loadError")} />
    );
  }
  const canWrite = access.can("finance.expense.write");
  const canApprove = access.can("finance.expense.approve");
  const canPay = access.can("finance.payment.write");
  const me = ctx.viewer.person?.id ?? null;
  const projectKey = new Map(page.projects.map((p) => [p.id, p.key]));
  const vendorName = new Map(
    counterparties.data.map((v) => [v.id, v.name ?? t("finance.common.unnamedCounterparty")]),
  );
  const term = query.q?.toLowerCase() ?? null;
  const shown = expenses.data.filter(
    (e) =>
      (!query.state || e.state === query.state) &&
      (term === null ||
        e.description.toLowerCase().includes(term) ||
        (e.lineDescription ?? "").toLowerCase().includes(term)),
  );
  const keyOf = (e: Expense) =>
    `${projectKey.get(e.projectId ?? "") ?? ""} · ${c.date(e.incurredOn)}`;
  const rows: Row[] = shown.map((e) => ({
    id: e.id,
    project: projectKey.get(e.projectId ?? "") ?? "",
    incurred: c.date(e.incurredOn),
    description: e.description,
    line: e.lineDescription ?? "",
    vendor: e.counterpartyId ? (vendorName.get(e.counterpartyId) ?? "") : "",
    amount: c.money(e.amountMinor, e.currency),
    state: { state: iconState(e.state), label: c.state("expense", e.state) },
  }));

  const peek = query.peek ? expenses.data.find((e) => e.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const ledger = await listTransitions(db, "expense_state_transitions", peek.id);
    const allowed = NEXT_STATES.expense[peek.state].filter((next) =>
      next === "Approved" || next === "Rejected"
        ? canApprove && peek.submitterPersonId !== me
        : next === "Paid"
          ? canPay
          : canWrite || peek.submitterPersonId === me,
    );
    const editable = peek.state === "Proposed" && (canWrite || peek.submitterPersonId === me);
    detail = {
      kindLabel: t("finance.expenses.kind"),
      recordKey: keyOf(peek),
      title: peek.description,
      state: iconState(peek.state),
      stateLabel: c.state("expense", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.common.amount"), value: c.money(peek.amountMinor, peek.currency) },
        { label: t("finance.expenses.fields.incurredOn"), value: c.date(peek.incurredOn) },
        { label: t("finance.expenses.fields.budgetLine"), value: peek.lineDescription ?? "" },
        {
          label: t("finance.common.vendor"),
          value: peek.counterpartyId
            ? (vendorName.get(peek.counterpartyId) ?? "")
            : t("finance.common.none"),
        },
        { label: t("finance.common.project"), value: projectKey.get(peek.projectId ?? "") ?? "" },
      ],
      content: (
        <>
          <div className="flex flex-wrap gap-8">
            <TransitionBar
              org={ctx.org.slug}
              lifecycle="expense"
              id={peek.id}
              state={peek.state}
              allowed={allowed}
            />
            {editable ? <EditButton label={t("finance.common.edit")} /> : null}
          </div>
          {peek.submitterPersonId === me && peek.state === "Proposed" ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("finance.expenses.ownExpense")}
            </p>
          ) : null}
          <RecordActivity
            ctx={ctx}
            transitions={ledger.ok ? ledger.data : []}
            stateLabel={(s) => c.state("expense", s)}
            t={t}
            format={c.dateTime}
          />
          <RecordCollab ctx={ctx} table="app.expenses" id={peek.id} canUpload={editable} />
        </>
      ),
    };
  }

  const lineOptions = lines.data.map((l) => ({
    value: l.id,
    label: `${projectKey.get(l.projectId) ?? ""} · ${l.budgetName} · ${l.lineNumber} ${l.description}`,
    currency: l.currency,
  }));
  const vendors = counterparties.data.map((v) => ({
    value: v.id,
    label: v.name ?? t("finance.common.unnamedCounterparty"),
  }));
  const today = await orgToday(ctx);
  const sheet =
    query.create && canWrite ? (
      <FormSheet title={t("finance.expenses.create")} flag="create">
        <ExpenseForm
          org={ctx.org.slug}
          lines={lineOptions}
          counterparties={vendors}
          today={today}
        />
      </FormSheet>
    ) : query.edit && peek && peek.state === "Proposed" ? (
      <FormSheet title={t("finance.expenses.edit")} flag="edit">
        <ExpenseForm
          org={ctx.org.slug}
          lines={lineOptions}
          counterparties={vendors}
          today={today}
          expense={{
            id: peek.id,
            budgetLineId: peek.budgetLineId,
            counterpartyId: peek.counterpartyId,
            description: peek.description,
            incurredOn: peek.incurredOn,
            amount: toInputValue(peek.amountMinor, exponentOf(c.exponents, peek.currency)),
            currency: peek.currency,
          }}
        />
      </FormSheet>
    ) : null;

  return (
    <FinanceCollection
      {...base}
      canCreate={canWrite}
      count={shown.length}
      states={EXPENSE_STATES.map((s) => ({ value: s, label: c.state("expense", s) }))}
      columns={[
        { key: "project", label: t("finance.common.project"), type: "code" },
        { key: "incurred", label: t("finance.expenses.fields.incurredOn") },
        { key: "description", label: t("finance.common.description"), wrap: true },
        { key: "line", label: t("finance.expenses.fields.budgetLine"), wrap: true },
        { key: "vendor", label: t("finance.common.vendor") },
        { key: "amount", label: t("finance.common.amount"), type: "number" },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={rows}
      listItems={shown.map((e) => ({
        id: e.id,
        recordKey: keyOf(e),
        title: e.description,
        state: iconState(e.state),
        stateLabel: c.state("expense", e.state),
        next: c.money(e.amountMinor, e.currency),
      }))}
      board={EXPENSE_STATES.map((s) => ({
        state: iconState(s),
        label: c.state("expense", s),
        cards: shown
          .filter((e) => e.state === s)
          .map((e) => ({
            key: e.id,
            title: e.description,
            meta: c.money(e.amountMinor, e.currency),
          })),
      }))}
      detail={detail}
      sheet={sheet}
    />
  );
}
