"use client";

import { Button, Dialog, InlineAlert, Textarea } from "@xos/ui";
import { startTransition, useActionState, useId, useState, type FormEvent } from "react";
import type { AdvancingState } from "./actions";
import { reviewRosterEntryAction } from "./roster-actions";
import { useCopy } from "./use-copy";

/**
 * Crew roster review controls (R4): Accept, and Return with a reason in a dialog, for a reviewer with
 * advancing.submission.review; the database refuses the entry's creator and its submitter.
 */
export function RosterReviewActions({ org, id, name }: { org: string; id: string; name: string }) {
  const t = useCopy("advancing.crew");
  const errors = useCopy("advancing.errors");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const [state, run, pending] = useActionState<AdvancingState, FormData>(async (prev, form) => {
    const next = await reviewRosterEntryAction(prev, form);
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
    <div className="flex flex-col items-end gap-4">
      <div className="flex flex-wrap gap-8">
        <form onSubmit={submit}>
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="outcome" value="Accepted" />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={pending}
            aria-busy={pending}
          >
            {t("accept")}
          </Button>
        </form>
        <Dialog
          title={t("returnTitle", { name })}
          open={open}
          onOpenChange={setOpen}
          trigger={
            <Button type="button" size="sm" variant="ghost">
              {t("return")}
            </Button>
          }
          actions={
            <>
              <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                variant="primary"
                type="submit"
                form={formId}
                disabled={pending}
                aria-busy={pending}
              >
                {t("returnSubmit")}
              </Button>
            </>
          }
        >
          <form id={formId} onSubmit={submit} className="flex flex-col gap-8">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="outcome" value="Returned" />
            <Textarea
              id={`${formId}-reason`}
              name="reason"
              required
              maxLength={500}
              width="100%"
              label={t("returnReason")}
              error={state.fieldErrors?.["reason"] ? errors("roster_review_reason") : ""}
            />
          </form>
        </Dialog>
      </div>
      {state.error ? (
        <InlineAlert tone="danger" title={errors("title")}>
          {errors(state.error)}
        </InlineAlert>
      ) : null}
    </div>
  );
}
