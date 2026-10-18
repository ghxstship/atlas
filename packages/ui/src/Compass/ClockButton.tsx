import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { compassText } from "./Compass.shared.tsx";
import { type ClockButtonProps } from "./Compass.types.ts";

const CLOCK_STATE: Record<NonNullable<ClockButtonProps["state"]>, string> = {
  out: "bg-accent text-accent-text-on",
  on: "bg-bg-raised text-text-primary ring-(length:--stroke-width-focus) ring-inset ring-success",
  break:
    "bg-bg-raised text-text-primary ring-(length:--stroke-width-focus) ring-inset ring-warning",
  blocked:
    "bg-bg-surface text-text-secondary ring-(length:--stroke-width-hairline) ring-inset ring-border-strong cursor-not-allowed",
};

/** The Today screen's one primary control; it changes with the person's state. */
export function ClockButton({
  state = "out",
  label,
  detail,
  timer,
  geofence,
  geofenceOk,
  onClick,
}: ClockButtonProps): ReactElement {
  const blocked = state === "blocked";
  return (
    <div
      className={cx(
        "xos-compass flex flex-col items-stretch gap-8 w-(--ui-compass-card) max-w-full",
        compassText,
      )}
    >
      {geofence ? (
        <span className="inline-flex items-center gap-6 text-text-14 text-text-secondary">
          <Icon name="MapPin" size={16} className={geofenceOk ? "text-success" : "text-warning"} />
          {geofence}
        </span>
      ) : null}
      <button
        type="button"
        aria-disabled={blocked ? true : undefined}
        onClick={blocked ? undefined : onClick}
        className={cx(
          "flex flex-col items-center justify-center gap-4 w-full min-h-(--ui-compass-thumb) p-16 border-0 rounded-dialog",
          "text-heading-20 font-semibold cursor-pointer",
          "focus-visible:outline-stroke-focus focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          CLOCK_STATE[state],
        )}
      >
        {timer ? <span className="text-heading-32 tabular-nums">{timer}</span> : null}
        <span>{label}</span>
        {detail ? <small className="text-text-14 font-regular">{detail}</small> : null}
      </button>
    </div>
  );
}
