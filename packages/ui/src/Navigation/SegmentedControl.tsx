import { useRef, type KeyboardEvent, type ReactElement } from "react";
import { Direction } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { rovingIndex, useControllable } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type SegmentedControlProps } from "./Navigation.types.ts";

/**
 * Two to five peer options, such as the view switcher. Arrow keys, Home and End move focus; Enter,
 * Space or a click turns a segment on; one segment is always on. It keeps the markup Radix's
 * single toggle group rendered (a radiogroup of radio buttons with `data-state`) without the
 * toggle group, roving focus and collection code, about 4 KB gzip on every page with a view
 * switcher (gate 10).
 */
export function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps): ReactElement {
  const dir = Direction.useDirection();
  const [current, setCurrent] = useControllable<string>(
    undefined,
    value ?? options[0]?.value ?? "",
    onChange,
  );
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // The tab stop is the segment that is on, or the first one when none matches.
  const stop = Math.max(
    0,
    options.findIndex((o) => o.value === current),
  );
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const key =
      event.key === "ArrowDown"
        ? dir === "rtl"
          ? "ArrowLeft"
          : "ArrowRight"
        : event.key === "ArrowUp"
          ? dir === "rtl"
            ? "ArrowRight"
            : "ArrowLeft"
          : event.key;
    const next = rovingIndex(key, index, options.length, "horizontal", dir);
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      dir={dir}
      className="inline-flex self-start max-w-full gap-2 p-2 rounded-control border border-border-control bg-bg-surface"
    >
      {options.map((o, i) => {
        const on = o.value === current;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            data-state={on ? "on" : "off"}
            tabIndex={i === stop ? 0 : -1}
            onClick={() => {
              if (!on) setCurrent(o.value);
            }}
            onKeyDown={(event) => move(event, i)}
            className={cx(
              "inline-flex items-center gap-4 h-control-sm px-8 rounded-chip border-0 bg-transparent cursor-pointer",
              "font-medium text-text-12 text-text-secondary",
              "data-[state=on]:bg-bg-hover data-[state=on]:text-text-primary data-[state=on]:ring-(length:--stroke-width-hairline) data-[state=on]:ring-border-strong",
              "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
            )}
          >
            {o.icon ? <Icon name={o.icon} size={14} /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
