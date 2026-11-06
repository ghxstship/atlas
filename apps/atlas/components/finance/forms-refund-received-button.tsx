"use client";

import { Button, Dialog, Textarea } from "@xos/ui";
import { useActionState, useState } from "react";
import { transitionAction } from "@/app/[org]/finance/actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ActionFeedback } from "./kit-action-feedback";
import { useFinanceT } from "./kit-use-finance-t";

/** A credit's move to Paid, which says the refund came in: the expense transition under its own label. */
export function RefundReceivedButton({ org, id }: { org: string; id: string }) {
  const t = useFinanceT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(transitionAction, {});
  const label = t("expenses.refundReceived");
  // Close once per completed submit; `at` changes on every submit (state from the previous render).
  const [seenAt, setSeenAt] = useState(state.at);
  if (state.at !== seenAt) {
    setSeenAt(state.at);
    if (state.ok) setOpen(false);
  }
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={setOpen}
          title={label}
          description={t("common.reasonHelp")}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
              <Button type="submit" form={`refund-${id}`} variant="primary" loading={pending}>
                {label}
              </Button>
            </>
          }
        >
          <form
            id={`refund-${id}`}
            action={action}
            onSubmit={keepInputOnSubmit(action)}
            className="flex flex-col gap-12"
          >
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="lifecycle" value="expense" />
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="expected" value="Approved" />
            <input type="hidden" name="next" value="Paid" />
            <Textarea
              id={`refund-reason-${id}`}
              name="reason"
              required
              width="100%"
              label={t("common.reason")}
              defaultValue={t("expenses.refundReason")}
              error={state.fieldErrors?.["reason"] ? t("errors.fields.reason") : ""}
            />
            <ActionFeedback state={state} />
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
