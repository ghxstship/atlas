import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { SegmentedControl } from "../Navigation/Navigation.tsx";
import { type OpportunityFiltersProps } from "./Gateway.types.ts";

/** Search, filter chips and the cards or map view. */
export function OpportunityFilters({
  placeholder: hint,
  chips,
  active = [],
  onSearch,
  onChipsChange,
  onViewChange,
}: OpportunityFiltersProps): ReactElement {
  const t = useT();
  const [on, setOn] = useState(active);
  return (
    <div role="group" aria-label={t("filter.label")} className="flex flex-wrap items-center gap-8">
      <label className="flex items-center gap-8 w-(--ui-skeleton-inline) min-w-0 grow h-row-default ps-12 pe-8 rounded-control border border-border-control bg-bg-surface focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring">
        <Icon name="Search" color="var(--color-text-secondary)" />
        <input
          aria-label={t("opp.search")}
          placeholder={hint}
          onChange={(e) => onSearch?.(e.target.value)}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse"
        />
      </label>
      {chips.map((chip) => {
        const pressed = on.includes(chip);
        return (
          <button
            key={chip}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              const next = pressed ? on.filter((c) => c !== chip) : [...on, chip];
              setOn(next);
              onChipsChange?.(next);
            }}
            className={cx(
              "inline-flex items-center gap-4 h-control-md px-12 rounded-pill border border-border-control bg-transparent cursor-pointer",
              "font-medium text-text-13 text-text-secondary pointer-coarse:min-h-target-coarse",
              "aria-pressed:bg-text-primary aria-pressed:text-bg-canvas aria-pressed:border-text-primary",
            )}
          >
            {pressed ? <Icon name="Check" size={12} /> : null}
            {chip}
          </button>
        );
      })}
      <SegmentedControl
        label={t("view.label")}
        value="cards"
        onChange={(v) => onViewChange?.(v === "map" ? "map" : "cards")}
        options={[
          { value: "cards", label: t("view.cards"), icon: "LayoutGrid" },
          { value: "map", label: t("view.map"), icon: "Map" },
        ]}
      />
    </div>
  );
}
