"use client";

import { InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/lib/projects/actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The refusal or failure of a project action, in words that name the next step. */
export function ActionError({ state }: { state: ActionState }) {
  const t = useTranslations("projects.errors") as unknown as Translate;
  if (!state.error) return null;
  return (
    <div role="alert">
      <InlineAlert tone="danger">{t(state.error, state.values ?? {})}</InlineAlert>
    </div>
  );
}

/** The catalog message for a field error, or the empty string. */
export function fieldError(t: (key: never) => string, state: ActionState, name: string): string {
  const key = state.fieldErrors?.[name];
  return key ? (t as unknown as Translate)(`errors.${key}`) : "";
}
