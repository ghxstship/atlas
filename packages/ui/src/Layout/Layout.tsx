import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type ReactElement,
  type ReactNode,
} from "react";
import { Direction } from "radix-ui";
import type {
  AppShellProps as ReferenceAppShellProps,
  PageHeaderProps as ReferencePageHeaderProps,
  ResizablePanelProps as ReferenceResizablePanelProps,
  ScrollRegionProps as ReferenceScrollRegionProps,
  SplitViewProps as ReferenceSplitViewProps,
  StepperProps as ReferenceStepperProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { rovingIndex, useControllable } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";

export type AppShellProps = ReferenceAppShellProps & {
  /** The phone bottom bar (TabBar), shown below md. */
  mobileNav?: ReactNode;
};
export type PageHeaderProps = ReferencePageHeaderProps;
export type ResizablePanelProps = ReferenceResizablePanelProps & {
  onResize?: (width: number) => void;
  /** Keyboard step in pixels; 16 by default. */
  step?: number;
};
export type ScrollRegionProps = ReferenceScrollRegionProps & {
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
};
export type SplitViewProps = ReferenceSplitViewProps & {
  onSelect?: (index: number) => void;
};
export type StepperProps = ReferenceStepperProps;

/**
 * Brand slot, sidebar, header and content for every Atlas page. Below lg the sidebar becomes a drawer
 * opened from the header menu button and closed by Esc or the scrim; below md the bottom bar shows.
 */
export function AppShell({
  brand,
  sidebar,
  header,
  children,
  mobileNav,
}: AppShellProps): ReactElement {
  const t = useT();
  const sideId = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div
      data-open={open ? "true" : undefined}
      className={cx(
        "group/shell relative grid grid-cols-[var(--layout-sidebar)_minmax(0,1fr)] max-lg:grid-cols-[minmax(0,1fr)]",
        "min-h-(--ui-shell-min) h-full overflow-hidden bg-bg-canvas print:block",
      )}
    >
      <div
        id={sideId}
        className={cx(
          "flex flex-col gap-4 min-h-0 p-8 overflow-y-auto bg-bg-surface border-e border-border-subtle [&>*]:shrink-0",
          "[&_nav]:border-0 [&_nav]:p-0 [&_nav]:w-auto print:hidden",
          "max-lg:hidden max-lg:group-data-[open=true]/shell:flex max-lg:group-data-[open=true]/shell:absolute",
          "max-lg:inset-y-0 max-lg:start-0 max-lg:z-sidebar max-lg:w-[min(var(--layout-sidebar),85%)] max-lg:shadow-dialog",
        )}
      >
        {brand ? <div className="px-8 pt-4 pb-8">{brand}</div> : null}
        {sidebar}
      </div>
      {open ? (
        <button
          type="button"
          aria-label={t("action.close")}
          onClick={() => setOpen(false)}
          className={cx(
            "hidden max-lg:block absolute inset-0 z-[calc(var(--z-sidebar)-1)] p-0 border-0 cursor-pointer",
            "bg-scrim opacity-scrim-dark in-data-[theme=light]:opacity-scrim-light in-data-[theme=sunlight]:opacity-scrim-light",
          )}
        />
      ) : null}
      <main className="flex flex-col min-w-0 min-h-0">
        <div
          className={cx(
            "flex items-center justify-between gap-8 h-(--ui-shell-head) px-16 border-b border-border-subtle",
            "max-lg:justify-start",
            !header && "hidden max-lg:flex",
          )}
        >
          <span className="hidden max-lg:inline-flex">
            <button
              ref={menuButton}
              type="button"
              aria-label={t("shell.menu")}
              aria-expanded={open}
              aria-controls={sideId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center justify-center h-control-md min-w-control-md rounded-control border border-transparent bg-transparent text-text-secondary cursor-pointer hover:bg-bg-hover pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse"
            >
              <Icon name="Menu" />
            </button>
          </span>
          {header ? (
            <div className="flex flex-1 items-center justify-between gap-8 min-w-0">{header}</div>
          ) : null}
        </div>
        <div className="flex flex-col gap-16 min-h-0 px-24 py-16 max-lg:p-16 overflow-y-auto [&>*]:shrink-0">
          {children}
        </div>
        {mobileNav ? (
          <div className="hidden max-md:block sticky bottom-0 [&_nav]:w-full print:hidden">
            {mobileNav}
          </div>
        ) : null}
      </main>
    </div>
  );
}

/** Title, count, view switcher and the one primary action of a collection. */
export function PageHeader({ title, glyph, count, views, actions }: PageHeaderProps): ReactElement {
  return (
    <header className="flex flex-wrap items-center justify-between gap-12 pb-12 border-b border-border-subtle">
      <div className="flex items-center gap-8 min-w-0">
        {glyph ? <Icon name={glyph} color="var(--color-text-secondary)" /> : null}
        <h1 className="m-0 text-heading-16 font-semibold">{title}</h1>
        {count !== undefined ? (
          <span className="text-text-secondary tabular-nums">{count}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-8 print:hidden">
        {views}
        {actions}
      </div>
    </header>
  );
}

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

/**
 * Keeps wide content inside the page width: it scrolls horizontally in a labeled region that joins
 * the tab order only while it overflows.
 */
export function ScrollRegion({
  label,
  children,
  className,
  style,
  ref: outer,
}: ScrollRegionProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const setRef = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (typeof outer === "function") outer(el);
    else if (outer) outer.current = el;
  };
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={setRef}
      role="region"
      aria-label={label}
      tabIndex={overflows ? 0 : undefined}
      style={style}
      className={cx("relative max-w-full overflow-x-auto overscroll-x-contain", className)}
    >
      {children}
    </div>
  );
}

/** Wizard progress: done steps show a check, the current step is marked for assistive technology. */
export function Stepper({ steps, current }: StepperProps): ReactElement {
  return (
    <ol className="flex flex-wrap items-center gap-8 m-0 p-0 list-none">
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li
            key={step}
            aria-current={state === "current" ? "step" : undefined}
            className={cx(
              "flex items-center gap-6 text-text-secondary",
              "[&+&]:before:w-(--ui-step-line) [&+&]:before:h-(--stroke-width-hairline) [&+&]:before:bg-border-strong [&+&]:before:me-2",
              state === "current" && "text-text-primary font-medium",
            )}
          >
            <span
              className={cx(
                "inline-grid place-items-center flex-none size-icon-20 rounded-full text-text-11 font-semibold tabular-nums",
                state === "todo" &&
                  "ring-(length:--stroke-width-hairline) ring-inset ring-border-strong",
                state === "current" && "bg-accent text-accent-text-on",
                state === "done" && "bg-bg-hover text-success",
              )}
            >
              {state === "done" ? <Icon name="Check" size={12} /> : i + 1}
            </span>
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A list beside the selected record (Inbox, Dispatch, Advancing). The list is a listbox: arrow keys
 * move, Home and End jump, Enter or Space selects.
 */
export function SplitView({
  label,
  selected,
  items,
  detail,
  onSelect,
}: SplitViewProps): ReactElement {
  const [current, setCurrent] = useControllable<number>(undefined, selected, onSelect);
  const [focused, setFocused] = useState(selected);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  return (
    <div
      className={cx(
        "grid grid-cols-[var(--ui-split-list)_minmax(0,1fr)] max-lg:grid-cols-[minmax(0,1fr)]",
        "min-h-(--ui-split-min) overflow-hidden rounded-card border border-border-subtle",
      )}
    >
      <div
        role="listbox"
        aria-label={label}
        className="bg-bg-surface border-e border-border-subtle max-lg:border-e-0 max-lg:border-b"
      >
        {items.map((item, i) => (
          <div
            key={`${item.title}-${i}`}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="option"
            aria-selected={i === current}
            tabIndex={i === focused ? 0 : -1}
            onClick={() => {
              setFocused(i);
              setCurrent(i);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setCurrent(i);
                return;
              }
              const next = rovingIndex(e.key, i, items.length, "vertical");
              if (next === null) return;
              e.preventDefault();
              setFocused(next);
              refs.current[next]?.focus();
            }}
            className={cx(
              "flex items-start gap-8 p-12 border-b border-border-subtle cursor-pointer",
              "aria-selected:bg-bg-hover hover:bg-bg-hover focus-visible:outline-offset-[calc(var(--stroke-width-focus)*-1)]",
            )}
          >
            {item.state ? (
              <span className="mt-2">
                <StateIcon state={item.state} />
              </span>
            ) : null}
            <div className="flex flex-col min-w-0">
              <strong className="font-medium truncate">{item.title}</strong>
              <span className="text-text-secondary">{item.meta}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="p-20 min-w-0">{detail}</div>
    </div>
  );
}
