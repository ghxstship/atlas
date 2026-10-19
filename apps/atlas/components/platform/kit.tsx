"use client";

import {
  Button,
  EmptyState,
  ErrorState,
  InlineAlert,
  RefusalNotice,
  Skeleton,
  type ButtonProps,
} from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL_PLATFORM_STATE, type PlatformActionState } from "@/lib/platform/state";

/**
 * Client building blocks of A36's pages: the `platform` translator, outcome feedback naming a
 * refusal's rule in catalog copy, a form bound to a server action that keeps typed input after a
 * refusal, the empty, error, refusal and loading states, and a refresher for work the import worker
 * finishes in the background.
 */

export type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

export function usePlatformT(): Translate {
  const t = useTranslations("platform");
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
  state: PlatformActionState,
  form: FormData,
) => Promise<PlatformActionState>;

/** What an action came to: a named refusal, a missing row, a conflict, bad input or a failure. */
export function Feedback({ state, success }: { state: PlatformActionState; success?: string }) {
  const t = usePlatformT();
  if (state.rule) {
    const key = `refusals.${state.rule}`;
    return (
      <InlineAlert tone="warning" title={t("common.refusedTitle")}>
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
 * A form posting to a server action: hidden values, its fields, one submit button and the outcome.
 * Typed input survives a refusal (keepInputOnSubmit); a success resets the form and runs `onDone`.
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
  disabled = false,
}: {
  action: ServerAction;
  hidden?: Readonly<Record<string, string>>;
  submitLabel: string;
  submitVariant?: ButtonProps["variant"];
  success?: string;
  label: string;
  onDone?: (state: PlatformActionState) => void;
  children?: ReactNode;
  inline?: boolean;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_PLATFORM_STATE);
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
        <Button type="submit" variant={submitVariant} loading={pending} disabled={disabled}>
          {submitLabel}
        </Button>
      </div>
      <div aria-live="polite">
        <Feedback state={state} {...(success ? { success } : {})} />
      </div>
    </form>
  );
}

export function EmptyPanel({
  sentence,
  actionLabel,
  href,
  icon = "Inbox",
  secondary = false,
}: {
  sentence: string;
  actionLabel: string;
  href: string;
  icon?: string;
  /** The page already holds its primary action, so this button is secondary (gate 27). */
  secondary?: boolean;
}) {
  const router = useRouter();
  return (
    <EmptyState
      icon={icon}
      sentence={sentence}
      actionLabel={actionLabel}
      actionVariant={secondary ? "secondary" : "primary"}
      onAction={() => router.push(href as Route)}
    />
  );
}

export function ErrorPanel({ sentence }: { sentence: string }) {
  const t = usePlatformT();
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

/** Shown when the viewer lacks what a page needs; the reason names it and the action leads on. */
export function RefusalPanel({
  reason,
  actionLabel,
  href,
}: {
  reason: string;
  actionLabel: string;
  href: string;
}) {
  const t = usePlatformT();
  const router = useRouter();
  return (
    <RefusalNotice
      outcome="REFUSE"
      title={t("common.refusedTitle")}
      reason={reason}
      actionLabel={actionLabel}
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

/** Refreshes the page every two seconds while background work runs, with a status line. */
export function Refresher({ active, label }: { active: boolean; label: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [active, router]);
  if (!active) return null;
  return (
    <p role="status" className="m-0 flex items-center gap-8 text-text-13 text-text-secondary">
      <span
        aria-hidden="true"
        className="inline-block size-8 rounded-full bg-accent-default motion-safe:animate-pulse"
      />
      {label}
    </p>
  );
}
