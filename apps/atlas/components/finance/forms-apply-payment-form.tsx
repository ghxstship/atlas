"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { applyPaymentAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

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
  const keep = useKeepInput(state, action, (saved) => Boolean(saved.ok));
  return (
    <form
      action={action}
      {...keep}
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
