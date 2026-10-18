"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { saveSettlementAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

// Settlements and self-billing ---------------------------------------------------------------------------

export function SettlementForm({
  org,
  engagements,
  currencies,
  defaultCurrency,
}: {
  org: string;
  engagements: readonly Option[];
  currencies: readonly string[];
  defaultCurrency: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveSettlementAction, INITIAL);
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
        id="settlement-engagement"
        name="engagementId"
        label={t("settlements.fields.engagement")}
        placeholder={t("settlements.fields.chooseEngagement")}
        options={[...engagements]}
        error={fieldError(t, state, "engagementId")}
      />
      <Input
        id="settlement-title"
        name="title"
        required
        width="100%"
        label={t("settlements.fields.title")}
        error={fieldError(t, state, "title")}
      />
      <div className="flex flex-wrap gap-12">
        <Select
          id="settlement-currency"
          name="currency"
          label={t("common.currency")}
          value={defaultCurrency}
          options={currencies.map((c) => ({ value: c, label: c }))}
        />
        <Input
          id="settlement-date"
          name="settledOn"
          type="date"
          label={t("settlements.fields.settledOn")}
          error={fieldError(t, state, "settledOn")}
        />
      </div>
      <ActionFeedback state={state} />
      <Submit label={t("settlements.create")} pending={pending} />
    </form>
  );
}
