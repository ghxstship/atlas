"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { saveInvoiceLineAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

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
      onSubmit={keepInputOnSubmit(action)}
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
