"use client";

import { Button, Dialog, InlineAlert } from "@xos/ui";
import { useActionState, useRef, useState } from "react";
import { errorText, useSecurityCopy } from "./copy";
import { useStepUpForm } from "./step-up";

/** The state the account-security and settings actions answer with. */
export interface ConfirmState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly count?: number;
  readonly at?: number;
}

/**
 * A destructive control confirmed in a dialog (A99): sign out a session, sign out every other session, revoke an app
 * or an API key, remove a registered app. The form posts to a server action; a `step_up_required` refusal opens the
 * step-up dialog and resubmits. Success is announced in a status line.
 */
export function ConfirmAction({
  action,
  fields,
  trigger,
  triggerLabel,
  title,
  sentence,
  confirm,
  successKey,
  cancel,
  variant = "ghost",
  formId,
}: {
  action: (state: ConfirmState, form: FormData) => Promise<ConfirmState>;
  fields: Readonly<Record<string, string>>;
  trigger: string;
  /** The accessible name of the trigger when its text alone is ambiguous in a list. */
  triggerLabel?: string;
  title: string;
  sentence: string;
  confirm: string;
  /** An authSecurity key for the success line; it receives the count an action reports. */
  successKey: string;
  cancel: string;
  variant?: "ghost" | "secondary";
  formId: string;
}) {
  const t = useSecurityCopy();
  const [open, setOpen] = useState(false);
  const [state, dispatch, pending] = useActionState(action, {});
  const form = useRef<HTMLFormElement>(null);
  const stepUp = useStepUpForm(state, (s) => s.error === "step_up_required", form);
  const [judged, setJudged] = useState(state);
  if (state !== judged) {
    setJudged(state);
    if (state.ok || state.error === "step_up_required") setOpen(false);
  }
  const shownError = state.error && state.error !== "step_up_required" ? state.error : null;
  return (
    <div className="flex flex-col items-start gap-4">
      <form id={formId} ref={form} action={dispatch} className="hidden">
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      </form>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            type="button"
            size="sm"
            variant={variant}
            {...(triggerLabel ? { "aria-label": triggerLabel } : {})}
          >
            {trigger}
          </Button>
        }
        title={title}
        description={sentence}
        actions={
          <>
            <Button type="button" onClick={() => setOpen(false)}>
              {cancel}
            </Button>
            <Button type="submit" form={formId} variant="danger" loading={pending}>
              {confirm}
            </Button>
          </>
        }
      >
        {shownError ? <InlineAlert tone="danger">{errorText(t, shownError)}</InlineAlert> : null}
      </Dialog>
      {shownError && !open ? (
        <InlineAlert tone="danger">{errorText(t, shownError)}</InlineAlert>
      ) : null}
      {state.ok ? (
        <p role="status" className="m-0 text-text-12 text-success-text">
          {t(successKey, { count: state.count ?? 0 })}
        </p>
      ) : null}
      {stepUp}
    </div>
  );
}
