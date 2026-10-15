"use client";

import { Button, Dialog, InlineAlert } from "@xos/ui";
import { useActionState, useEffect, useRef, useState } from "react";
import { INITIAL_STATE, type ActionState } from "./action-state";
import { useQueryNavigation } from "./client";
import { useCopy, type FormAction } from "./form";

/**
 * A one-button action (archive, restore, track, sign off) posting hidden fields to a server action.
 * A refusal shows beside the button with its reason and next action.
 */
export function ActionButton({
  action,
  org,
  fields,
  label,
  variant = "secondary",
  onSuccess,
}: {
  action: FormAction;
  org: string;
  fields: Readonly<Record<string, string>>;
  label: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  onSuccess?: (state: ActionState) => Readonly<Record<string, string | undefined>> | null;
}) {
  const t = useCopy("places");
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const navigate = useQueryNavigation();
  const handled = useRef<ActionState | null>(null);
  useEffect(() => {
    if (!state.ok || handled.current === state) return;
    handled.current = state;
    const changes = onSuccess?.(state);
    if (changes) navigate(changes, "replace");
  }, [state, onSuccess, navigate]);
  return (
    <form action={formAction} className="flex flex-col items-start gap-8">
      <input type="hidden" name="org" value={org} />
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" variant={variant} loading={pending}>
        {label}
      </Button>
      {state.error ? (
        <InlineAlert tone="danger" title={t("errors.title")}>
          {t(`errors.${state.error}`)}
        </InlineAlert>
      ) : null}
    </form>
  );
}

/**
 * An irreversible action behind a confirmation dialog (Section 11.7: dialogs are for irreversible
 * actions only), for example freezing a capability document or signing off an inspection.
 */
export function ConfirmButton({
  action,
  org,
  fields,
  label,
  title,
  description,
  confirmLabel,
}: {
  action: FormAction;
  org: string;
  fields: Readonly<Record<string, string>>;
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
}) {
  const t = useCopy("places");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(async (prev: ActionState, form: FormData) => {
    const next = await action(prev, form);
    setOpen(false);
    return next;
  }, INITIAL_STATE);
  const formId = `confirm-${Object.values(fields).join("-")}`;
  return (
    <div className="flex flex-col items-start gap-8">
      <form id={formId} action={formAction}>
        <input type="hidden" name="org" value={org} />
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      </form>
      <Dialog
        title={title}
        description={description}
        open={open}
        onOpenChange={setOpen}
        trigger={<Button variant="secondary">{label}</Button>}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("kit.cancel")}
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={pending}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
      {state.error ? (
        <InlineAlert tone="danger" title={t("errors.title")}>
          {t(`errors.${state.error}`)}
        </InlineAlert>
      ) : null}
    </div>
  );
}
