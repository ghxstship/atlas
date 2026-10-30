import {
  Children,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { Direction } from "radix-ui";
import {
  type DashboardResize,
  type DashboardSpans,
  type DashboardTile,
  type TemplateDashboardProps,
} from "./Templates.types.ts";

/** Columns of the dashboard grid (Section 11.6). */
const COLUMNS = 12;
const MIN_SPAN = 3;

/** A span kept inside the grid: whole columns from the tile's minimum to the full width. */
export function clampSpan(span: number, min: number = MIN_SPAN): number {
  const floor = Math.max(1, Math.min(COLUMNS, Math.round(min)));
  if (!Number.isFinite(span)) return floor;
  return Math.max(floor, Math.min(COLUMNS, Math.round(span)));
}

/** Every tile's span: the saved one when there is one, else its default, each kept inside the grid. */
export function spansOf(
  tiles: readonly DashboardTile[],
  saved: DashboardSpans = {},
): Record<string, number> {
  return Object.fromEntries(
    tiles.map((t) => [t.id, clampSpan(saved[t.id] ?? t.span, t.minSpan ?? MIN_SPAN)]),
  );
}

/**
 * The handle on a tile's inline end: a vertical separator whose value is the span. Arrow keys change
 * it by one column, Home and End jump to the limits, and a drag snaps to whole columns.
 */
function ResizeHandle({
  tile,
  span,
  resize,
  onSpan,
  onDone,
}: {
  tile: DashboardTile;
  span: number;
  resize: DashboardResize;
  onSpan: (span: number) => void;
  onDone: () => void;
}): ReactElement {
  const dir = Direction.useDirection();
  const min = clampSpan(tile.minSpan ?? MIN_SPAN, 1);
  const growKey = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
  const shrinkKey = growKey === "ArrowRight" ? "ArrowLeft" : "ArrowRight";

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === growKey
        ? span + 1
        : e.key === shrinkKey
          ? span - 1
          : e.key === "Home"
            ? min
            : e.key === "End"
              ? COLUMNS
              : null;
    if (next === null) return;
    e.preventDefault();
    const clamped = clampSpan(next, min);
    if (clamped === span) return;
    onSpan(clamped);
    onDone();
  };

  const pointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const grid = e.currentTarget.parentElement?.parentElement;
    if (!grid) return;
    e.preventDefault();
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    // One grid unit: a column and the gap after it.
    const unit = (grid.clientWidth - (COLUMNS - 1) * gap) / COLUMNS + gap;
    const start = e.clientX;
    const startSpan = span;
    const sign = dir === "rtl" ? -1 : 1;
    let last = span;
    const move = (ev: PointerEvent) => {
      if (unit <= 0) return;
      const next = clampSpan(startSpan + (sign * (ev.clientX - start)) / unit, min);
      if (next !== last) {
        last = next;
        onSpan(next);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (last !== startSpan) onDone();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={resize.label(tile.label)}
      aria-valuenow={span}
      aria-valuemin={min}
      aria-valuemax={COLUMNS}
      aria-valuetext={resize.describe(tile.label, span)}
      tabIndex={0}
      onKeyDown={keyDown}
      onPointerDown={pointerDown}
      className="absolute inset-y-8 -end-6 w-(--ui-handle) rounded-full cursor-col-resize touch-none max-md:hidden hover:bg-accent focus-visible:bg-accent"
    />
  );
}

/**
 * Home, report dashboards and the partner console (Section 11.6): the header with the date range and
 * scope picker, then tiles on the 12-column grid. Each tile spans whole columns; with `resize`, a
 * person widens or narrows a tile by dragging its edge or with the arrow keys on its handle, a screen
 * reader hears the new span, and `resize.onChange` receives every span to save. Below md the grid is
 * one column, so the handles hide.
 */
export function TemplateDashboard({
  header,
  controls,
  tiles,
  spans,
  resize,
  label,
  children,
}: TemplateDashboardProps): ReactElement {
  // Spans changed here since the page rendered; they win over the saved ones until it renders again.
  const [own, setOwn] = useState<Record<string, number>>({});
  const [message, setMessage] = useState("");
  const current = useRef<Record<string, number>>({});
  const effective = tiles ? spansOf(tiles, { ...spans, ...own }) : {};
  current.current = effective;

  return (
    <div data-template="dashboard" className="flex flex-col gap-16 min-w-0">
      {controls ? (
        <div className="flex flex-wrap items-start justify-between gap-12">
          <div className="flex-1 min-w-0">{header}</div>
          <div className="flex flex-wrap items-center gap-8">{controls}</div>
        </div>
      ) : (
        header
      )}
      <div
        {...(label ? { role: "group", "aria-label": label } : {})}
        className="grid grid-cols-12 gap-(--layout-gutter-lg)"
      >
        {tiles?.map((tile) => {
          const span = effective[tile.id] ?? tile.span;
          return (
            <div
              key={tile.id}
              data-tile={tile.id}
              data-span={span}
              className="relative flex flex-col min-w-0 col-span-12 md:col-span-(--tile-span) *:flex-1"
              style={{ "--tile-span": span } as CSSProperties}
            >
              {tile.content}
              {resize ? (
                <ResizeHandle
                  tile={tile}
                  span={span}
                  resize={resize}
                  onSpan={(next) => {
                    current.current = { ...current.current, [tile.id]: next };
                    setOwn((old) => ({ ...old, [tile.id]: next }));
                    setMessage(resize.describe(tile.label, next));
                  }}
                  onDone={() => resize.onChange({ ...current.current })}
                />
              ) : null}
            </div>
          );
        })}
        {Children.map(children, (child) => (
          <div className="min-w-0 col-span-12 md:col-span-6 lg:col-span-4">{child}</div>
        ))}
      </div>
      {resize ? (
        <span aria-live="polite" className="sr-only">
          {message}
        </span>
      ) : null}
    </div>
  );
}
