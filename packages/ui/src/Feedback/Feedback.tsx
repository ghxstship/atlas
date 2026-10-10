import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type {
  BannerProps as ReferenceBannerProps,
  EmptyStateProps as ReferenceEmptyStateProps,
  ErrorStateProps as ReferenceErrorStateProps,
  InlineAlertProps as ReferenceInlineAlertProps,
  RefusalNoticeProps as ReferenceRefusalNoticeProps,
  ToastProps as ReferenceToastProps,
  UndoToastProps as ReferenceUndoToastProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";

export type EmptyStateProps = ReferenceEmptyStateProps;
export type ErrorStateProps = ReferenceErrorStateProps;
export type RefusalNoticeProps = ReferenceRefusalNoticeProps;
export type InlineAlertProps = ReferenceInlineAlertProps;
export type BannerProps = ReferenceBannerProps;
export type ToastProps = ReferenceToastProps;
export type UndoToastProps = ReferenceUndoToastProps & {
  /** Called once when the countdown ends without an undo. */
  onExpire?: () => void;
};

type Tone = "info" | "success" | "warning" | "danger";

const TONE_ICON: Record<Tone, string> = {
  info: "Info",
  success: "CircleCheck",
  warning: "TriangleAlert",
  danger: "OctagonAlert",
};

const TONE_ICON_CLASS: Record<Tone, string> = {
  info: cx("text-state-scheduled"),
  success: cx("text-success"),
  warning: cx("text-warning"),
  danger: cx("text-danger"),
};

const alertClass = cx(
  "flex gap-8 p-12 max-w-(--ui-alert) rounded-card border border-border-subtle bg-bg-surface",
  "forced-colors:border-[CanvasText]",
);

const stateClass = cx(
  "flex flex-col items-center gap-12 p-40 max-w-(--ui-empty) text-center rounded-card",
  "border border-dashed border-border-strong",
);

/** One sentence and one button: "No shifts yet. Post a crew call." */
export function EmptyState({
  sentence,
  actionLabel,
  icon,
  shortcut,
  onAction,
}: EmptyStateProps): ReactElement {
  return (
    <div className={stateClass}>
      {icon ? (
        <span className="text-text-tertiary">
          <Icon name={icon} size={24} />
        </span>
      ) : null}
      <p className="m-0 text-text-14 text-text-secondary">{sentence}</p>
      <Button variant="primary" onClick={onAction} {...(shortcut ? { shortcut } : {})}>
        {actionLabel}
      </Button>
    </div>
  );
}

/** A failed load: what happened, a retry and the reference to quote to support. */
export function ErrorState({
  title,
  sentence,
  actionLabel,
  reference,
  onRetry,
}: ErrorStateProps): ReactElement {
  const t = useT();
  return (
    <div className={stateClass} role="alert">
      <span className="text-danger">
        <Icon name="CircleAlert" size={24} />
      </span>
      <strong className="text-heading-16 font-semibold">{title}</strong>
      <p className="m-0 text-text-14 text-text-secondary">{sentence}</p>
      <Button variant="primary" icon="RefreshCw" onClick={onRetry}>
        {actionLabel ?? t("action.retry")}
      </Button>
      {reference ? (
        <span className="font-mono text-text-12 text-text-secondary">{reference}</span>
      ) : null}
    </div>
  );
}

/** A refusal (NO_ANSWER, UNRATIFIED or REFUSE) with its reason, never an empty or invented answer. */
export function RefusalNotice({
  outcome,
  title,
  reason,
  actionLabel,
  onAction,
}: RefusalNoticeProps): ReactElement {
  return (
    <div className={cx(alertClass, "border-dashed")} role="status">
      <span className="text-text-secondary">
        <Icon name="info" />
      </span>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-6">
          <span className="px-4 rounded-chip border border-border-strong font-mono text-text-11 font-medium tracking-wide text-text-primary">
            {outcome}
          </span>
          <span className="font-semibold">{title}</span>
        </div>
        <div className="text-text-secondary">{reason}</div>
        {actionLabel ? (
          <div>
            <Button size="sm" onClick={onAction}>
              {actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** An inline message in context; danger is announced as an alert, the rest as status. */
export function InlineAlert({ tone = "info", title, children }: InlineAlertProps): ReactElement {
  return (
    <div className={alertClass} role={tone === "danger" ? "alert" : "status"}>
      <span className={TONE_ICON_CLASS[tone]}>
        <Icon name={TONE_ICON[tone]} />
      </span>
      <div className="flex flex-col gap-2">
        {title ? <div className="font-semibold">{title}</div> : null}
        <div className="text-text-secondary">{children}</div>
      </div>
    </div>
  );
}

/** A page-wide condition across the top of a page; at most one per page. */
export function Banner({
  tone = "info",
  icon,
  children,
  actionLabel,
  onAction,
  onDismiss,
}: BannerProps): ReactElement {
  const t = useT();
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "flex items-center gap-8 px-12 py-8 bg-bg-surface border-b border-border-subtle print:hidden",
        tone === "warning" && "border-s-stroke-accent border-s-warning",
        tone === "danger" && "border-s-stroke-accent border-s-danger",
      )}
    >
      <span className={TONE_ICON_CLASS[tone]}>
        <Icon name={icon ?? TONE_ICON[tone]} />
      </span>
      <span className="flex-1">{children}</span>
      {actionLabel ? (
        <Button size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
      {onDismiss ? <IconButton icon="X" label={t("action.dismiss")} onClick={onDismiss} /> : null}
    </div>
  );
}

const toastClass = cx(
  "xos-anim-fade relative inline-flex items-center gap-12 overflow-hidden py-8 ps-12 pe-8",
  "rounded-card bg-bg-raised shadow-menu print:hidden forced-colors:border",
);

/** Confirms a completed action, with an optional action and its shortcut. Announced politely. */
export function Toast({
  message,
  actionLabel,
  actionIcon,
  shortcut,
  onAction,
}: ToastProps): ReactElement {
  return (
    <div className={toastClass} role="status">
      <span>{message}</span>
      {actionLabel ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={onAction}
          {...(actionIcon ? { icon: actionIcon } : {})}
          {...(shortcut ? { shortcut } : {})}
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Replaces a confirmation for a reversible action: 8 seconds with a visible timer, Undo on the
 * button and on Cmd or Ctrl+Z.
 */
export function UndoToast({
  message,
  seconds = 8,
  onUndo,
  onExpire,
}: UndoToastProps): ReactElement {
  const t = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return undefined;
    const timer = setTimeout(() => {
      setDone(true);
      onExpire?.();
    }, seconds * 1000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setDone(true);
        onUndo?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [done, seconds, onUndo, onExpire]);
  return (
    <div className={toastClass} role="status">
      <span>{message}</span>
      <Button
        size="sm"
        variant="ghost"
        icon="Undo2"
        shortcut="⌘Z"
        disabled={done}
        onClick={() => {
          setDone(true);
          onUndo?.();
        }}
      >
        {t("action.undo")}
      </Button>
      <span
        aria-hidden="true"
        className="xos-anim-drain absolute start-0 bottom-0 h-(--stroke-width-focus) w-full bg-accent"
        style={{ "--xos-seconds": seconds } as CSSProperties}
      />
    </div>
  );
}

/** A polite live region that stacks toasts at the bottom of the viewport. */
export function ToastRegion({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      aria-label={label}
      className="fixed bottom-16 end-16 z-toast flex flex-col items-end gap-8 max-w-[calc(100vw-var(--space-32))]"
    >
      {children}
    </section>
  );
}
