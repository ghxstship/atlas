"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { saveSettlementLineAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

export function SettlementLineForm({
  org,
  settlementId,
  currency,
  kinds,
}: {
  org: string;
  settlementId: string;
  currency: string;
  kinds: readonly Option[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveSettlementLineAction, INITIAL);
  return (
    <form
      key={state.ok ? String(state.at) : "draft"}
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
      aria-label={t("settlements.addLine")}
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="settlementId" value={settlementId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="flex flex-wrap gap-12">
        <Select
          id="sl-kind"
          name="kind"
          label={t("settlements.fields.kind")}
          value={kinds[0]?.value ?? ""}
          options={[...kinds]}
        />
        <Input
          id="sl-amount"
          name="amount"
          inputMode="decimal"
          label={t("common.amountIn", { currency })}
          help={t("common.blankIsUnpriced")}
          error={fieldError(t, state, "amount")}
        />
      </div>
      <Input
        id="sl-description"
        name="description"
        required
        width="100%"
        label={t("common.description")}
        error={fieldError(t, state, "description")}
      />
      <ActionFeedback state={state} />
      <Submit label={t("settlements.addLine")} pending={pending} />
    </form>
  );
}
