"use client";

import { Checkbox, Combobox, Input, Select } from "@xos/ui";
import { useActionState, useState } from "react";
import { saveChangeOrderLineAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

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
      onSubmit={keepInputOnSubmit(action)}
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
