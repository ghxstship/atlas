"use client";

import type { WorkflowSignal } from "@xos/data/product-workflows";
import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { OutcomeAlert } from "@/components/actions/action-button";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import type { FormResult } from "@/lib/actions/operations";

/*
 * The chrome every Gateway form shares (the engagement, advancing, allocation and team invite forms): its own module,
 * so a screen that needs only the chrome does not carry every engagement form with it.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function useCopy(): Translate {
  return useTranslations("gateway.engagement.forms") as unknown as Translate;
}

/** Shared form chrome: field and outcome errors, a success line, refresh on success. */
export function FormShell({
  state,
  pending,
  submitLabel,
  doneLabel,
  children,
  action,
  label,
  row = false,
  submitSignal,
}: {
  state: FormResult;
  pending: boolean;
  submitLabel: string;
  doneLabel: string;
  children: ReactNode;
  action: (form: FormData) => void;
  label: string;
  /** One of several forms in a list (an answer per section, a decision per row): its submit is
   *  secondary, so the screen keeps one primary action (Section 11.10; finding A59-029). */
  row?: boolean;
  /** Workflow funnel signal sent when the form is submitted (A146). */
  submitSignal?: WorkflowSignal;
}) {
  const t = useCopy();
  const router = useRouter();
  useEffect(() => {
    if (state.done) router.refresh();
  }, [state.done, router]);
  if (state.done)
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {doneLabel}
      </p>
    );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex w-full flex-col gap-12"
      aria-label={label}
      data-workflow={submitSignal}
    >
      {state.fieldError ? (
        <InlineAlert tone="danger">{t(`errors.${state.fieldError}`)}</InlineAlert>
      ) : null}
      <OutcomeAlert outcome={state.outcome} />
      {children}
      <div>
        <Button
          type="submit"
          variant={row ? "secondary" : "primary"}
          size="sm"
          disabled={pending}
          aria-busy={pending}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
