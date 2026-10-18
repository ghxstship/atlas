"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { savePaymentAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

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
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
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
