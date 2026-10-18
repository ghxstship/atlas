"use client";

import { Button, Dialog, Textarea } from "@xos/ui";
import { useActionState, useState } from "react";
import { transitionAction } from "@/app/[org]/finance/actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ActionFeedback } from "./kit-action-feedback";
import { useFinanceT } from "./kit-use-finance-t";
import { type Lifecycle } from "./kit.types";

/**
 * One lifecycle move: asks for the reason every transition ledger records, then calls the RPC. The
 * button label comes from `finance.transitions.<lifecycle>.<next>`.
 */
export function TransitionButton({
  org,
  lifecycle,
  id,
  expected,
  next,
  variant = "secondary",
}: {
  org: string;
  lifecycle: Lifecycle;
  id: string;
  expected: string;
  next: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const t = useFinanceT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(transitionAction, {});
  const nextKey = next.replace(/\s+/g, "");
  const label = t(`transitions.${lifecycle}.${nextKey}`);
  // Close once per completed submit; `at` changes on every submit (state from the previous render).
  const [seenAt, setSeenAt] = useState(state.at);
  if (state.at !== seenAt) {
    setSeenAt(state.at);
    if (state.ok) setOpen(false);
  }
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
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
              <Button
                type="submit"
                form={`transition-${id}-${nextKey}`}
                variant={variant === "danger" ? "danger" : "primary"}
                loading={pending}
              >
                {label}
              </Button>
            </>
          }
        >
          <form
            id={`transition-${id}-${nextKey}`}
            action={action}
            onSubmit={keepInputOnSubmit(action)}
            className="flex flex-col gap-12"
          >
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="lifecycle" value={lifecycle} />
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="expected" value={expected} />
            <input type="hidden" name="next" value={next} />
            <Textarea
              id={`transition-reason-${id}-${nextKey}`}
              name="reason"
              required
              width="100%"
              label={t("common.reason")}
              defaultValue={
                t.has(`transitions.${lifecycle}.reason.${nextKey}`)
                  ? t(`transitions.${lifecycle}.reason.${nextKey}`)
                  : ""
              }
              error={state.fieldErrors?.["reason"] ? t("errors.fields.reason") : ""}
            />
            <ActionFeedback state={state} />
          </form>
        </Dialog>
      ) : null}
      {!open && state.pending ? <ActionFeedback state={state} /> : null}
    </>
  );
}
