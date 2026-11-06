"use client";

import { Combobox, InlineAlert, Input, Select, Switch } from "@xos/ui";
import { useActionState, useRef, useState, useTransition } from "react";
import { saveExpenseAction } from "@/app/[org]/finance/actions";
import { findExpenseLookAlikesAction } from "@/app/[org]/finance/payables-actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { ExtractEntry } from "@/components/aurora/entry/extract-entry";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";
import { type ActOption, type LineOption } from "./forms.types";

export function ExpenseForm({
  org,
  lines,
  counterparties,
  acts,
  today,
  expense,
}: {
  org: string;
  lines: readonly LineOption[];
  counterparties: readonly Option[];
  /** Live engagements the expense can be for, each on its project (3017). */
  acts: readonly ActOption[];
  today: string;
  expense?: {
    id: string;
    budgetLineId: string;
    counterpartyId: string | null;
    description: string;
    incurredOn: string;
    amount: string;
    currency: string;
    isReimbursable: boolean;
    engagementId: string | null;
  };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveExpenseAction, INITIAL);
  useAfterSave(state, expense ? "edit" : "create");
  const [lineId, setLineId] = useState(expense?.budgetLineId ?? "");
  const line = lines.find((l) => l.value === lineId);
  const currency = expense?.currency ?? line?.currency ?? "";
  const lineActs = acts.filter((a) => a.projectId === line?.projectId);
  // The look-alike check runs when the line, amount and date are filled, and blocks nothing (3016).
  const [lookAlikes, setLookAlikes] = useState(0);
  const [, startCheck] = useTransition();
  const checked = useRef("");
  const checkLookAlikes = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const key = ["budgetLineId", "amount", "incurredOn", "counterpartyId"]
      .map((name) => String(data.get(name) ?? ""))
      .join("|");
    if (key === checked.current) return;
    checked.current = key;
    if (!data.get("budgetLineId") || !data.get("amount") || !data.get("incurredOn")) {
      setLookAlikes(0);
      return;
    }
    // A warning only: a check that fails reads as none, and must not take the form and what was typed with it.
    startCheck(async () => {
      try {
        setLookAlikes(await findExpenseLookAlikesAction(data));
      } catch {
        setLookAlikes(0);
      }
    });
  };
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      onBlur={(event) => checkLookAlikes(event.currentTarget)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="currency" value={currency} />
      {expense ? <input type="hidden" name="id" value={expense.id} /> : null}
      {expense ? <input type="hidden" name="budgetLineId" value={expense.budgetLineId} /> : null}
      {expense ? null : (
        <>
          <ExtractEntry
            kind="receipt"
            fields={{
              description: { name: "description" },
              amount_minor: { name: "amount", as: "money" },
              incurred_on: { name: "incurredOn" },
            }}
          />
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
      <Switch
        name="isReimbursable"
        label={t("expenses.paidMyself")}
        defaultChecked={expense?.isReimbursable ?? false}
      />
      {/* The act's list belongs to the line's project, so the choice resets with the line. */}
      <Select
        key={lineId}
        id="expense-act"
        name="engagementId"
        label={t("expenses.forAct")}
        value={expense?.budgetLineId === lineId ? (expense.engagementId ?? "") : ""}
        options={[{ value: "", label: t("expenses.forActNone") }, ...lineActs]}
      />
      {lookAlikes > 0 ? (
        <InlineAlert tone="warning" title={t("expenses.duplicate.title")}>
          {t("expenses.duplicate.body", { count: lookAlikes })}
        </InlineAlert>
      ) : null}
      <ActionFeedback state={state} />
      <Submit label={expense ? t("common.save") : t("expenses.create")} pending={pending} />
    </form>
  );
}
