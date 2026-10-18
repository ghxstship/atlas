import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { TONE_ICON, TONE_ICON_CLASS } from "./Feedback.shared.tsx";
import { type BannerProps } from "./Feedback.types.ts";

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
