"use client";

import { Button, InlineAlert, Input, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import { counterOfferAction, type CounterState } from "@/lib/actions/offers";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Counter an offer with new terms (Section 4.4.4: accepted, countered or declined). */
export function CounterForm(props: {
  offerId: string;
  currency: string;
  rateType: string;
  rateTypeLabel: string;
  startsOn: string;
  endsOn: string;
}) {
  const t = useTranslations("gateway.work.applications.counter") as unknown as Translate;
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<CounterState, FormData>(counterOfferAction, {});
  if (state.done) return <InlineAlert tone="success">{t("sent")}</InlineAlert>;
  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        {t("open")}
      </Button>
    );
  }
  return (
    <form action={action} className="flex w-full flex-col gap-12 rounded-control bg-bg-surface p-12" aria-label={t("title")}>
      <OutcomeAlert outcome={state.outcome} />
      {state.fieldError ? <InlineAlert tone="danger">{t(`errors.${state.fieldError}`)}</InlineAlert> : null}
      <input type="hidden" name="offerId" value={props.offerId} />
      <input type="hidden" name="currency" value={props.currency} />
      <input type="hidden" name="rateType" value={props.rateType} />
      <div className="flex flex-wrap gap-8">
        <Input
          id={`counter-${props.offerId}-amount`}
          name="amount"
          inputMode="decimal"
          required
          label={t("amount", { currency: props.currency, rate: props.rateTypeLabel })}
        />
        <Input id={`counter-${props.offerId}-start`} name="startsOn" type="date" required label={t("startsOn")} defaultValue={props.startsOn} />
        <Input id={`counter-${props.offerId}-end`} name="endsOn" type="date" required label={t("endsOn")} defaultValue={props.endsOn} />
      </div>
      <Textarea id={`counter-${props.offerId}-message`} name="message" required rows={2} width="100%" label={t("message")} />
      <div className="flex gap-8">
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
          {t("submit")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
