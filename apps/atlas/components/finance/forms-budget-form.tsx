"use client";

import { Checkbox, Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { saveBudgetAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

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
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
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
