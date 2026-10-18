"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { createFxRateAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useFinanceT } from "./kit-use-finance-t";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

export function FxRateForm({
  org,
  currencies,
  base,
  quote,
  today,
}: {
  org: string;
  currencies: readonly string[];
  base: string;
  quote: string;
  today: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(createFxRateAction, INITIAL);
  const keep = useKeepInput(state, action, (saved) => Boolean(saved.ok));
  const options = currencies.map((c) => ({ value: c, label: c }));
  return (
    <form
      action={action}
      {...keep}
      className="flex flex-col gap-12"
      noValidate
      aria-label={t("fx.add")}
    >
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-wrap gap-12">
        <Select
          id="fx-base"
          name="base"
          label={t("fx.fields.base")}
          value={base}
          options={options}
          error={fieldError(t, state, "base")}
        />
        <Select
          id="fx-quote"
          name="quote"
          label={t("fx.fields.quote")}
          value={quote}
          options={options}
          error={fieldError(t, state, "quote")}
        />
        <Input
          id="fx-rate"
          name="rate"
          inputMode="decimal"
          required
          label={t("fx.fields.rate")}
          error={fieldError(t, state, "rate")}
        />
      </div>
      <div className="flex flex-wrap gap-12">
        <Input
          id="fx-date"
          name="effectiveOn"
          type="date"
          required
          label={t("fx.fields.effectiveOn")}
          defaultValue={today}
          error={fieldError(t, state, "effectiveOn")}
        />
        <Input
          id="fx-source"
          name="source"
          required
          label={t("fx.fields.source")}
          error={fieldError(t, state, "source")}
        />
      </div>
      <ActionFeedback state={state} success={t("fx.added")} />
      <Submit label={t("fx.add")} pending={pending} />
    </form>
  );
}
