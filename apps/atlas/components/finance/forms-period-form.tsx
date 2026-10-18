"use client";

import { Input } from "@xos/ui";
import { useActionState } from "react";
import { createPeriodAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

// Periods and journal ----------------------------------------------------------------------------------

export function PeriodForm({
  org,
  startsOn,
  endsOn,
}: {
  org: string;
  startsOn: string;
  endsOn: string;
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(createPeriodAction, INITIAL);
  useAfterSave(state, "create");
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <div className="flex flex-wrap gap-12">
        <Input
          id="period-start"
          name="startsOn"
          type="date"
          required
          label={t("periods.fields.startsOn")}
          defaultValue={startsOn}
          error={fieldError(t, state, "startsOn")}
        />
        <Input
          id="period-end"
          name="endsOn"
          type="date"
          required
          label={t("periods.fields.endsOn")}
          defaultValue={endsOn}
          error={fieldError(t, state, "endsOn")}
        />
      </div>
      <ActionFeedback state={state} />
      <Submit label={t("periods.create")} pending={pending} />
    </form>
  );
}
