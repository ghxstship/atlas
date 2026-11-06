"use client";

import { Input, MultiSelect } from "@xos/ui";
import { useActionState, useState } from "react";
import { recordPerDiemPaymentsAction } from "@/app/[org]/finance/payables-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ReturnTo } from "./forms-return-to";
import { INITIAL, Submit } from "./forms.shared";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";

/** Records that a worker's unpaid per diems were paid: which ones, the date and the reference (3014). */
export function MarkPerDiemsPaidForm({
  org,
  perDiems,
  today,
}: {
  org: string;
  perDiems: readonly Option[];
  today: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(recordPerDiemPaymentsAction, INITIAL);
  const [picked, setPicked] = useState<string[]>(perDiems.map((p) => p.value));
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <ReturnTo changes={{ payPerDiems: null, peek: null, notice: "perDiemsPaid" }} />
      {picked.map((id) => (
        <input key={id} type="hidden" name="perDiemIds" value={id} />
      ))}
      <p className="m-0 text-text-13 text-text-secondary">{t("due.recordOnly")}</p>
      <MultiSelect
        id="pay-per-diems"
        label={t("due.markPaid.perDiems")}
        help={fieldError(t, state, "perDiemIds")}
        options={[...perDiems]}
        value={picked}
        onChange={setPicked}
      />
      <Input
        id="pay-per-diems-date"
        name="paidOn"
        type="date"
        required
        defaultValue={today}
        label={t("payments.fields.paidOn")}
        error={fieldError(t, state, "paidOn")}
      />
      <Input
        id="pay-per-diems-reference"
        name="reference"
        label={t("payments.fields.reference")}
        error={fieldError(t, state, "reference")}
      />
      <ActionFeedback state={state} />
      <Submit label={t("due.markPaid.title")} pending={pending} />
    </form>
  );
}
