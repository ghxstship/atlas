"use client";

import { Button, Dialog, InlineAlert } from "@xos/ui";
import {
  createContext,
  use,
  useActionState,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";
import type { AssetActionState } from "@/app/[org]/assets/actions";
import { useAssetsCopy } from "./copy";

type Action = (state: AssetActionState, form: FormData) => Promise<AssetActionState>;

/** Open state of a collection's create dialog, shared by its header button and empty state. */
export const CreateDialogContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

/** The create dialog's open state from the collection, or a local one outside a collection. */
export function useCreateDialog(): [boolean, (open: boolean) => void] {
  const shared = use(CreateDialogContext);
  const local = useState(false);
  return shared ? [shared.open, shared.setOpen] : local;
}

/** The refusal or error a failed action names, in the viewer's language, with the field it names. */
export function ActionError({ state }: { state: AssetActionState }) {
  const t = useAssetsCopy();
  if (!state.error) return null;
  return (
    <InlineAlert tone={state.error === "unexpected" ? "danger" : "warning"}>
      {t(`errors.${state.error}`)}
      {state.field ? ` ${t("errors.field", { field: t(`fields.${state.field}`) })}` : ""}
    </InlineAlert>
  );
}

/**
 * A dialog holding one form posted to a server action. It keeps typed input after a refusal, shows
 * the refusal by name, and closes when the action succeeds.
 */
export function ActionDialog({
  title,
  description,
  submitLabel,
  action,
  org,
  hidden,
  open,
  setOpen,
  danger = false,
  onSuccess,
  children,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  action: Action;
  org: string;
  hidden?: Record<string, string>;
  open: boolean;
  setOpen: (open: boolean) => void;
  danger?: boolean;
  onSuccess?: (state: AssetActionState) => void;
  children?: ReactNode;
}) {
  const t = useAssetsCopy();
  const formId = useId();
  const [state, formAction, pending] = useActionState(action, {});
  useEffect(() => {
    if (state.ok) {
      setOpen(false);
      onSuccess?.(state);
    }
    // Closing follows each successful result once; the callbacks are stable for a dialog's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={title}
      {...(description ? { description } : {})}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={danger ? "danger" : "primary"}
            loading={pending}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} action={formAction} className="flex flex-col gap-12" noValidate>
        <input type="hidden" name="org" value={org} />
        {Object.entries(hidden ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <ActionError state={state} />
        {children}
      </form>
    </Dialog>
  );
}

/** A button that opens an ActionDialog: the record page's secondary actions. */
export function ActionButton({
  label,
  icon,
  variant = "secondary",
  ...dialog
}: Omit<Parameters<typeof ActionDialog>[0], "open" | "setOpen"> & {
  label: string;
  icon?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="sm" {...(icon ? { icon } : {})} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open ? <ActionDialog {...dialog} open={open} setOpen={setOpen} /> : null}
    </>
  );
}
