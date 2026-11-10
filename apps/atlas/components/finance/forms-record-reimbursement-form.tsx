"use client";

import { Input, MultiSelect } from "@xos/ui";
import { useFormatter } from "next-intl";
import { useActionState, useState } from "react";
import { recordReimbursementAction } from "@/app/[org]/finance/payables-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ReturnTo } from "./forms-return-to";
import { INITIAL, Submit } from "./forms.shared";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";

export interface OwedOption {
  readonly value: string;
  readonly label: string;
  readonly netMinor: number;
  /** A Proposed credit waits on this charge: recording it is refused, so it starts unselected. */
  readonly pending: boolean;
}

/**
 * Records that a payee was reimbursed in one currency: which charges, the date and the reference, with the net total
 * read-only. Charges with a Proposed credit start unselected, with a note saying why.
 */
export function RecordReimbursementForm({
  org,
  payeePersonId,
  currency,
  exponent,
  owed,
  today,
}: {
  org: string;
  payeePersonId: string;
  currency: string;
  exponent: number;
  owed: readonly OwedOption[];
  today: string;
}) {
  const t = useFinanceT();
  const format = useFormatter();
  const [state, action, pending] = useActionState(recordReimbursementAction, INITIAL);
  const [picked, setPicked] = useState<string[]>(
    owed.filter((o) => !o.pending).map((o) => o.value),
  );
  const net = owed.filter((o) => picked.includes(o.value)).reduce((n, o) => n + o.netMinor, 0);
  const waiting = owed.filter((o) => o.pending);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="payeePersonId" value={payeePersonId} />
      <ReturnTo
        changes={{ record: null, currency: null, peek: null, notice: "reimbursementRecorded" }}
      />
      {picked.map((id) => (
        <input key={id} type="hidden" name="expenseIds" value={id} />
      ))}
      <p className="m-0 text-text-13 text-text-secondary">{t("due.recordOnly")}</p>
      <MultiSelect
        id="reimburse-expenses"
        label={t("reimbursements.sheet.expenses")}
        help={fieldError(t, state, "expenseIds")}
        options={owed.map((o) => ({ value: o.value, label: o.label }))}
        value={picked}
        onChange={setPicked}
      />
      {waiting.length > 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("reimbursements.sheet.pendingNote", { count: waiting.length })}
        </p>
      ) : null}
      <p className="m-0 flex justify-between gap-8 text-text-13">
        <span className="text-text-secondary">{t("reimbursements.sheet.netTotal")}</span>
        <span className="font-semibold tabular-nums">
          {format.number(net / 10 ** exponent, {
            style: "currency",
            currency,
            minimumFractionDigits: exponent,
            maximumFractionDigits: exponent,
          })}
        </span>
      </p>
      <Input
        id="reimburse-date"
        name="paidOn"
        type="date"
        required
        defaultValue={today}
        label={t("payments.fields.paidOn")}
        error={fieldError(t, state, "paidOn")}
      />
      <Input
        id="reimburse-reference"
        name="reference"
        label={t("payments.fields.reference")}
        error={fieldError(t, state, "reference")}
      />
      <ActionFeedback state={state} />
      <Submit label={t("reimbursements.record")} pending={pending} />
    </form>
  );
}
