import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { stateClass } from "./Feedback.shared.tsx";
import { type ErrorStateProps } from "./Feedback.types.ts";

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
