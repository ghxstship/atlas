import { useRef, useState, type ReactElement } from "react";
import { Tooltip as RTooltip } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { type TooltipProps } from "./Overlays.types.ts";

const tooltipClass = cx(
  "xos-anim-pop inline-flex items-center gap-6 px-8 py-4 rounded-control bg-bg-raised text-text-primary",
  "text-text-12 shadow-menu z-tooltip forced-colors:border",
);

/**
 * A control's label and shortcut after 500 ms of hover, on focus, or on a 500 ms long press. Never
 * holds interactive content.
 */
export function Tooltip({
  label,
  shortcut,
  children,
  side = "top",
  delay = 500,
}: TooltipProps): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const content = (
    <>
      <span>{label}</span>
      {shortcut ? <Keys keys={shortcut} /> : null}
    </>
  );
  if (children === undefined) {
    return (
      <span role="tooltip" className={tooltipClass}>
        {content}
      </span>
    );
  }
  const endPress = () => {
    if (press.current !== null) clearTimeout(press.current);
    press.current = null;
  };
  return (
    <RTooltip.Provider delayDuration={delay}>
      <RTooltip.Root open={open} onOpenChange={setOpen}>
        <RTooltip.Trigger
          asChild
          onPointerDown={(e) => {
            if (e.pointerType !== "touch") return;
            endPress();
            press.current = setTimeout(() => setOpen(true), delay);
          }}
          onPointerUp={endPress}
          onPointerCancel={endPress}
        >
          {children}
        </RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content
            side={side}
            sideOffset={6}
            collisionPadding={16}
            className={tooltipClass}
            aria-label={shortcut ? t("tooltip.withShortcut", { label, shortcut }) : label}
          >
            {content}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}
