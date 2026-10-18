import { useContext, type ReactElement } from "react";
import { Button } from "../Button/Button.tsx";
import { InToastRegion, toastClass } from "./Feedback.shared.tsx";
import { type ToastProps } from "./Feedback.types.ts";

/** Confirms a completed action, with an optional action and its shortcut. Announced politely. */
export function Toast({
  message,
  actionLabel,
  actionIcon,
  shortcut,
  onAction,
}: ToastProps): ReactElement {
  const inRegion = useContext(InToastRegion);
  return (
    <div className={toastClass} {...(inRegion ? {} : { role: "status" })}>
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
