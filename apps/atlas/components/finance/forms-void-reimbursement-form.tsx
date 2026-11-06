"use client";

import { Textarea } from "@xos/ui";
import { useActionState } from "react";
import { voidReimbursementAction } from "@/app/[org]/finance/payables-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ReturnTo } from "./forms-return-to";
import { INITIAL, Submit } from "./forms.shared";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";

/** Voids a reimbursement recorded in error, with a reason: its expenses are Owed again (3012). */
export function VoidReimbursementForm({ org, id }: { org: string; id: string }) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(voidReimbursementAction, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={id} />
      <ReturnTo changes={{ voidReimbursement: null, notice: "reimbursementVoided" }} />
      <p className="m-0 text-text-13 text-text-secondary">{t("reimbursements.voidSentence")}</p>
      <Textarea
        id="void-reimbursement-reason"
        name="reason"
        required
        width="100%"
        label={t("common.reason")}
        error={fieldError(t, state, "reason")}
      />
      <ActionFeedback state={state} />
      <Submit label={t("reimbursements.void")} pending={pending} />
    </form>
  );
}
