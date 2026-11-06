import { todayIn } from "@xos/data/calendar";
import {
  EXPENSE_STATES,
  NEXT_STATES,
  listBudgetLineRefs,
  listCounterparties,
  listExpenseDuplicates,
  listExpenses,
  listTransitions,
  type Expense,
} from "@xos/data/finance";
import { getProjectTimeZone } from "@xos/data/procurement";
import { listEngagementRefs } from "@xos/data/settlements";
import { getNode } from "@xos/ia";
import type { Route } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui";
import { expenseAsk } from "@/lib/aurora/finance-ask";
import type { FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { toInputValue, exponentOf } from "@/lib/finance/money";
import { iconState } from "@/lib/finance/states";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { FinanceCollection, type RecordDetail } from "./collection";
import { Section, SimpleTable } from "./figures";
import { ExpenseCreditForm } from "./forms-expense-credit-form";
import { ExpenseForm } from "./forms-expense-form";
import { RefundReceivedButton } from "./forms-refund-received-button";
import { EditButton } from "./kit-edit-button";
import { FormSheet } from "./kit-form-sheet";
import { TransitionBar } from "./kit-transition-bar";
import { type Row } from "./kit.types";
import { InlineAlert } from "./payables-ui";
import { RecordActivity, RecordCollab } from "./record";

/**
 * Finance > Expenses (Section 4.5.5): expenses as a table, list or board by state. One expense posts
 * to exactly one budget line (invariant 12). Approval runs spend authority and refuses the submitter
 * (Sections 8.1, 8.2), and an approved expense posts to the ledger in the period of its date
 * (invariant 13); every refusal names its rule. A credit is a refund against an approved charge, shown negative. A
 * reimbursable charge is paid by recording its reimbursement on Finance > Payments, never here (B12).
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
  const isCredit = (e: Expense) => e.creditOfExpenseId !== null;
  // A credit's amount stays positive in the database; here it reads as what it takes back.
  const signedAmount = (e: Expense) =>
    c.money(isCredit(e) ? -e.amountMinor : e.amountMinor, e.currency);
  const reimbursementLabel = (e: Expense) => {
    const status = e.isReimbursable ? (e.balance?.reimbursementStatus ?? null) : null;
    return status ? t(`finance.expenses.status.${status.replace(/\s+/g, "")}`) : "";
  };
  const rows: Row[] = shown.map((e) => ({
    id: e.id,
    project: projectKey.get(e.projectId ?? "") ?? "",
    incurred: c.date(e.incurredOn),
    credit: isCredit(e) ? { state: "in-review", label: t("finance.expenses.credit") } : null,
    description: e.description,
    line: e.lineDescription ?? "",
    vendor: e.counterpartyId ? (vendorName.get(e.counterpartyId) ?? "") : "",
    amount: signedAmount(e),
    reimbursement: reimbursementLabel(e),
    state: { state: iconState(e.state), label: c.state("expense", e.state) },
  }));

  const peek = query.peek ? expenses.data.find((e) => e.id === query.peek) : undefined;
  let detail: RecordDetail | null = null;
  if (peek) {
    const checksLookAlikes =
      !isCredit(peek) && (peek.state === "Proposed" || peek.state === "Approved");
    const [ledger, lookAlikes] = await Promise.all([
      listTransitions(db, "expense_state_transitions", peek.id),
      checksLookAlikes ? listExpenseDuplicates(db, [peek.id]) : null,
    ]);
    const candidates = lookAlikes?.ok ? (lookAlikes.data.get(peek.id) ?? []) : [];
    const byId = new Map(expenses.data.map((e) => [e.id, e]));
    const original = peek.creditOfExpenseId ? byId.get(peek.creditOfExpenseId) : undefined;
    const credits = expenses.data.filter((e) => e.creditOfExpenseId === peek.id);
    // A reimbursable charge is paid by recording its reimbursement, and a credit's Paid has its own label.
    const allowed = NEXT_STATES.expense[peek.state].filter((next) =>
      next === "Approved" || next === "Rejected"
        ? canApprove && peek.submitterPersonId !== me
        : next === "Paid"
          ? canPay && !peek.isReimbursable && !isCredit(peek)
          : canWrite || peek.submitterPersonId === me,
    );
    const canRefund = isCredit(peek) && peek.state === "Approved" && canPay;
    const editable = peek.state === "Proposed" && (canWrite || peek.submitterPersonId === me);
    const canRecordCredit =
      !isCredit(peek) &&
      canWrite &&
      (canApprove || canPay) &&
      (peek.state === "Approved" || peek.state === "Paid") &&
      (peek.balance?.creditableMinor ?? 0) > 0 &&
      peek.reimbursementId === null;
    const reimbursementsHref = `/${ctx.org.slug}/finance/payments?tab=reimbursements&payee=${peek.submitterPersonId ?? ""}`;
    detail = {
      kindLabel: t("finance.expenses.kind"),
      recordKey: keyOf(peek),
      title: peek.description,
      state: iconState(peek.state),
      stateLabel: c.state("expense", peek.state),
      propertiesLabel: t("finance.common.properties"),
      properties: [
        { label: t("finance.common.amount"), value: signedAmount(peek) },
        ...(!isCredit(peek) && peek.balance && !peek.balance.withheld
          ? [
              {
                label: t("finance.expenses.credited"),
                value: c.money(peek.balance.creditedMinor, peek.currency),
              },
              {
                label: t("finance.expenses.pendingCredits"),
                value: c.money(peek.balance.pendingCreditMinor, peek.currency),
              },
              {
                label: t("finance.expenses.net"),
                value: c.money(peek.balance.netMinor, peek.currency),
              },
            ]
          : []),
        ...(peek.isReimbursable
          ? [{ label: t("finance.expenses.reimbursement"), value: reimbursementLabel(peek) }]
          : []),
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
          {candidates.length > 0 ? (
            <InlineAlert tone="warning" title={t("finance.expenses.duplicate.title")}>
              <span className="flex flex-col gap-4">
                <span>{t("finance.expenses.duplicate.body", { count: candidates.length })}</span>
                <span className="flex flex-wrap gap-8">
                  {candidates.map((d) => (
                    <Link
                      key={d.candidateId}
                      href={`/${ctx.org.slug}/finance/expenses?peek=${d.candidateId}` as Route}
                      className="text-accent-text underline"
                    >
                      {byId.get(d.candidateId)?.description ?? t("finance.expenses.duplicate.open")}
                    </Link>
                  ))}
                </span>
              </span>
            </InlineAlert>
          ) : null}
          <div className="flex flex-wrap gap-8">
            <TransitionBar
              org={ctx.org.slug}
              lifecycle="expense"
              id={peek.id}
              state={peek.state}
              allowed={allowed}
            />
            {canRefund ? <RefundReceivedButton org={ctx.org.slug} id={peek.id} /> : null}
            {editable ? <EditButton label={t("finance.common.edit")} /> : null}
            {canRecordCredit ? (
              <ButtonLink
                href={`/${ctx.org.slug}/finance/expenses?peek=${peek.id}&recordCredit=1`}
                variant="secondary"
              >
                {t("finance.expenses.recordCredit")}
              </ButtonLink>
            ) : null}
            {peek.isReimbursable && peek.state === "Approved" ? (
              <ButtonLink href={reimbursementsHref} variant="ghost">
                {t("finance.expenses.openReimbursements")}
              </ButtonLink>
            ) : null}
          </div>
          {original ? (
            <p className="m-0 text-text-13">
              <Link
                href={`/${ctx.org.slug}/finance/expenses?peek=${original.id}` as Route}
                className="text-accent-text underline"
              >
                {t("finance.expenses.openOriginal", { description: original.description })}
              </Link>
            </p>
          ) : null}
          {credits.length > 0 ? (
            <Section id="expense-credits" title={t("finance.expenses.credits")}>
              <SimpleTable
                caption={t("finance.expenses.credits")}
                head={[
                  t("finance.expenses.fields.incurredOn"),
                  t("finance.common.description"),
                  t("finance.common.amount"),
                  t("finance.common.state"),
                ]}
                numeric={[2]}
                rows={credits.map((e) => [
                  c.date(e.incurredOn),
                  <Link
                    key={e.id}
                    href={`/${ctx.org.slug}/finance/expenses?peek=${e.id}` as Route}
                    className="text-accent-text underline"
                  >
                    {e.description}
                  </Link>,
                  signedAmount(e),
                  c.state("expense", e.state),
                ])}
              />
            </Section>
          ) : null}
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
    projectId: l.projectId,
  }));
  const vendors = counterparties.data.map((v) => ({
    value: v.id,
    label: v.name ?? t("finance.common.unnamedCounterparty"),
  }));
  const today = await orgToday(ctx);
  const editingCharge = query.edit && peek && peek.state === "Proposed" && !isCredit(peek);
  // Engagements load only while a form that lists them is open. The guard refuses a Canceled one.
  const engagements =
    (query.create && canWrite) || editingCharge
      ? await listEngagementRefs(db, { orgId: ctx.org.id, projectId: page.project?.id ?? null })
      : null;
  const acts = (engagements?.ok ? engagements.data : [])
    .filter((e) => e.state !== "Canceled")
    .map((e) => ({
      value: e.id,
      projectId: e.projectId,
      label:
        (e.counterpartyId && vendorName.get(e.counterpartyId)) ||
        e.personName ||
        t("finance.invoices.individual"),
    }));
  const projectDay = async (e: Expense) =>
    e.projectId ? todayIn(await getProjectTimeZone(db, e.projectId)) : today;
  const sheet =
    query.create && canWrite ? (
      <FormSheet title={t("finance.expenses.create")} flag="create">
        <ExpenseForm
          org={ctx.org.slug}
          lines={lineOptions}
          counterparties={vendors}
          acts={acts}
          today={today}
        />
      </FormSheet>
    ) : query.extra["recordCredit"] && peek && !isCredit(peek) ? (
      <FormSheet title={t("finance.expenses.recordCredit")} flag="recordCredit">
        <ExpenseCreditForm
          org={ctx.org.slug}
          originalId={peek.id}
          currency={peek.currency}
          amount={toInputValue(
            peek.balance?.creditableMinor ?? peek.amountMinor,
            exponentOf(c.exponents, peek.currency),
          )}
          incurredOn={await projectDay(peek)}
          description={peek.description}
        />
      </FormSheet>
    ) : query.edit && peek && peek.state === "Proposed" && isCredit(peek) ? (
      <FormSheet title={t("finance.expenses.edit")} flag="edit">
        <ExpenseCreditForm
          org={ctx.org.slug}
          originalId={peek.creditOfExpenseId ?? ""}
          creditId={peek.id}
          currency={peek.currency}
          amount={toInputValue(peek.amountMinor, exponentOf(c.exponents, peek.currency))}
          incurredOn={peek.incurredOn}
          description={peek.description}
        />
      </FormSheet>
    ) : editingCharge ? (
      <FormSheet title={t("finance.expenses.edit")} flag="edit">
        <ExpenseForm
          org={ctx.org.slug}
          lines={lineOptions}
          counterparties={vendors}
          acts={acts}
          today={today}
          expense={{
            id: peek.id,
            budgetLineId: peek.budgetLineId,
            counterpartyId: peek.counterpartyId,
            description: peek.description,
            incurredOn: peek.incurredOn,
            amount: toInputValue(peek.amountMinor, exponentOf(c.exponents, peek.currency)),
            currency: peek.currency,
            isReimbursable: peek.isReimbursable,
            engagementId: peek.engagementId,
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
        { key: "credit", label: t("finance.expenses.credit"), type: "state" },
        { key: "description", label: t("finance.common.description"), wrap: true },
        { key: "line", label: t("finance.expenses.fields.budgetLine"), wrap: true },
        { key: "vendor", label: t("finance.common.vendor") },
        { key: "amount", label: t("finance.common.amount"), type: "number" },
        { key: "reimbursement", label: t("finance.expenses.reimbursement") },
        { key: "state", label: t("finance.common.state"), type: "state" },
      ]}
      rows={rows}
      listItems={shown.map((e) => ({
        id: e.id,
        recordKey: keyOf(e),
        title: isCredit(e)
          ? t("finance.expenses.creditTitle", { description: e.description })
          : e.description,
        state: iconState(e.state),
        stateLabel: c.state("expense", e.state),
        next: signedAmount(e),
      }))}
      board={EXPENSE_STATES.map((s) => ({
        state: iconState(s),
        label: c.state("expense", s),
        cards: shown
          .filter((e) => e.state === s)
          .map((e) => ({
            key: e.id,
            title: isCredit(e)
              ? t("finance.expenses.creditTitle", { description: e.description })
              : e.description,
            meta: signedAmount(e),
          })),
      }))}
      detail={detail}
      sheet={sheet}
      ask={expenseAsk(page, c)}
    />
  );
}
