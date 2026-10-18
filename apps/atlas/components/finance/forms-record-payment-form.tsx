"use client";

import { Input } from "@xos/ui";
import { useActionState } from "react";
import { recordInvoicePaymentAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

/** Records that an approved invoice was paid (A38-007): a blank amount pays the whole balance. */
export function RecordPaymentForm({
  org,
  invoiceId,
  currency,
  today,
}: {
  org: string;
  invoiceId: string;
  currency: string;
  today: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(recordInvoicePaymentAction, INITIAL);
  useAfterSave(state, "pay");
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="currency" value={currency} />
      <p className="m-0 text-text-13 text-text-secondary">{t("invoices.recordPaymentSentence")}</p>
      <div className="flex flex-wrap gap-12">
        <Input
          id="pay-amount"
          name="amount"
          inputMode="decimal"
          label={t("invoices.fields.paymentAmount", { currency })}
          help={t("invoices.paymentAmountHint")}
          error={fieldError(t, state, "amount")}
        />
        <Input
          id="pay-date"
          name="paidOn"
          type="date"
          required
          defaultValue={today}
          label={t("payments.fields.paidOn")}
          error={fieldError(t, state, "paidOn")}
        />
      </div>
      <Input
        id="pay-reference"
        name="reference"
        label={t("payments.fields.reference")}
        help={t("invoices.paymentReferenceHint")}
        error={fieldError(t, state, "reference")}
      />
      <ActionFeedback state={state} />
      <Submit label={t("invoices.recordPaymentSubmit")} pending={pending} />
    </form>
  );
}
