import { type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { StateChip } from "../Chips/Chips.tsx";
import { compassText } from "./Compass.shared.tsx";
import { type ShiftCardProps } from "./Compass.types.ts";

function Fact({ icon, children }: { icon: string; children: ReactNode }): ReactElement {
  return (
    <span className="flex items-center gap-6">
      <Icon name={icon} size={16} className="text-text-secondary" />
      {children}
    </span>
  );
}

/** A shift with its state, countdown, role, date, time and place, and up to two actions. */
export function ShiftCard({
  state,
  stateLabel,
  countdown,
  role,
  date,
  time,
  place,
  actions,
}: ShiftCardProps): ReactElement {
  return (
    <article
      className={cx(
        "xos-compass flex flex-col gap-12 w-(--ui-compass-card) max-w-full box-border p-16",
        "bg-bg-raised border border-border-subtle rounded-dialog forced-colors:border-[CanvasText]",
        compassText,
      )}
    >
      <header className="flex items-center justify-between gap-8">
        <StateChip state={state} label={stateLabel} />
        {countdown ? <span className="text-text-secondary tabular-nums">{countdown}</span> : null}
      </header>
      <strong className="text-heading-16 font-semibold">{role}</strong>
      <div className="flex flex-col gap-6">
        <Fact icon="Calendar">{date}</Fact>
        <Fact icon="Clock">
          <span className="tabular-nums">{time}</span>
        </Fact>
        <Fact icon="MapPin">{place}</Fact>
      </div>
      {actions ? (
        <footer className="flex items-center gap-8 *:flex-1 *:justify-center *:min-h-touch-min">
          {actions}
        </footer>
      ) : null}
    </article>
  );
}
