"use client";

import { Button, InlineAlert, Input, Select } from "@xos/ui";
import { useActionState, useId, useRef } from "react";
import { revealSupplierDiversityNumberAction, type RevealState } from "@/app/[org]/vendors/actions";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { useCopy } from "@/components/collection-kit/use-copy";

const INITIAL: RevealState = {};
const stepUpRefused = (state: RevealState) => state.rule === "step_up_required";

/**
 * The audited reveal of a shared certificate number (decision 38, migration 2011), for members holding
 * data.restricted.read.government_id: they pick the certification and write why, the database asks for step-up
 * (the step-up dialog, then a retry) and logs the reason in the owner's access log and the org's audit ledger.
 * The number shows once in the form's state and is never kept.
 */
export function SupplierDiversityReveal({
  org,
  options,
}: {
  org: string;
  options: readonly { readonly value: string; readonly label: string }[];
}) {
  const t = useCopy("vendors");
  const kit = useCopy("procurement.kit");
  const [state, dispatch, pending] = useActionState(revealSupplierDiversityNumberAction, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const stepUpDialog = useStepUpForm(state, stepUpRefused, form);
  const id = useId();
  const refusal =
    state.rule && state.rule !== "step_up_required"
      ? t.has(`refusals.${state.rule}`)
        ? t(`refusals.${state.rule}`)
        : kit("refusalFamily.other")
      : null;
  // The dialog renders outside the form: React bubbles a portal's submit event to its tree parents.
  return (
    <>
      {stepUpDialog}
      <form
        ref={form}
        action={dispatch}
        onSubmit={keepInputOnSubmit(dispatch)}
        noValidate
        aria-label={t("diversity.reveal")}
        className="flex flex-col gap-8"
      >
        <h3 className="m-0 text-heading-14 font-semibold">{t("diversity.reveal")}</h3>
        <p className="m-0 text-text-13 text-text-secondary">{t("diversity.revealLead")}</p>
        <input type="hidden" name="org" value={org} />
        {refusal ? (
          <InlineAlert tone="danger">
            {refusal}
            <span className="block font-mono text-text-11 text-text-tertiary">{state.rule}</span>
          </InlineAlert>
        ) : null}
        {state.error ? (
          <InlineAlert tone="danger">{kit(`errors.${state.error}`)}</InlineAlert>
        ) : null}
        {state.revealed ? (
          <p role="status" className="m-0 text-text-13 tabular-nums">
            {t("diversity.revealed", { number: state.revealed })}
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-12">
          <Select
            id={`${id}-share`}
            name="shareId"
            label={t("diversity.revealWhich")}
            {...(options[0] ? { value: options[0].value } : {})}
            options={[...options]}
          />
          <Input
            id={`${id}-reason`}
            name="reason"
            label={t("diversity.revealReason")}
            help={t("diversity.revealReasonHelp")}
            maxLength={500}
            autoComplete="off"
          />
        </div>
        <div>
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {t("diversity.revealSubmit")}
          </Button>
        </div>
      </form>
    </>
  );
}
