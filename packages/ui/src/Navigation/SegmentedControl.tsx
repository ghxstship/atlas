import { type ReactElement } from "react";
import { ToggleGroup } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useControllable } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type SegmentedControlProps } from "./Navigation.types.ts";

/** Two to five peer options, such as the view switcher. Arrow keys move; one option is always on. */
export function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps): ReactElement {
  const [current, setCurrent] = useControllable<string>(
    undefined,
    value ?? options[0]?.value ?? "",
    onChange,
  );
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={current}
      onValueChange={(next) => {
        if (next) setCurrent(next);
      }}
      className="inline-flex self-start max-w-full gap-2 p-2 rounded-control border border-border-control bg-bg-surface"
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cx(
            "inline-flex items-center gap-4 h-control-sm px-8 rounded-chip border-0 bg-transparent cursor-pointer",
            "font-medium text-text-12 text-text-secondary",
            "data-[state=on]:bg-bg-hover data-[state=on]:text-text-primary data-[state=on]:ring-(length:--stroke-width-hairline) data-[state=on]:ring-border-strong",
            "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
          )}
        >
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
