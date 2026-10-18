import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { type OfflineBannerProps } from "./Compass.types.ts";

/** Offline state with the count of queued writes (Section 13). */
export function OfflineBanner({ message, queued, onView }: OfflineBannerProps): ReactElement {
  const t = useT();
  return (
    <div
      role="status"
      className={cx(
        "xos-compass flex items-center gap-8 w-(--ui-tabbar) max-w-full box-border px-12 py-8",
        "bg-bg-surface border border-warning rounded-card text-text-14 text-text-primary",
      )}
    >
      <Icon name="WifiOff" size={16} className="text-warning" />
      <span className="flex-1">{message}</span>
      <span className="inline-flex items-center h-(--ui-chip) px-6 rounded-chip bg-bg-hover text-text-12 font-medium tabular-nums">
        {t("offline.queued", { n: queued })}
      </span>
      {onView ? (
        <Button size="sm" variant="ghost" onClick={onView}>
          {t("action.view")}
        </Button>
      ) : null}
    </div>
  );
}
