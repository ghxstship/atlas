"use client";

import { Input } from "@xos/ui";
import { useActionState } from "react";
import { saveExpenseCreditAction } from "@/app/[org]/finance/payables-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterRecord } from "./forms-after-record";
import { useFinanceT } from "./kit-use-finance-t";

/**
 * Records or edits a credit against a charge (3010): its amount, date and description. It takes the charge's line,
 * currency and vendor, so nothing else is asked, and it never sends the reimbursable flag or an act.
 */
export function ExpenseCreditForm({
  org,
  originalId,
  creditId,
  currency,
  amount,
  incurredOn,
  description,
}: {
  org: string;
  originalId: string;
  /** Set when editing a Proposed credit. */
  creditId?: string;
  currency: string;
  amount: string;
  incurredOn: string;
  description: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveExpenseCreditAction, INITIAL);
  useAfterRecord(
    state,
    creditId ? { edit: null } : { recordCredit: null, ...(state.id ? { peek: state.id } : {}) },
  );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="originalId" value={originalId} />
      <input type="hidden" name="currency" value={currency} />
      {creditId ? <input type="hidden" name="id" value={creditId} /> : null}
      <p className="m-0 text-text-13 text-text-secondary">{t("expenses.creditSentence")}</p>
      <Input
        id="credit-amount"
        name="amount"
        inputMode="decimal"
        required
        label={t("common.amountIn", { currency })}
        defaultValue={amount}
        error={fieldError(t, state, "amount")}
      />
      <Input
        id="credit-date"
        name="incurredOn"
        type="date"
        required
        label={t("expenses.fields.incurredOn")}
        defaultValue={incurredOn}
        error={fieldError(t, state, "incurredOn")}
      />
      <Input
        id="credit-description"
        name="description"
        required
        width="100%"
        label={t("common.description")}
        defaultValue={description}
        error={fieldError(t, state, "description")}
      />
      <ActionFeedback state={state} />
      <Submit label={creditId ? t("common.save") : t("expenses.recordCredit")} pending={pending} />
    </form>
  );
}
