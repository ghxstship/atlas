"use client";

import type { WorkflowSignal } from "@xos/data/product-workflows";
import { emitWorkflow } from "@xos/data/workflow-signal";
import { Button, EmptyState, ErrorState, InlineAlert, Skeleton } from "@xos/ui";
import { RefusalNotice } from "@/components/refusal-notice";
import type { ButtonProps } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { INITIAL_STATE, type WorkflowActionState } from "@/lib/workflow/state";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * Client building blocks of A33's pages: the `workflow` translator, outcome feedback that names a
 * refusal's rule in catalog copy, a form bound to a server action, and the empty, error, refusal and
 * loading states every page shows (Section 19.6).
 */

export type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

export function useWorkflowT(): Translate {
  const t = useTranslations("workflow");
  return useMemo(() => {
    const call = t as unknown as (k: string, v?: Record<string, string | number>) => string;
    const has = (t as unknown as { has: (k: string) => boolean }).has;
    return Object.assign(
      (key: string, values?: Record<string, string | number>) => call(key, values),
      {
        has: (key: string) => has(key),
      },
    );
  }, [t]);
}

export type ServerAction = (
  state: WorkflowActionState,
  form: FormData,
) => Promise<WorkflowActionState>;

/** What an action came to: a named refusal, a missing row, a conflict, bad input or a failure. */
export function Feedback({ state, success }: { state: WorkflowActionState; success?: string }) {
  const t = useWorkflowT();
  if (state.rule) {
    const key = `refusals.${state.rule}`;
    return (
      <InlineAlert tone="warning" title={t("refusals.title")}>
        {t.has(key) ? t(key) : t("refusals.other")}
        <span className="block font-mono text-text-11 text-text-tertiary">{state.rule}</span>
      </InlineAlert>
    );
  }
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  if (state.ok && success) return <InlineAlert tone="success">{success}</InlineAlert>;
  return null;
}

/**
 * A page-level status region (finding A24-001). A decision or a restore removes its row when the
 * page revalidates, and a message rendered inside the row would unmount with it, unseen and unheard.
 * Forms inside the provider announce their outcome here instead, above the list, where it stays
 * until the next outcome replaces it.
 */
const PageStatusContext = createContext<((message: string) => void) | null>(null);

export function PageStatus({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; at: number } | null>(null);
  const announce = useCallback((text: string) => setMessage({ text, at: Date.now() }), []);
  return (
    <PageStatusContext.Provider value={announce}>
      {/* The live region is always mounted, so screen readers announce what InlineAlert adds. */}
      <div aria-live="polite" aria-atomic="true">
        {message ? (
          <InlineAlert key={message.at} tone="success">
            {message.text}
          </InlineAlert>
        ) : null}
      </div>
      {children}
    </PageStatusContext.Provider>
  );
}

/** Announces in the nearest PageStatus; null outside one. */
export function usePageStatus(): ((message: string) => void) | null {
  return useContext(PageStatusContext);
}

/**
 * A form posting to a server action, with hidden values, its fields, one submit button and the
 * outcome. On success it resets, and `onDone` runs (for example to close a dialog).
 */
export function ActionForm({
  action,
  hidden = {},
  submitLabel,
  submitVariant = "primary",
  success,
  label,
  onDone,
  children,
  inline = false,
  announce = false,
  signals,
}: {
  action: ServerAction;
  hidden?: Readonly<Record<string, string>>;
  submitLabel: string;
  submitVariant?: ButtonProps["variant"];
  success?: string;
  label: string;
  onDone?: (state: WorkflowActionState) => void;
  children?: ReactNode;
  inline?: boolean;
  /** Success is announced in the page's PageStatus, for a form whose row leaves on success. */
  announce?: boolean;
  /** Workflow funnel signals sent on success (A146), from the action like the announcement. */
  signals?: readonly WorkflowSignal[];
}) {
  const pageStatus = usePageStatus();
  const toPage = announce && pageStatus !== null;
  // The revalidated page can drop this form's row in the same commit as the result, so the page
  // region hears about success from the action itself, never from an effect of this component.
  const announcing = useCallback<ServerAction>(
    async (previous, form) => {
      const next = await action(previous, form);
      if (toPage && next.ok && success) pageStatus(success);
      if (next.ok) for (const s of signals ?? []) emitWorkflow(s);
      return next;
    },
    [action, toPage, pageStatus, success, signals],
  );
  const [state, formAction, pending] = useActionState(announcing, INITIAL_STATE);
  const ref = useRef<HTMLFormElement>(null);
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.ok && state.at !== seen.current) {
      seen.current = state.at;
      ref.current?.reset();
      onDone?.(state);
    }
  }, [state, onDone]);
  return (
    <form
      ref={ref}
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      aria-label={label}
      className={inline ? "flex flex-wrap items-end gap-8" : "flex flex-col gap-12"}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="flex flex-wrap items-center gap-8">
        <Button type="submit" variant={submitVariant} loading={pending}>
          {submitLabel}
        </Button>
      </div>
      <div aria-live="polite">
        <Feedback state={state} {...(success && !toPage ? { success } : {})} />
      </div>
    </form>
  );
}

export function EmptyPanel({
  sentence,
  actionLabel,
  href,
  icon = "Inbox",
}: {
  sentence: string;
  actionLabel: string;
  href: string;
  icon?: string;
}) {
  const router = useRouter();
  return (
    <EmptyState
      icon={icon}
      sentence={sentence}
      actionLabel={actionLabel}
      onAction={() => router.push(href as Route)}
    />
  );
}

export function ErrorPanel({ sentence }: { sentence: string }) {
  const t = useWorkflowT();
  const router = useRouter();
  return (
    <ErrorState
      title={t("common.errorTitle")}
      sentence={sentence}
      actionLabel={t("common.retry")}
      onRetry={() => router.refresh()}
    />
  );
}

/** Shown when the viewer lacks the capability a page needs; the capability is named. */
export function RefusalPanel({ capability, href }: { capability: string; href: string }) {
  const t = useWorkflowT();
  const router = useRouter();
  return (
    <RefusalNotice
      outcome="REFUSE"
      title={t("common.refusedTitle")}
      reason={t("common.missingCapability", { capability })}
      actionLabel={t("common.backHome")}
      onAction={() => router.push(href as Route)}
    />
  );
}

export function LoadingPanel({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-8">
      <Skeleton height={28} width="40%" />
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton height={36} />
    </div>
  );
}
