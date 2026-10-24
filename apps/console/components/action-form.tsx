"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";

/**
 * A console form over a server action (Section 11.7): it posts natively before hydration, shows the action's error
 * as a sentence from the catalog (a refusal by its rule, else a general one) and confirms success in a live region.
 * The database decides every rule; this only says what it decided.
 */
export function ActionForm({
  action,
  hidden = {},
  submitLabel,
  successLabel,
  variant = "primary",
  label,
  resetOnSuccess = true,
  testId,
  children,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  hidden?: Readonly<Record<string, string>>;
  submitLabel: string;
  successLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  /** An accessible name for the form, when the page holds several. */
  label?: string;
  resetOnSuccess?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  const t = useTranslations("console");
  const [state, formAction, pending] = useActionState(action, IDLE);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "done" && resetOnSuccess) form.current?.reset();
  }, [state, resetOnSuccess]);
  const message =
    state.status === "error"
      ? t.has(state.key as never)
        ? t(state.key as never)
        : t("errors.refused")
      : null;
  return (
    <form
      ref={form}
      action={formAction}
      className="flex flex-col gap-12"
      aria-label={label}
      data-testid={testId}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      {message ? <InlineAlert tone="danger">{message}</InlineAlert> : null}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" variant={variant} loading={pending}>
          {submitLabel}
        </Button>
        <span role="status" className="text-text-13 text-text-secondary">
          {state.status === "done" && successLabel ? successLabel : null}
        </span>
      </div>
    </form>
  );
}
