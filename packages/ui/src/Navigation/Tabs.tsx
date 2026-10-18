import { useId, useRef, type ReactElement } from "react";
import { Direction } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { rovingIndex, useControllable } from "../lib/hooks.ts";
import { type TabsProps } from "./Navigation.types.ts";

/** Switches between sections of one object. Arrow keys move and select, Home and End jump. */
export function Tabs({ label, value, tabs, onChange, panels }: TabsProps): ReactElement {
  const base = useId().replace(/:/g, "");
  const dir = Direction.useDirection();
  const [current, setCurrent] = useControllable<string>(
    undefined,
    value ?? tabs[0]?.value ?? "",
    onChange,
  );
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-16 max-w-full overflow-x-auto border-b border-border-subtle [scrollbar-width:none]"
      >
        {tabs.map((tab, i) => {
          const selected = tab.value === current;
          return (
            <button
              key={tab.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${i}`}
              aria-selected={selected}
              aria-controls={panels ? `${base}-panel-${i}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setCurrent(tab.value)}
              onKeyDown={(e) => {
                const next = rovingIndex(e.key, i, tabs.length, "horizontal", dir);
                if (next === null) return;
                e.preventDefault();
                const target = tabs[next];
                if (target) setCurrent(target.value);
                refs.current[next]?.focus();
              }}
              className={cx(
                "relative inline-flex flex-none items-center gap-6 py-8 bg-transparent border-0 whitespace-nowrap cursor-pointer",
                "font-medium text-text-13 text-text-secondary aria-selected:text-text-primary",
                "after:absolute after:inset-x-0 after:-bottom-(--stroke-width-hairline) after:h-(--stroke-width-focus) after:bg-transparent aria-selected:after:bg-accent",
                "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
              )}
            >
              {tab.label}
              {tab.count !== undefined ? (
                <span className="text-text-12 text-text-tertiary tabular-nums">{tab.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {panels
        ? tabs.map((tab, i) => (
            <div
              key={tab.value}
              role="tabpanel"
              id={`${base}-panel-${i}`}
              aria-labelledby={`${base}-tab-${i}`}
              hidden={tab.value !== current}
              tabIndex={0}
              className="pt-16"
            >
              {panels[tab.value]}
            </div>
          ))
        : null}
    </div>
  );
}
