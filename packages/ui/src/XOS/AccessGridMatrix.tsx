import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { useGridFocus } from "./XOS.shared.tsx";
import { type AccessGridMatrixProps } from "./XOS.types.ts";

const CAT: Record<number, string> = {
  1: cx("bg-viz-cat-1"),
  2: cx("bg-viz-cat-2"),
  3: cx("bg-viz-cat-3"),
  4: cx("bg-viz-cat-4"),
  5: cx("bg-viz-cat-5"),
  6: cx("bg-viz-cat-6"),
  7: cx("bg-viz-cat-7"),
};

/**
 * Which credential categories enter which zones; Compass validates scans against it offline. An
 * ARIA grid: arrows move, Space or Enter toggles a grant.
 */
export function AccessGridMatrix({
  label,
  zones,
  categories,
  grants,
  onChange,
}: AccessGridMatrixProps): ReactElement {
  const t = useT();
  const [granted, setGranted] = useState(grants);
  const grid = useGridFocus(categories.length, zones.length);
  const has = (cat: string, zone: string) => granted.includes(`${cat}|${zone}`);
  const toggle = (cat: string, zone: string) => {
    const key = `${cat}|${zone}`;
    const next = has(cat, zone) ? granted.filter((g) => g !== key) : [...granted, key];
    setGranted(next);
    onChange?.(next);
  };
  return (
    <ScrollRegion label={label}>
      <table
        role="grid"
        aria-label={label}
        className="border-separate border-spacing-2 text-text-12"
      >
        <caption className="pb-8 text-start text-text-13 font-semibold">{label}</caption>
        <thead>
          <tr>
            <th scope="col" className="p-4 text-start font-medium text-text-secondary">
              {t("access.credential")}
            </th>
            {zones.map((z) => (
              <th key={z} scope="col" className="p-4 font-medium text-text-secondary">
                {z}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((cat, ri) => (
            <tr key={cat.name}>
              <th scope="row" className="pe-12 text-start font-medium whitespace-nowrap">
                <span className="inline-flex items-center gap-6">
                  <span
                    aria-hidden="true"
                    className={cx(
                      "inline-block size-(--ui-switch-knob) rounded-mark",
                      CAT[cat.color],
                    )}
                  />
                  {cat.name}
                </span>
              </th>
              {zones.map((zone, ci) => {
                const on = has(cat.name, zone);
                return (
                  <td
                    key={zone}
                    ref={grid.register(ri, ci)}
                    role="gridcell"
                    aria-selected={on}
                    aria-label={t(on ? "access.allowed" : "access.denied", { cat: cat.name, zone })}
                    tabIndex={grid.tabIndex(ri, ci)}
                    onFocus={() => grid.setActive([ri, ci])}
                    onClick={() => toggle(cat.name, zone)}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        toggle(cat.name, zone);
                      } else grid.onKeyDown(e, ri, ci);
                    }}
                    className={cx(
                      "xos-hit w-(--space-40) h-control-md rounded-chip text-center cursor-pointer",
                      on
                        ? "bg-bg-hover text-success ring-(length:--stroke-width-hairline) ring-inset ring-success"
                        : "bg-bg-surface text-text-tertiary ring-(length:--stroke-width-hairline) ring-inset ring-border-subtle",
                      "forced-colors:border",
                    )}
                  >
                    <Icon name={on ? "Check" : "Minus"} size={14} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
