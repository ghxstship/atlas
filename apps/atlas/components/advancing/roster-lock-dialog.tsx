"use client";

import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import { startTransition, useActionState, useId, useState, type FormEvent } from "react";
import type { AdvancingState } from "./actions";
import { setRosterLockAction } from "./roster-actions";
import { useCopy } from "./use-copy";

/**
 * Set names lock (R5, G-142): one date and time in the project's zone after which the engagement's company names no
 * new crew, and Clear. The producing org's writer opens it from the party's header in Crew review; the database checks
 * advancing.packet.write or opportunities.engagement.write on the project and refuses a closed engagement.
 */
export function RosterLockDialog({
  org,
  engagementId,
  party,
  locksAtLocal,
  timeZone,
}: {
  org: string;
  engagementId: string;
  party: string;
  /** The current lock as a datetime-local value in the project's zone, or empty. */
  locksAtLocal: string;
  timeZone: string;
}) {
  const t = useCopy("advancing.crew.lock");
  const errors = useCopy("advancing.errors");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const [state, run, pending] = useActionState<AdvancingState, FormData>(async (prev, form) => {
    const next = await setRosterLockAction(prev, form);
    if (next.ok) setOpen(false);
    return next;
  }, {});
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(event.currentTarget, submitter);
    startTransition(() => run(data));
  };
  return (
    <Dialog
      title={t("title", { party })}
      description={t("sentence")}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button type="button" size="sm" variant="ghost">
          {t("set")}
        </Button>
      }
      actions={
        <>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          {locksAtLocal ? (
            <Button
              variant="ghost"
              type="submit"
              form={formId}
              name="intent"
              value="clear"
              disabled={pending}
            >
              {t("clear")}
            </Button>
          ) : null}
          <Button
            variant="primary"
            type="submit"
            form={formId}
            name="intent"
            value="set"
            disabled={pending}
            aria-busy={pending}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="engagementId" value={engagementId} />
        <input type="hidden" name="timeZone" value={timeZone} />
        <Input
          id={`${formId}-at`}
          name="locksAt"
          type="datetime-local"
          label={t("field")}
          help={t("fieldHelp", { zone: timeZone })}
          defaultValue={locksAtLocal}
          {...(state.fieldErrors?.["locksAt"] ? { error: errors("invalid") } : {})}
        />
        {state.error ? <InlineAlert tone="danger">{errors(state.error)}</InlineAlert> : null}
      </form>
    </Dialog>
  );
}
