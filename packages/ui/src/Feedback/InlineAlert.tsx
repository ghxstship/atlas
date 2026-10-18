import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { TONE_ICON, TONE_ICON_CLASS, alertClass } from "./Feedback.shared.tsx";
import { type InlineAlertProps } from "./Feedback.types.ts";

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
