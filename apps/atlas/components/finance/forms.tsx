"use client";

import { Button, Checkbox, Combobox, Input, Select, Textarea } from "@xos/ui";
import { useActionState, useEffect, useState } from "react";
import {
  applyPaymentAction,
  createFxRateAction,
  createJournalEntryAction,
  createPeriodAction,
  exportUplAction,
  saveBudgetAction,
  saveChangeOrderAction,
  saveChangeOrderLineAction,
  saveCostCenterAction,
  saveExpenseAction,
  saveInvoiceAction,
  saveInvoiceLineAction,
  savePaymentAction,
  saveSettlementAction,
  saveSettlementLineAction,
  selfBillAction,
  type ActionState,
} from "@/app/[org]/finance/actions";
import { ActionFeedback, fieldError, useAfterSave, useFinanceT, type Option } from "./kit";

/**
 * Create and edit forms for every finance document (A15). Each keeps typed input after a failed
 * submit, names the field at fault (Section 11.10 rule 11), and shows database refusals with their
 * rule. Money fields take major units; a blank price is unpriced and stays NULL (Section 3.7).
 * At most seven fields show before "More fields" (Section 11.10 cognitive load budget).
 */

const INITIAL: ActionState = {};

function Submit({ label, pending }: { label: string; pending: boolean }) {
  return (
    <div className="flex items-center gap-12">
      <Button type="submit" variant="primary" loading={pending}>
        {label}
      </Button>
    </div>
  );
}

// Budgets ------------------------------------------------------------------------------------------

export function BudgetForm({
  org,
  projects,
  projectId,
  currencies,
  defaultCurrency,
  budget,
}: {
  org: string;
  projects: readonly Option[];
  projectId: string | null;
  currencies: readonly string[];
  defaultCurrency: string;
  budget?: { id: string; name: string; isBaseline: boolean };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveBudgetAction, INITIAL);
  useAfterSave(state, budget ? "edit" : "create");
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      {budget ? <input type="hidden" name="id" value={budget.id} /> : null}
      {!budget ? (
        projectId ? (
          <input type="hidden" name="projectId" value={projectId} />
        ) : (
          <Select
            id="budget-project"
            name="projectId"
            label={t("common.project")}
            placeholder={t("common.chooseProject")}
            options={[...projects]}
            error={fieldError(t, state, "projectId")}
          />
        )
      ) : null}
      <Input
        id="budget-name"
        name="name"
        required
        width="100%"
        label={t("budgets.fields.name")}
        defaultValue={budget?.name ?? ""}
        error={fieldError(t, state, "name")}
      />
      {!budget ? (
        <Select
          id="budget-currency"
          name="currency"
          label={t("common.currency")}
          value={defaultCurrency}
          options={currencies.map((c) => ({ value: c, label: c }))}
          error={fieldError(t, state, "currency")}
        />
      ) : null}
      <Checkbox
        id="budget-baseline"
        name="isBaseline"
        label={t("budgets.fields.isBaseline")}
        defaultChecked={budget?.isBaseline ?? false}
      />
      <ActionFeedback state={state} />
      <Submit label={budget ? t("common.save") : t("budgets.create")} pending={pending} />
    </form>
  );
}

// Expenses -----------------------------------------------------------------------------------------

export interface LineOption extends Option {
  readonly currency: string;
}

export function ExpenseForm({
  org,
  lines,
  counterparties,
  today,
  expense,
}: {
  org: string;
  lines: readonly LineOption[];
  counterparties: readonly Option[];
  today: string;
  expense?: {
    id: string;
    budgetLineId: string;
    counterpartyId: string | null;
    description: string;
    incurredOn: string;
    amount: string;
    currency: string;
  };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveExpenseAction, INITIAL);
  useAfterSave(state, expense ? "edit" : "create");
  const [lineId, setLineId] = useState(expense?.budgetLineId ?? "");
  const currency = expense?.currency ?? lines.find((l) => l.value === lineId)?.currency ?? "";
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="currency" value={currency} />
      {expense ? <input type="hidden" name="id" value={expense.id} /> : null}
      {expense ? null : (
        <>
          <input type="hidden" name="budgetLineId" value={lineId} />
          <Combobox
            id="expense-line"
            label={t("expenses.fields.budgetLine")}
            help={fieldError(t, state, "budgetLineId") || t("expenses.fields.budgetLineHelp")}
            options={[...lines]}
            onChange={setLineId}
          />
        </>
      )}
      <Input
        id="expense-description"
        name="description"
        required
        width="100%"
        label={t("common.description")}
        defaultValue={expense?.description ?? ""}
        error={fieldError(t, state, "description")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="expense-amount"
          name="amount"
          inputMode="decimal"
          required
          label={currency ? t("common.amountIn", { currency }) : t("common.amount")}
          defaultValue={expense?.amount ?? ""}
          error={fieldError(t, state, "amount")}
        />
        <Input
          id="expense-date"
          name="incurredOn"
          type="date"
          required
          label={t("expenses.fields.incurredOn")}
          defaultValue={expense?.incurredOn ?? today}
          error={fieldError(t, state, "incurredOn")}
        />
      </div>
      <Select
        id="expense-vendor"
        name="counterpartyId"
        label={t("common.vendor")}
        value={expense?.counterpartyId ?? ""}
        options={[{ value: "", label: t("common.none") }, ...counterparties]}
      />
      <ActionFeedback state={state} />
      <Submit label={expense ? t("common.save") : t("expenses.create")} pending={pending} />
    </form>
  );
}

// Change orders ------------------------------------------------------------------------------------

export interface BudgetOption extends Option {
  readonly projectId: string;
}

export function ChangeOrderForm({
  org,
  budgets,
  orderTypes,
  order,
}: {
  org: string;
  budgets: readonly BudgetOption[];
  orderTypes: readonly Option[];
  order?: { id: string; title: string; orderTypeId: string | null; reason: string | null };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveChangeOrderAction, INITIAL);
  useAfterSave(state, order ? "edit" : "create");
  const [budgetId, setBudgetId] = useState(budgets.length === 1 ? (budgets[0]?.value ?? "") : "");
  const projectId = budgets.find((b) => b.value === budgetId)?.projectId ?? "";
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      {order ? (
        <input type="hidden" name="id" value={order.id} />
      ) : (
        <>
          <input type="hidden" name="projectId" value={projectId} />
          <Select
            id="co-budget"
            name="budgetId"
            label={t("changeOrders.fields.budget")}
            placeholder={t("changeOrders.fields.chooseBudget")}
            value={budgetId}
            options={[...budgets]}
            onChange={(e) => setBudgetId(e.target.value)}
            error={fieldError(t, state, "budgetId")}
          />
        </>
      )}
      <Input
        id="co-title"
        name="title"
        required
        width="100%"
        label={t("changeOrders.fields.title")}
        defaultValue={order?.title ?? ""}
        error={fieldError(t, state, "title")}
      />
      <Select
        id="co-type"
        name="orderTypeId"
        label={t("changeOrders.fields.orderType")}
        value={order?.orderTypeId ?? ""}
        options={[{ value: "", label: t("common.none") }, ...orderTypes]}
      />
      <Textarea
        id="co-reason"
        name="reason"
        width="100%"
        label={t("changeOrders.fields.reason")}
        defaultValue={order?.reason ?? ""}
        error={fieldError(t, state, "reason")}
      />
      <ActionFeedback state={state} />
      <Submit label={order ? t("common.save") : t("changeOrders.create")} pending={pending} />
    </form>
  );
}

export function ChangeOrderLineForm({
  org,
  changeOrderId,
  currency,
  urids,
  budgetLines,
}: {
  org: string;
  changeOrderId: string;
  currency: string;
  urids: readonly Option[];
  budgetLines: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveChangeOrderLineAction, INITIAL);
  const [urid, setUrid] = useState("");
  // A fresh form after each added line: the key changes with every successful submit.
  return (
    <form
      key={state.ok ? String(state.at) : "draft"}
      action={action}
      className="flex flex-col gap-12"
      noValidate
      aria-label={t("changeOrders.addLine")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="changeOrderId" value={changeOrderId} />
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="urid" value={urid} />
      <Input
        id="col-description"
        name="description"
        required
        width="100%"
        label={t("common.description")}
        error={fieldError(t, state, "description")}
      />
      <Combobox
        id="col-urid"
        label={t("budgets.columns.urid")}
        help={fieldError(t, state, "urid") || t("budgets.uridHelp")}
        options={[...urids]}
        onChange={setUrid}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="col-qty"
          name="quantity"
          inputMode="decimal"
          defaultValue="1"
          label={t("budgets.columns.quantity")}
          error={fieldError(t, state, "quantity")}
        />
        <Input
          id="col-price"
          name="unitPrice"
          inputMode="decimal"
          label={t("common.unitPriceIn", { currency })}
          help={t("common.blankIsUnpriced")}
          error={fieldError(t, state, "unitPrice")}
        />
      </div>
      <Checkbox id="col-nocost" name="isNoCost" label={t("changeOrders.fields.isNoCost")} />
      <Select
        id="col-line"
        name="budgetLineId"
        label={t("changeOrders.fields.budgetLine")}
        value=""
        options={[{ value: "", label: t("changeOrders.fields.newScope") }, ...budgetLines]}
      />
      <ActionFeedback state={state} />
      <Submit label={t("changeOrders.addLine")} pending={pending} />
    </form>
  );
}

// Invoices and payments ------------------------------------------------------------------------------

export function InvoiceForm({
  org,
  projects,
  projectId,
  counterparties,
  currencies,
  defaultCurrency,
  invoice,
}: {
  org: string;
  projects: readonly Option[];
  projectId: string | null;
  counterparties: readonly Option[];
  currencies: readonly string[];
  defaultCurrency: string;
  invoice?: { id: string; number: string | null; issuedOn: string | null; dueOn: string | null };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveInvoiceAction, INITIAL);
  useAfterSave(state, invoice ? "edit" : "create");
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      {invoice ? (
        <input type="hidden" name="id" value={invoice.id} />
      ) : (
        <>
          {projectId ? (
            <input type="hidden" name="projectId" value={projectId} />
          ) : (
            <Select
              id="invoice-project"
              name="projectId"
              label={t("common.project")}
              placeholder={t("common.chooseProject")}
              options={[...projects]}
              error={fieldError(t, state, "projectId")}
            />
          )}
          <Select
            id="invoice-direction"
            name="direction"
            label={t("invoices.fields.direction")}
            value="Payable"
            options={[
              { value: "Payable", label: t("invoices.direction.Payable") },
              { value: "Receivable", label: t("invoices.direction.Receivable") },
            ]}
          />
          <Select
            id="invoice-counterparty"
            name="counterpartyId"
            label={t("invoices.fields.counterparty")}
            placeholder={t("common.chooseCounterparty")}
            options={[...counterparties]}
            error={fieldError(t, state, "counterpartyId")}
          />
          <Select
            id="invoice-currency"
            name="currency"
            label={t("common.currency")}
            value={defaultCurrency}
            options={currencies.map((c) => ({ value: c, label: c }))}
          />
        </>
      )}
      <Input
        id="invoice-number"
        name="number"
        label={t("invoices.fields.number")}
        defaultValue={invoice?.number ?? ""}
        error={fieldError(t, state, "number")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="invoice-issued"
          name="issuedOn"
          type="date"
          label={t("invoices.fields.issuedOn")}
          defaultValue={invoice?.issuedOn ?? ""}
          error={fieldError(t, state, "issuedOn")}
        />
        <Input
          id="invoice-due"
          name="dueOn"
          type="date"
          label={t("invoices.fields.dueOn")}
          defaultValue={invoice?.dueOn ?? ""}
          error={fieldError(t, state, "dueOn")}
        />
      </div>
      <ActionFeedback state={state} />
      <Submit label={invoice ? t("common.save") : t("invoices.create")} pending={pending} />
    </form>
  );
}

export function InvoiceLineForm({
  org,
  invoiceId,
  currency,
  budgetLines,
}: {
  org: string;
  invoiceId: string;
  currency: string;
  budgetLines: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveInvoiceLineAction, INITIAL);
  return (
    <form
      key={state.ok ? String(state.at) : "draft"}
      action={action}
      className="flex flex-col gap-12"
      noValidate
      aria-label={t("invoices.addLine")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="currency" value={currency} />
      <Input
        id="il-description"
        name="description"
        required
        width="100%"
        label={t("common.description")}
        error={fieldError(t, state, "description")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="il-qty"
          name="quantity"
          inputMode="decimal"
          defaultValue="1"
          label={t("budgets.columns.quantity")}
          error={fieldError(t, state, "quantity")}
        />
        <Input
          id="il-price"
          name="unitPrice"
          inputMode="decimal"
          label={t("common.unitPriceIn", { currency })}
          help={t("common.blankIsUnpriced")}
          error={fieldError(t, state, "unitPrice")}
        />
      </div>
      <Select
        id="il-line"
        name="budgetLineId"
        label={t("invoices.fields.budgetLine")}
        value=""
        options={[{ value: "", label: t("common.none") }, ...budgetLines]}
      />
      <ActionFeedback state={state} />
      <Submit label={t("invoices.addLine")} pending={pending} />
    </form>
  );
}

export function PaymentForm({
  org,
  counterparties,
  currencies,
  defaultCurrency,
  today,
}: {
  org: string;
  counterparties: readonly Option[];
  currencies: readonly string[];
  defaultCurrency: string;
  today: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(savePaymentAction, INITIAL);
  useAfterSave(state, "create");
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      <Select
        id="payment-counterparty"
        name="counterpartyId"
        label={t("payments.fields.counterparty")}
        placeholder={t("common.chooseCounterparty")}
        options={[...counterparties]}
        error={fieldError(t, state, "counterpartyId")}
      />
      <Select
        id="payment-direction"
        name="direction"
        label={t("payments.fields.direction")}
        value="Payable"
        options={[
          { value: "Payable", label: t("payments.direction.Payable") },
          { value: "Receivable", label: t("payments.direction.Receivable") },
        ]}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="payment-amount"
          name="amount"
          inputMode="decimal"
          required
          label={t("common.amount")}
          error={fieldError(t, state, "amount")}
        />
        <Select
          id="payment-currency"
          name="currency"
          label={t("common.currency")}
          value={defaultCurrency}
          options={currencies.map((c) => ({ value: c, label: c }))}
        />
      </div>
      <Input
        id="payment-date"
        name="paidOn"
        type="date"
        required
        label={t("payments.fields.paidOn")}
        defaultValue={today}
        error={fieldError(t, state, "paidOn")}
      />
      <Input
        id="payment-reference"
        name="reference"
        label={t("payments.fields.reference")}
        error={fieldError(t, state, "reference")}
      />
      <ActionFeedback state={state} />
      <Submit label={t("payments.create")} pending={pending} />
    </form>
  );
}

export function ApplyPaymentForm({
  org,
  paymentId,
  currency,
  invoices,
}: {
  org: string;
  paymentId: string;
  currency: string;
  invoices: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(applyPaymentAction, INITIAL);
  return (
    <form
      action={action}
      className="flex flex-col gap-12"
      noValidate
      aria-label={t("payments.apply")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="currency" value={currency} />
      <Select
        id="apply-invoice"
        name="invoiceId"
        label={t("payments.fields.invoice")}
        placeholder={t("payments.fields.chooseInvoice")}
        options={[...invoices]}
        error={fieldError(t, state, "invoiceId")}
      />
      <Input
        id="apply-amount"
        name="amount"
        inputMode="decimal"
        required
        label={t("common.amountIn", { currency })}
        error={fieldError(t, state, "amount")}
      />
      <ActionFeedback state={state} success={t("payments.applied")} />
      <Submit label={t("payments.apply")} pending={pending} />
    </form>
  );
}

// Periods and journal ----------------------------------------------------------------------------------

export function PeriodForm({
  org,
  startsOn,
  endsOn,
}: {
  org: string;
  startsOn: string;
  endsOn: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(createPeriodAction, INITIAL);
  useAfterSave(state, "create");
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-wrap gap-12">
        <Input
          id="period-start"
          name="startsOn"
          type="date"
          required
          label={t("periods.fields.startsOn")}
          defaultValue={startsOn}
          error={fieldError(t, state, "startsOn")}
        />
        <Input
          id="period-end"
          name="endsOn"
          type="date"
          required
          label={t("periods.fields.endsOn")}
          defaultValue={endsOn}
          error={fieldError(t, state, "endsOn")}
        />
      </div>
      <ActionFeedback state={state} />
      <Submit label={t("periods.create")} pending={pending} />
    </form>
  );
}

interface DraftLine {
  key: number;
  accountCode: string;
  costCenterId: string;
  urid: string;
  description: string;
  debit: string;
  credit: string;
}

export function JournalForm({
  org,
  periods,
  projects,
  projectId,
  accounts,
  costCenters,
  currencies,
  defaultCurrency,
  today,
}: {
  org: string;
  periods: readonly Option[];
  projects: readonly Option[];
  projectId: string | null;
  accounts: readonly Option[];
  costCenters: readonly Option[];
  currencies: readonly string[];
  defaultCurrency: string;
  today: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(createJournalEntryAction, INITIAL);
  useAfterSave(state, "create");
  const blank = (key: number): DraftLine => ({
    key,
    accountCode: accounts[0]?.value ?? "",
    costCenterId: "",
    urid: "",
    description: "",
    debit: "",
    credit: "",
  });
  const [lines, setLines] = useState<DraftLine[]>([blank(1), blank(2)]);
  const set = (key: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const payload = JSON.stringify(
    lines.map((l) => ({
      accountCode: l.accountCode,
      costCenterId: l.costCenterId || null,
      urid: l.urid.trim() || null,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  );
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="lines" value={payload} />
      <Select
        id="journal-period"
        name="periodId"
        label={t("journal.fields.period")}
        placeholder={t("journal.fields.choosePeriod")}
        options={[...periods]}
        error={fieldError(t, state, "periodId")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="journal-date"
          name="entryDate"
          type="date"
          required
          label={t("journal.fields.entryDate")}
          defaultValue={today}
          error={fieldError(t, state, "entryDate")}
        />
        <Select
          id="journal-currency"
          name="currency"
          label={t("common.currency")}
          value={defaultCurrency}
          options={currencies.map((c) => ({ value: c, label: c }))}
        />
      </div>
      <Input
        id="journal-memo"
        name="memo"
        required
        width="100%"
        label={t("journal.fields.memo")}
        error={fieldError(t, state, "memo")}
      />
      {projectId ? (
        <input type="hidden" name="projectId" value={projectId} />
      ) : (
        <Select
          id="journal-project"
          name="projectId"
          label={t("common.project")}
          value=""
          options={[{ value: "", label: t("common.none") }, ...projects]}
        />
      )}
      <fieldset className="m-0 flex flex-col gap-12 border-0 p-0">
        <legend className="mb-8 text-label-13 font-semibold">{t("journal.fields.lines")}</legend>
        {lines.map((l, i) => (
          <div
            key={l.key}
            className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
          >
            <div className="flex flex-wrap gap-8">
              <Select
                id={`jl-account-${l.key}`}
                label={t("journal.fields.account", { n: i + 1 })}
                value={l.accountCode}
                options={[...accounts]}
                onChange={(e) => set(l.key, { accountCode: e.target.value })}
              />
              <Select
                id={`jl-cc-${l.key}`}
                label={t("budgets.columns.costCenter")}
                value=""
                options={[{ value: "", label: t("common.none") }, ...costCenters]}
                onChange={(e) => set(l.key, { costCenterId: e.target.value })}
              />
              <Input
                id={`jl-urid-${l.key}`}
                width={140}
                label={t("budgets.columns.urid")}
                value={l.urid}
                onChange={(e) => set(l.key, { urid: e.target.value })}
              />
            </div>
            <Input
              id={`jl-desc-${l.key}`}
              width="100%"
              label={t("common.description")}
              value={l.description}
              onChange={(e) => set(l.key, { description: e.target.value })}
            />
            <div className="flex flex-wrap items-end gap-8">
              <Input
                id={`jl-debit-${l.key}`}
                width={140}
                inputMode="decimal"
                label={t("journal.fields.debit")}
                value={l.debit}
                onChange={(e) => set(l.key, { debit: e.target.value })}
              />
              <Input
                id={`jl-credit-${l.key}`}
                width={140}
                inputMode="decimal"
                label={t("journal.fields.credit")}
                value={l.credit}
                onChange={(e) => set(l.key, { credit: e.target.value })}
              />
              {lines.length > 2 ? (
                <Button
                  variant="ghost"
                  icon="Trash2"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  {t("journal.removeLine")}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        <div>
          <Button
            icon="Plus"
            onClick={() => setLines((ls) => [...ls, blank(Math.max(...ls.map((x) => x.key)) + 1)])}
          >
            {t("journal.addLine")}
          </Button>
        </div>
        {state.fieldErrors?.["lines"] ? (
          <p role="alert" className="m-0 text-text-13 text-danger-text">
            {fieldError(t, state, "lines")}
          </p>
        ) : null}
      </fieldset>
      <ActionFeedback state={state} />
      <Submit label={t("journal.create")} pending={pending} />
    </form>
  );
}

// Cost centers, rates and the UPL export -----------------------------------------------------------------

export function CostCenterForm({
  org,
  scopeNodes,
  center,
}: {
  org: string;
  scopeNodes: readonly Option[];
  center?: { id: string; code: string; name: string; kind: string; scopeNodeId: string | null };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveCostCenterAction, INITIAL);
  useAfterSave(state, center ? "edit" : "create");
  const [kind, setKind] = useState(center?.kind ?? "Standing");
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      {center ? <input type="hidden" name="id" value={center.id} /> : null}
      <Input
        id="cc-code"
        name="code"
        required
        label={t("costCenters.fields.code")}
        help={t("costCenters.fields.codeHelp")}
        defaultValue={center?.code ?? "CC-"}
        error={fieldError(t, state, "code")}
      />
      <Input
        id="cc-name"
        name="name"
        required
        width="100%"
        label={t("costCenters.fields.name")}
        defaultValue={center?.name ?? ""}
        error={fieldError(t, state, "name")}
      />
      <Select
        id="cc-kind"
        name="kind"
        label={t("costCenters.fields.kind")}
        value={kind}
        options={["Standing", "Overhead", "Event"].map((k) => ({
          value: k,
          label: t(`costCenters.kinds.${k}`),
        }))}
        onChange={(e) => setKind(e.target.value)}
      />
      {kind === "Event" ? (
        <Select
          id="cc-scope"
          name="scopeNodeId"
          label={t("costCenters.fields.scopeNode")}
          placeholder={t("costCenters.fields.chooseScope")}
          value={center?.scopeNodeId ?? ""}
          options={[...scopeNodes]}
          error={fieldError(t, state, "scopeNodeId")}
        />
      ) : null}
      <ActionFeedback state={state} />
      <Submit label={center ? t("common.save") : t("costCenters.create")} pending={pending} />
    </form>
  );
}

export function FxRateForm({
  org,
  currencies,
  base,
  quote,
  today,
}: {
  org: string;
  currencies: readonly string[];
  base: string;
  quote: string;
  today: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(createFxRateAction, INITIAL);
  const options = currencies.map((c) => ({ value: c, label: c }));
  return (
    <form action={action} className="flex flex-col gap-12" noValidate aria-label={t("fx.add")}>
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-wrap gap-12">
        <Select
          id="fx-base"
          name="base"
          label={t("fx.fields.base")}
          value={base}
          options={options}
          error={fieldError(t, state, "base")}
        />
        <Select
          id="fx-quote"
          name="quote"
          label={t("fx.fields.quote")}
          value={quote}
          options={options}
          error={fieldError(t, state, "quote")}
        />
        <Input
          id="fx-rate"
          name="rate"
          inputMode="decimal"
          required
          label={t("fx.fields.rate")}
          error={fieldError(t, state, "rate")}
        />
      </div>
      <div className="flex flex-wrap gap-12">
        <Input
          id="fx-date"
          name="effectiveOn"
          type="date"
          required
          label={t("fx.fields.effectiveOn")}
          defaultValue={today}
          error={fieldError(t, state, "effectiveOn")}
        />
        <Input
          id="fx-source"
          name="source"
          required
          label={t("fx.fields.source")}
          error={fieldError(t, state, "source")}
        />
      </div>
      <ActionFeedback state={state} success={t("fx.added")} />
      <Submit label={t("fx.add")} pending={pending} />
    </form>
  );
}

/** Builds the export on the server and hands the browser the CSV file to save. */
export function UplExportForm({
  org,
  from,
  to,
  projectId,
  targets,
}: {
  org: string;
  from: string;
  to: string;
  projectId: string | null;
  targets: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(exportUplAction, INITIAL);
  useEffect(() => {
    if (!state.csv || !state.filename) return;
    const url = URL.createObjectURL(new Blob([state.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = state.filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [state.at, state.csv, state.filename]);
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-12"
      noValidate
      aria-label={t("upl.export")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
      <Select
        id="upl-target"
        name="target"
        label={t("upl.target")}
        value="upl"
        options={[{ value: "upl", label: t("upl.targets.upl") }, ...targets]}
        error={fieldError(t, state, "target")}
      />
      <Button type="submit" variant="primary" icon="Download" loading={pending}>
        {t("upl.export")}
      </Button>
      <ActionFeedback
        state={state}
        {...(state.filename ? { success: t("upl.exported", { file: state.filename }) } : {})}
      />
    </form>
  );
}

// Settlements and self-billing ---------------------------------------------------------------------------

export function SettlementForm({
  org,
  engagements,
  currencies,
  defaultCurrency,
}: {
  org: string;
  engagements: readonly Option[];
  currencies: readonly string[];
  defaultCurrency: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveSettlementAction, INITIAL);
  useAfterSave(state, "create");
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      <Select
        id="settlement-engagement"
        name="engagementId"
        label={t("settlements.fields.engagement")}
        placeholder={t("settlements.fields.chooseEngagement")}
        options={[...engagements]}
        error={fieldError(t, state, "engagementId")}
      />
      <Input
        id="settlement-title"
        name="title"
        required
        width="100%"
        label={t("settlements.fields.title")}
        error={fieldError(t, state, "title")}
      />
      <div className="flex flex-wrap gap-12">
        <Select
          id="settlement-currency"
          name="currency"
          label={t("common.currency")}
          value={defaultCurrency}
          options={currencies.map((c) => ({ value: c, label: c }))}
        />
        <Input
          id="settlement-date"
          name="settledOn"
          type="date"
          label={t("settlements.fields.settledOn")}
          error={fieldError(t, state, "settledOn")}
        />
      </div>
      <ActionFeedback state={state} />
      <Submit label={t("settlements.create")} pending={pending} />
    </form>
  );
}

export function SettlementLineForm({
  org,
  settlementId,
  currency,
  kinds,
}: {
  org: string;
  settlementId: string;
  currency: string;
  kinds: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveSettlementLineAction, INITIAL);
  return (
    <form
      key={state.ok ? String(state.at) : "draft"}
      action={action}
      className="flex flex-col gap-12"
      noValidate
      aria-label={t("settlements.addLine")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="settlementId" value={settlementId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="flex flex-wrap gap-12">
        <Select
          id="sl-kind"
          name="kind"
          label={t("settlements.fields.kind")}
          value={kinds[0]?.value ?? ""}
          options={[...kinds]}
        />
        <Input
          id="sl-amount"
          name="amount"
          inputMode="decimal"
          label={t("common.amountIn", { currency })}
          help={t("common.blankIsUnpriced")}
          error={fieldError(t, state, "amount")}
        />
      </div>
      <Input
        id="sl-description"
        name="description"
        required
        width="100%"
        label={t("common.description")}
        error={fieldError(t, state, "description")}
      />
      <ActionFeedback state={state} />
      <Submit label={t("settlements.addLine")} pending={pending} />
    </form>
  );
}

export function SelfBillForm({
  org,
  engagements,
}: {
  org: string;
  engagements: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(selfBillAction, INITIAL);
  useAfterSave(state, "selfbill");
  return (
    <form action={action} className="flex flex-col gap-16" noValidate>
      <input type="hidden" name="org" value={org} />
      <p className="m-0 text-text-13 text-text-secondary">{t("invoices.selfBillSentence")}</p>
      <Select
        id="selfbill-engagement"
        name="engagementId"
        label={t("settlements.fields.engagement")}
        placeholder={t("settlements.fields.chooseEngagement")}
        options={[...engagements]}
        error={fieldError(t, state, "engagementId")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="selfbill-start"
          name="periodStart"
          type="date"
          required
          label={t("invoices.fields.periodStart")}
          error={fieldError(t, state, "periodStart")}
        />
        <Input
          id="selfbill-end"
          name="periodEnd"
          type="date"
          required
          label={t("invoices.fields.periodEnd")}
          error={fieldError(t, state, "periodEnd")}
        />
      </div>
      <ActionFeedback state={state} />
      <Submit label={t("invoices.selfBillSubmit")} pending={pending} />
    </form>
  );
}
