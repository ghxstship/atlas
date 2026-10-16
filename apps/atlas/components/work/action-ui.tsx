"use client";

import { InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
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
 * Runs a server action with pending state and keeps its error for display. After a success the
 * route refreshes, so server-rendered data shows the change; the callback runs after that.
 */
export function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionError | null>(null);
  const run = useCallback(
    <T,>(action: () => Promise<ActionResult<T>>, onDone?: (data: T) => void) => {
      setError(null);
      startTransition(async () => {
        const result = await action();
        if (result.ok) {
          router.refresh();
          onDone?.(result.data);
        } else {
          setError(result.error);
        }
      });
    },
    [router],
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
