import { useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { Direction } from "radix-ui";
import { useT } from "../lib/context.tsx";
import { type ResizablePanelProps } from "./Layout.types.ts";

/**
 * A panel resizable by pointer or arrow keys within its limits; the handle is a vertical separator
 * with its value. Home and End jump to the limits.
 */
export function ResizablePanel({
  initial,
  min,
  max,
  side = "right",
  label,
  children,
  onResize,
  step = 16,
}: ResizablePanelProps): ReactElement {
  const t = useT();
  const dir = Direction.useDirection();
  const [width, setWidthState] = useState(initial);
  const setWidth = (next: number) => {
    const clamped = Math.max(min, Math.min(max, next));
    setWidthState(clamped);
    onResize?.(clamped);
  };
  // The handle sits on the inline end for side "right"; dragging toward the reading direction grows it.
  const growKey = (side === "left") !== (dir === "rtl") ? "ArrowLeft" : "ArrowRight";
  const shrinkKey = growKey === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = e.clientX;
    const startWidth = width;
    const sign = growKey === "ArrowRight" ? 1 : -1;
    const move = (ev: PointerEvent) => setWidth(startWidth + sign * (ev.clientX - start));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={label ?? t("panel.resize")}
      tabIndex={0}
      onPointerDown={down}
      onKeyDown={(e) => {
        const next =
          e.key === growKey
            ? width + step
            : e.key === shrinkKey
              ? width - step
              : e.key === "Home"
                ? min
                : e.key === "End"
                  ? max
                  : null;
        if (next === null) return;
        e.preventDefault();
        setWidth(next);
      }}
      className="flex-none w-(--ui-handle) cursor-col-resize touch-none border-s border-border-subtle hover:bg-accent focus-visible:bg-accent"
    />
  );
  return (
    <div
      className="relative flex min-h-(--ui-resizable-min) bg-bg-surface border border-border-subtle rounded-card max-w-full"
      style={{ inlineSize: width }}
    >
      {side === "left" ? handle : null}
      <div className="flex-1 min-w-0 p-16 overflow-hidden">{children}</div>
      {side === "left" ? null : handle}
    </div>
  );
}
