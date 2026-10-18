import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { DepartmentGlyph, PhaseGlyph } from "../Glyphs/Glyphs.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { useGridFocus } from "./XOS.shared.tsx";
import { type CoordinateMatrixProps } from "./XOS.types.ts";

const SEQ: Record<number, string> = {
  2: cx("bg-viz-seq-2 text-viz-ink"),
  3: cx("bg-viz-seq-3 text-viz-ink"),
  4: cx("bg-viz-seq-4 text-viz-ink"),
  5: cx("bg-viz-seq-5 text-viz-ink"),
  6: cx("bg-viz-seq-6 text-accent-text-on"),
  7: cx("bg-viz-seq-7 text-accent-text-on"),
  8: cx("bg-viz-seq-8 text-accent-text-on"),
  9: cx("bg-viz-seq-9 text-accent-text-on"),
};

/**
 * The 10 departments crossed with the 9 phases. An ARIA grid: arrows move between cells, Enter
 * drills into a coordinate's records. Empty coordinates are outlined, not filled.
 */
export function CoordinateMatrix({
  label,
  corner,
  rows,
  cols,
  cells,
  onCellSelect,
}: CoordinateMatrixProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const grid = useGridFocus(rows.length, cols.length);
  const max = Math.max(0, ...Object.values(cells));
  const step = (v: number) => (v ? Math.min(9, 2 + Math.round((v / max) * 6)) : 0);
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
              {corner}
            </th>
            {cols.map((c) => (
              <th
                key={c.code}
                scope="col"
                title={c.name}
                className="p-4 font-medium text-text-secondary text-center"
              >
                <span className="flex flex-col items-center gap-2">
                  <PhaseGlyph
                    code={c.code}
                    size={14}
                    label={t("phase.gateName", { n: c.gate, name: c.name })}
                  />
                  <span aria-hidden="true" className="tabular-nums">
                    {c.gate}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.code}>
              <th scope="row" className="pe-12 text-start font-medium whitespace-nowrap">
                <span className="inline-flex items-center gap-6">
                  <DepartmentGlyph code={r.code} size={14} color="var(--color-text-secondary)" />
                  <span>{r.name}</span>
                  <span className="font-mono text-text-secondary">{r.code}</span>
                </span>
              </th>
              {cols.map((c, ci) => {
                const v = cells[`${r.code}|${c.code}`] ?? 0;
                const s = step(v);
                const name = v
                  ? t("matrix.cell", { row: r.name, col: c.name, n: fmt.number(v) })
                  : t("matrix.empty", { row: r.name, col: c.name });
                return (
                  <td
                    key={c.code}
                    ref={grid.register(ri, ci)}
                    role="gridcell"
                    tabIndex={grid.tabIndex(ri, ci)}
                    aria-label={name}
                    onFocus={() => grid.setActive([ri, ci])}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && v) {
                        e.preventDefault();
                        onCellSelect?.(r.code, c.code);
                      } else grid.onKeyDown(e, ri, ci);
                    }}
                    onClick={() => (v ? onCellSelect?.(r.code, c.code) : undefined)}
                    className={cx(
                      "xos-hit w-(--space-48) h-control-md rounded-chip text-center font-semibold tabular-nums",
                      v
                        ? cx(
                            SEQ[s],
                            "cursor-pointer hover:outline-solid hover:outline-stroke-focus hover:outline-text-primary",
                          )
                        : "ring-(length:--stroke-width-hairline) ring-inset ring-border-subtle",
                      "forced-colors:border",
                    )}
                  >
                    {v ? <span aria-hidden="true">{fmt.number(v)}</span> : null}
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
