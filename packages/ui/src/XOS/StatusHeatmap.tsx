import { type KeyboardEvent, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { useGridFocus } from "./XOS.shared.tsx";
import { type StatusHeatmapCell, type StatusHeatmapProps } from "./XOS.types.ts";

/**
 * Rows crossed with columns, each cell one state: who has answered which section, how ready each person on a roster
 * is, where each party's allocations stand (R11). An ARIA grid, like CoordinateMatrix: arrows move between cells,
 * Home and End go to the row's ends (with Ctrl or Cmd, the grid's), and Enter or Space opens a cell. Every state shows
 * its icon and its label, never color alone, and the table is its own accessible alternative. Rows can be selected
 * for a bulk action. A row and column with no cell is not asked and reads so.
 */
export function StatusHeatmap({
  label,
  corner,
  rows,
  cols,
  cells,
  legend,
  selection,
  onCellSelect,
}: StatusHeatmapProps): ReactElement {
  const t = useT();
  const grid = useGridFocus(rows.length, cols.length);
  const byState = new Map(legend.map((l) => [l.state, l]));
  const selected = new Set(selection?.selected ?? []);

  const open = (
    e: KeyboardEvent<HTMLElement> | null,
    rowId: string,
    colId: string,
    cell: StatusHeatmapCell | undefined,
    target: HTMLElement,
  ) => {
    if (!cell) return;
    if (onCellSelect) {
      e?.preventDefault();
      onCellSelect(rowId, colId, cell);
    } else if (cell.href && e) {
      e.preventDefault();
      target.querySelector("a")?.click();
    }
  };

  const toggle = (id: string) => {
    if (!selection) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(rows.map((r) => r.id).filter((r) => next.has(r)));
  };

  return (
    <div className="flex flex-col gap-8">
      <ScrollRegion label={label}>
        <table
          role="grid"
          aria-label={label}
          aria-rowcount={rows.length + 1}
          className="border-separate border-spacing-2 text-text-12"
        >
          <caption className="pb-8 text-start text-text-13 font-semibold">{label}</caption>
          <thead>
            <tr>
              {selection ? <td aria-hidden="true" className="p-4" /> : null}
              <th scope="col" className="p-4 text-start font-medium text-text-secondary">
                {corner}
              </th>
              {cols.map((c) => (
                <th
                  key={c.id}
                  scope="col"
                  className="p-4 text-start align-bottom font-medium text-text-secondary"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.id} aria-selected={selection ? selected.has(r.id) : undefined}>
                {selection ? (
                  <td className="p-4 align-middle">
                    <input
                      type="checkbox"
                      className="xos-check-input"
                      checked={selected.has(r.id)}
                      aria-label={t("heatmap.select", { row: r.label })}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                ) : null}
                <th scope="row" className="pe-12 text-start font-medium">
                  <span className="flex flex-col">
                    <span className="whitespace-nowrap">{r.label}</span>
                    {r.sublabel ? (
                      <span className="text-text-12 font-regular text-text-secondary">
                        {r.sublabel}
                      </span>
                    ) : null}
                  </span>
                </th>
                {cols.map((c, ci) => {
                  const cell = cells[`${r.id}:${c.id}`];
                  const item = cell ? byState.get(cell.state) : undefined;
                  const stateLabel = item?.label ?? cell?.state ?? "";
                  const name = !cell
                    ? t("heatmap.none", { row: r.label, col: c.label })
                    : cell.detail
                      ? t("heatmap.detail", {
                          row: r.label,
                          col: c.label,
                          state: stateLabel,
                          detail: cell.detail,
                        })
                      : t("heatmap.cell", { row: r.label, col: c.label, state: stateLabel });
                  const actionable = Boolean(cell && (onCellSelect || cell.href));
                  const body = cell ? (
                    <span className="inline-flex items-center gap-4 whitespace-nowrap">
                      {item ? <StateIcon state={item.icon} /> : null}
                      <span>{stateLabel}</span>
                    </span>
                  ) : (
                    <span className="text-text-secondary">-</span>
                  );
                  return (
                    <td
                      key={c.id}
                      ref={grid.register(ri, ci)}
                      role="gridcell"
                      tabIndex={grid.tabIndex(ri, ci)}
                      aria-label={name}
                      data-state={cell?.state}
                      onFocus={() => grid.setActive([ri, ci])}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          open(e, r.id, c.id, cell, e.currentTarget);
                        } else grid.onKeyDown(e, ri, ci);
                      }}
                      onClick={(e) => {
                        if (cell && onCellSelect) {
                          e.preventDefault();
                          onCellSelect(r.id, c.id, cell);
                        }
                      }}
                      className={cx(
                        "xos-hit h-control-md rounded-chip px-8 text-start",
                        cell
                          ? "bg-bg-raised ring-(length:--stroke-width-hairline) ring-inset ring-border-subtle"
                          : "ring-(length:--stroke-width-hairline) ring-inset ring-border-subtle",
                        actionable &&
                          "cursor-pointer hover:outline-solid hover:outline-stroke-focus hover:outline-text-primary",
                        "focus-visible:outline-solid focus-visible:outline-stroke-focus focus-visible:outline-focus-ring",
                        "forced-colors:border",
                      )}
                    >
                      {cell?.href && !onCellSelect ? (
                        <a
                          href={cell.href}
                          tabIndex={-1}
                          className="text-text-primary no-underline"
                        >
                          {body}
                        </a>
                      ) : (
                        body
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {legend.length > 0 ? (
        <ul
          aria-label={t("heatmap.legend")}
          className="m-0 flex list-none flex-wrap gap-12 p-0 text-text-12 text-text-secondary"
        >
          {legend.map((l) => (
            <li key={l.state} className="inline-flex items-center gap-4">
              <StateIcon state={l.icon} />
              <span>{l.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
