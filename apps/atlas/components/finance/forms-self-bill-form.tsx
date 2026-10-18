"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { selfBillAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

export function SelfBillForm({
  org,
  engagements,
}: {
  org: string;
  engagements: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(selfBillAction, INITIAL);
  useAfterSave(state, "selfbill");
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <p className="m-0 text-text-13 text-text-secondary">{t("invoices.selfBillSentence")}</p>
      <Select
        id="selfbill-engagement"
        name="engagementId"
        label={t("settlements.fields.engagement")}
        placeholder={t("settlements.fields.chooseEngagement")}
        options={[...engagements]}
        error={fieldError(t, state, "engagementId")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="selfbill-start"
          name="periodStart"
          type="date"
          required
          label={t("invoices.fields.periodStart")}
          error={fieldError(t, state, "periodStart")}
        />
        <Input
          id="selfbill-end"
          name="periodEnd"
          type="date"
          required
          label={t("invoices.fields.periodEnd")}
          error={fieldError(t, state, "periodEnd")}
        />
      </div>
      <ActionFeedback state={state} />
      <Submit label={t("invoices.selfBillSubmit")} pending={pending} />
    </form>
  );
}
