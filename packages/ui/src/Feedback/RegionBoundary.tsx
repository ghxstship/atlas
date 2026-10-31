import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { TONE_ICON, TONE_ICON_CLASS, alertClass } from "./Feedback.shared.tsx";

export interface RegionBoundaryProps {
  children: ReactNode;
  /** Replaces the default title ("This section did not load"), for example with the tile's name. */
  title?: string;
  /** Called once per caught error, for the app's error reporting. Pass-through errors are not reported. */
  onError?: (error: unknown, info: ErrorInfo) => void;
  /**
   * Retry calls this with `reset`, so the app can fetch the region again and clear the error in one
   * step (a router refresh and `reset` in one transition). Without it, Retry calls `reset` alone.
   */
  onRetry?: (reset: () => void) => void;
  /**
   * Errors that are control flow, not failures (a framework's redirect or not found), which the
   * boundary throws on to the boundaries above it instead of showing Retry.
   */
  passThrough?: (error: unknown) => boolean;
  /** The error clears when this changes, such as the route's path after a navigation. */
  resetKey?: unknown;
}

interface State {
  failed: boolean;
  error: unknown;
  resetKey: unknown;
}

/**
 * One region of a page (a dashboard tile, a record panel, a peek section) that fails on its own: an
 * error thrown while it renders replaces the region with a short alert and Retry, reported through
 * `onError`, and the rest of the page keeps working. Retry renders the region again.
 */
export class RegionBoundary extends Component<RegionBoundaryProps, State> {
  override state: State = { failed: false, error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: RegionBoundaryProps, state: State): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { failed: false, error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (this.props.passThrough?.(error)) return;
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ failed: false, error: null });
  };

  retry = (): void => {
    if (this.props.onRetry) this.props.onRetry(this.reset);
    else this.reset();
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // Thrown from render, so the nearest boundary above this one catches it.
    if (this.props.passThrough?.(this.state.error)) throw this.state.error;
    return (
      <RegionError
        {...(this.props.title ? { title: this.props.title } : {})}
        onRetry={this.retry}
      />
    );
  }
}

/** What a failed region shows: the danger icon, what happened, that the page still works, and Retry. */
export function RegionError({
  title,
  onRetry,
}: {
  title?: string;
  onRetry: () => void;
}): ReactElement {
  const t = useT();
  return (
    <div className={alertClass} role="alert">
      <span className={TONE_ICON_CLASS.danger}>
        <Icon name={TONE_ICON.danger} />
      </span>
      <div className="flex flex-col items-start gap-8">
        <div className="flex flex-col gap-2">
          <div className="font-semibold">{title ?? t("region.title")}</div>
          <div className="text-text-secondary">{t("region.body")}</div>
        </div>
        <Button size="sm" icon="RefreshCw" onClick={onRetry}>
          {t("action.retry")}
        </Button>
      </div>
    </div>
  );
}
