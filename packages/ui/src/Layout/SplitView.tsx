import { useRef, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { rovingIndex, useControllable } from "../lib/hooks.ts";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { type SplitViewProps } from "./Layout.types.ts";

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
