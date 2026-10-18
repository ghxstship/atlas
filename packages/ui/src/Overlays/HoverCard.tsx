import { type ReactElement } from "react";
import { HoverCard as RHoverCard } from "radix-ui";
import type { HoverCardProps as ReferenceHoverCardProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { PropertyChip, StateChip } from "../Chips/Chips.tsx";
import { type HoverCardProps } from "./Overlays.types.ts";
import { popoverPanelClass } from "./popoverPanelClass.tsx";

function HoverCardBody({
  recordKey,
  kind,
  title,
  state,
  stateLabel,
  owner,
  next,
}: ReferenceHoverCardProps) {
  return (
    <>
      <div className="flex items-center gap-6 text-text-secondary">
        <RecordKindGlyph kind={kind} size={14} />
        <span className="font-mono text-text-12">{recordKey}</span>
      </div>
      <strong className="font-semibold">{title}</strong>
      <div className="flex flex-wrap items-center gap-8">
        <StateChip state={state} label={stateLabel} />
        <PropertyChip icon="User" value={owner} />
        <PropertyChip icon="Calendar" value={next} />
      </div>
    </>
  );
}

const hoverCardClass = cx(
  popoverPanelClass,
  "flex flex-col gap-8 p-12 w-(--ui-hovercard) z-popover",
);

/** Previews a record after 400 ms on its key: title, state, owner and next date. */
export function HoverCard({ children, openDelay = 400, ...record }: HoverCardProps): ReactElement {
  if (children === undefined) {
    return (
      <div className={hoverCardClass}>
        <HoverCardBody {...record} />
      </div>
    );
  }
  return (
    <RHoverCard.Root openDelay={openDelay} closeDelay={100}>
      <RHoverCard.Trigger asChild>{children}</RHoverCard.Trigger>
      <RHoverCard.Portal>
        <RHoverCard.Content sideOffset={4} collisionPadding={16} className={hoverCardClass}>
          <HoverCardBody {...record} />
        </RHoverCard.Content>
      </RHoverCard.Portal>
    </RHoverCard.Root>
  );
}
