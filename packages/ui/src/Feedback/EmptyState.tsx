import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { stateClass } from "./Feedback.shared.tsx";
import { type EmptyStateProps } from "./Feedback.types.ts";

/**
 * One sentence and one button: "No shifts yet. Post a crew call." The button is secondary when the
 * page header already holds the primary action (actionVariant), so a screen has one primary.
 */
export function EmptyState({
  sentence,
  actionLabel,
  icon,
  shortcut,
  onAction,
  actionVariant = "primary",
}: EmptyStateProps): ReactElement {
  return (
    <div className={stateClass}>
      {icon ? (
        <span className="text-text-tertiary">
          <Icon name={icon} size={24} />
        </span>
      ) : null}
      <p className="m-0 text-text-14 text-text-secondary">{sentence}</p>
      <Button variant={actionVariant} onClick={onAction} {...(shortcut ? { shortcut } : {})}>
        {actionLabel}
      </Button>
    </div>
  );
}
