import { type ReactElement } from "react";
import type { HeatmapProps as ReferenceHeatmapProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";

export type HeatmapProps = ReferenceHeatmapProps & {
  /** Called when a cell's button is pressed, with its row and column keys; cells are buttons only when given. */
  onCellActivate?: (row: string, column: string) => void;
};

const STEP: Record<number, string> = {
  0: cx("bg-bg-canvas text-text-tertiary"),
  1: cx("bg-viz-seq-2 text-viz-ink"),
  2: cx("bg-viz-seq-4 text-viz-ink"),
  3: cx("bg-viz-seq-6 text-accent-text-on"),
  4: cx("bg-viz-seq-8 text-accent-text-on"),
};

/**
 * A numeric heatmap (B4, G-45; ADR 0143 decision 7): rows against columns as a native table, so a screen reader
 * reads each cell with its row and column headers. Every cell shows its value as text beside its tint, and a cell
 * over its limit carries an icon and a sentence, so the tint is never the only signal. Cells are keyed
 * '<row>:<col>'. With `onCellActivate` each cell is a button that opens its detail.
 */
export function Heatmap({
  label,
  rowHeader,
  rows,
  columns,
  cells,
  onCellActivate,
}: HeatmapProps): ReactElement {
  const t = useT();
  const th =
    "px-8 py-6 text-text-12 font-medium text-text-secondary bg-bg-surface border-b border-e border-border-subtle";
  return (
    <ScrollRegion label={label}>
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            <th scope="col" className={cx(th, "text-start")}>
              {rowHeader}
            </th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(th, "text-center whitespace-nowrap")}>
                {c.fullLabel && c.fullLabel !== c.label ? (
                  <abbr title={c.fullLabel} className="no-underline">
                    <span aria-hidden="true">{c.label}</span>
                    <span className="sr-only">{c.fullLabel}</span>
                  </abbr>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th
                scope="row"
                className="px-8 py-6 text-start font-medium whitespace-nowrap bg-bg-surface border-b border-e border-border-subtle"
              >
                {r.label}
              </th>
              {columns.map((c) => {
                const cell = cells[`${r.key}:${c.key}`];
                const step = cell?.step ?? 0;
                const content = (
                  <span className="inline-flex items-center justify-center gap-4 tabular-nums">
                    {cell?.over ? <Icon name="TriangleAlert" size={12} /> : null}
                    <span>{cell?.text ?? ""}</span>
                    {cell?.over && !onCellActivate ? (
                      <span className="sr-only">{`, ${cell.over}`}</span>
                    ) : null}
                  </span>
                );
                return (
                  <td
                    key={c.key}
                    data-step={step}
                    title={cell?.over}
                    className={cx(
                      "h-row-default min-w-(--space-56) p-0 text-center border-b border-e border-border-subtle",
                      STEP[step],
                      cell?.over &&
                        "font-semibold ring-(length:--stroke-width-focus) ring-inset ring-danger",
                      "forced-colors:border",
                    )}
                  >
                    {onCellActivate && cell ? (
                      <button
                        type="button"
                        aria-label={`${t("heatmap.cell", { row: r.label, column: c.fullLabel ?? c.label, value: cell.text })}${cell.over ? `, ${cell.over}` : ""}`}
                        onClick={() => onCellActivate(r.key, c.key)}
                        className="h-full w-full cursor-pointer border-0 bg-transparent px-6 text-inherit focus-visible:outline-(length:--stroke-width-focus) focus-visible:outline-accent"
                      >
                        {content}
                      </button>
                    ) : (
                      <span className="px-6">{content}</span>
                    )}
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
