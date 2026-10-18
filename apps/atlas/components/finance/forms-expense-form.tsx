"use client";

import { Combobox, Input, Select } from "@xos/ui";
import { useActionState, useState } from "react";
import { saveExpenseAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";
import { type LineOption } from "./forms.types";

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
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
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
