"use client";

import { InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { ActionState } from "@/lib/projects/actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The refusal or failure of a project action, in words that name the next step. */
export function ActionError({ state }: { state: ActionState }) {
  const t = useTranslations("projects.errors") as unknown as Translate;
  if (!state.error) return null;
  // The danger InlineAlert carries role="alert" itself.
  return <InlineAlert tone="danger">{t(state.error, state.values ?? {})}</InlineAlert>;
}

/** The catalog message for a field error, or the empty string. */
export function fieldError(t: (key: never) => string, state: ActionState, name: string): string {
  const key = state.fieldErrors?.[name];
  return key ? (t as unknown as Translate)(`errors.${key}`) : "";
}

/** What the person submitted for a field when the action failed, otherwise the fallback. */
export function echoed(state: ActionState, name: string, fallback = ""): string {
  return state.echo?.[name] ?? fallback;
}

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;

/** useActionState for a form in a dialog: runs `done` (usually closing it) after a success. */
export function useClosingAction(action: ServerAction, done: () => void) {
  return useActionState(async (state: ActionState, form: FormData) => {
    const next = await action(state, form);
    if (next.ok) done();
    return next;
  }, {});
}
