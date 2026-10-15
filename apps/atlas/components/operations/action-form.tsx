"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import type { ActionState } from "@/lib/operations/state";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The `credentials.errors` translator, widened for keys chosen at runtime. */
export function useErrorCopy(): Translate {
  const t = useTranslations("credentials.errors");
  return (key, values) => (t as unknown as Translate)(key, values);
}

export type FormAction = (state: ActionState, form: FormData) => Promise<ActionState>;

/**
 * A form bound to a server action. It keeps the typed input after a refusal, shows the refusal's
 * catalog sentence next to the controls (Section 11.10: errors name the next action), and announces
 * success in a status region. `hidden` carries ids the server action needs.
 */
export function ActionForm({
  action,
  hidden,
  submitLabel,
  successKey,
  variant = "primary",
  layout = "stack",
  resetOnSuccess = false,
  children,
}: {
  action: FormAction;
  hidden: Readonly<Record<string, string>>;
  submitLabel: string;
  /** Full catalog key of the success message; the action's `result` fills its arguments. */
  successKey?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  layout?: "stack" | "inline";
  resetOnSuccess?: boolean;
  children?: ReactNode;
}) {
  const [state, run, pending] = useActionState(action, {});
  const errors = useErrorCopy();
  const root = useTranslations() as unknown as Translate;
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok && resetOnSuccess) form.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={form}
      onSubmit={(event) => {
        // Submitting through a transition instead of the form action keeps what the person typed
        // when the action is refused; React resets a form after a form action.
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => run(data));
      }}
      noValidate
      className={layout === "inline" ? "flex flex-wrap items-end gap-8" : "flex flex-col gap-12"}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {state.error ? (
        <div className="basis-full">
          <InlineAlert tone="danger">{errors(state.error)}</InlineAlert>
        </div>
      ) : null}
      {children}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" variant={variant} loading={pending}>
          {submitLabel}
        </Button>
        <p role="status" className="m-0 text-text-13 text-success-text">
          {state.ok && successKey ? root(successKey, state.result ?? {}) : null}
        </p>
      </div>
    </form>
  );
}
