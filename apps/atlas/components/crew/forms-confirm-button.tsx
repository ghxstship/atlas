"use client";

import { Button, InlineAlert, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import type { CrewActionState } from "@/lib/crew/action-state";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { Dialog } from "@/components/lazy-ui/dialog";
import { INITIAL } from "./forms.shared";
import { type Action } from "./forms.types";

/**
 * A button for a state change or another irreversible act: it opens a dialog asking for the reason
 * (prefilled with a sentence the person can edit) and submits the action with its hidden fields.
 */
export function ConfirmButton(props: {
  label: string;
  title: string;
  description?: string;
  defaultReason: string;
  action: Action;
  hidden: Readonly<Record<string, string>>;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** Ask for a reason; acts without one say only what will happen. */
  reason?: boolean;
  confirmLabel?: string;
}) {
  const t = useTranslations("crew.form");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: CrewActionState, form: FormData) => {
    const next = await props.action(prev, form);
    if (next.ok) {
      setOpen(false);
      router.refresh();
    }
    return next;
  }, INITIAL);
  const formId = `confirm-${props.label.replace(/\W+/g, "-")}-${Object.values(props.hidden).join("-")}`;
  return (
    <>
      <Button
        type="button"
        variant={props.variant ?? "secondary"}
        size="sm"
        onClick={() => setOpen(true)}
      >
        {props.label}
      </Button>
      {open ? (
        <Dialog
          title={props.title}
          open
          onOpenChange={setOpen}
          {...(props.description ? { description: props.description } : {})}
          actions={
            <>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                form={formId}
                variant={props.variant === "danger" ? "danger" : "primary"}
                loading={pending}
              >
                {props.confirmLabel ?? props.label}
              </Button>
            </>
          }
        >
          <form
            id={formId}
            action={action}
            onSubmit={keepInputOnSubmit(action)}
            className="flex flex-col gap-12"
            noValidate
          >
            {Object.entries(props.hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            {state.error ? (
              <InlineAlert tone="danger" title={t("refused")}>
                {state.error}
              </InlineAlert>
            ) : null}
            {props.reason === false ? (
              <input type="hidden" name="reason" value={props.defaultReason} />
            ) : (
              <Textarea
                id={`${formId}-reason`}
                name="reason"
                label={t("reason")}
                help={t("reasonHelp")}
                defaultValue={props.defaultReason}
                required
                width="100%"
              />
            )}
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
