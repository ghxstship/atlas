"use client";

import { InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useCallback, useState, useTransition } from "react";
import type { ActionError, ActionResult } from "./action-result";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A translator for keys computed at runtime (canon values, view names, error keys). */
export function useCopy(namespace: "work" | "schedule" | "show"): Translate {
  const t = useTranslations(namespace);
  return useCallback(
    (key: string, values?: Record<string, string | number>) => {
      return (t as unknown as Translate)(key, values);
    },
    [t],
  );
}

/**
 * Runs a server action with pending state and keeps its error for display; the callback runs after a
 * success. Every action run here revalidates the org's pages (revalidatePath), and Next returns the
 * refreshed route with the action's own response, so server-rendered data shows the change without a
 * second request. A router.refresh() after each action rendered the whole org layout twice per click
 * and kept the button pending until the second render landed; on a loaded CI runner that pushed a
 * record's Trash, Restore and checklist steps past the journeys' wait (journey 70, A71).
 */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionError | null>(null);
  const run = useCallback(
    <T,>(action: () => Promise<ActionResult<T>>, onDone?: (data: T) => void) => {
      setError(null);
      startTransition(async () => {
        const result = await action();
        if (result.ok) {
          onDone?.(result.data);
        } else {
          setError(result.error);
        }
      });
    },
    [],
  );
  return { pending, error, run, clear: () => setError(null) };
}

/** The refusal or failure of an action: the catalog sentence, and the database's correction. */
export function ActionErrorAlert({ error }: { error: ActionError | null }) {
  const t = useCopy("work");
  if (!error) return null;
  return (
    <div>
      <InlineAlert tone="danger" title={t(`errors.${error.key}`)}>
        {error.detail ?? t("errors.next")}
      </InlineAlert>
    </div>
  );
}
