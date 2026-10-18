import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { alertClass } from "./Feedback.shared.tsx";
import { type RefusalNoticeProps } from "./Feedback.types.ts";

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
