"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { INITIAL_STATE, type ActionState } from "./action-state";
import { useQueryNavigation } from "./client";

export type FormAction = (state: ActionState, form: FormData) => Promise<ActionState>;

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A translator for keys computed at runtime under one namespace. */
export function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "places");
  return (key, values) => (t as unknown as Translate)(key, values);
}

/** The field error copy for a field, or an empty string. */
export function fieldError(state: ActionState, field: string, t: Translate): string {
  const key = state.fieldErrors?.[field];
  return key ? t(`fields.${key}`) : "";
}

/**
 * A form posting to a server action. It keeps what the person typed after a failed submit, shows the
 * refusal or error in an alert that names the next action, and after success applies `onSuccess`
 * query changes (for example closing the create drawer and opening the new record's peek).
 */
export function ActionForm({
  action,
  org,
  hidden,
  submitLabel,
  submitVariant = "primary",
  onSuccess,
  successMessage,
  children,
  className,
}: {
  action: FormAction;
  org: string;
  hidden?: Readonly<Record<string, string>>;
  submitLabel: string;
  submitVariant?: "primary" | "secondary" | "danger";
  onSuccess?: (state: ActionState) => Readonly<Record<string, string | undefined>> | null;
  successMessage?: string;
  children?: ReactNode | ((error: (field: string) => string) => ReactNode);
  className?: string;
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
    <form action={formAction} className={className ?? "flex flex-col gap-12"} noValidate>
      <input type="hidden" name="org" value={org} />
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {state.error ? (
        <InlineAlert tone="danger" title={t("errors.title")}>
          {t(`errors.${state.error}`)}
        </InlineAlert>
      ) : null}
      {typeof children === "function" ? children((field) => fieldError(state, field, t)) : children}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" variant={submitVariant} loading={pending}>
          {submitLabel}
        </Button>
        {state.ok && successMessage ? (
          <p role="status" className="m-0 text-text-13 text-success-text">
            {successMessage}
          </p>
        ) : null}
      </div>
    </form>
  );
}
