import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Direction } from "radix-ui";
import type { GridColumn } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Money } from "../Forms/Forms.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { isNumeric } from "./Grids.shared.tsx";
import { type Cell, type Row, type SpreadsheetGridProps } from "./Grids.types.ts";
import { columnTotal } from "./columnTotal.tsx";
import { parseCell } from "./parseCell.tsx";

function editable(c: GridColumn): boolean {
  return Boolean(c.editable) && !c.derive;
}

/**
 * Spreadsheet-speed editing as an ARIA grid (the accessible model a Glide Data Grid surface keeps):
 * arrows and Tab move, Enter or typing edits, Escape cancels, Delete clears to Unpriced, and a paste
 * from Excel fills the range from the selected cell. Derived columns are read-only. With appendRow a
 * trailing blank row becomes a new row once typed or pasted into; errors mark cells invalid in place,
 * each message named by its cell (aria-describedby), and a column's parse reads its own shorthand.
 */
export function SpreadsheetGrid({
  label,
  columns,
  rows: given,
  totalsLabel,
  appendRow = false,
  errors,
  onChange,
}: SpreadsheetGridProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const dir = Direction.useDirection();
  const [rows, setRows] = useState<Row[]>(() => given.map((r) => ({ ...r })));
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const [editing, setEditing] = useState<{ draft: string } | null>(null);
  const cells = useRef(new Map<string, HTMLTableCellElement>());
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const blank = (): Row => Object.fromEntries(columns.map((c) => [c.key, null]));
  // The rows shown: the grid's rows and, with appendRow, one blank row after them.
  const shown = appendRow ? [...rows, blank()] : rows;
  const errorAt = (r: number, key: string) => errors?.[`${r}:${key}`];
  const errorList = Object.entries(errors ?? {});

  useEffect(() => {
    if (editing) input.current?.focus();
    else cells.current.get(`${sel[0]}:${sel[1]}`)?.focus({ preventScroll: false });
  }, [sel, editing]);

  const commit = (next: Row[]) => {
    setRows(next);
    onChange?.(next);
  };
  const setCell = (r: number, c: number, value: Cell) => {
    const col = columns[c];
    if (!col || !editable(col)) return;
    if (r >= rows.length) {
      // Typing into the blank row adds it; clearing it adds nothing.
      if (value === null) return;
      commit([...rows, { ...blank(), [col.key]: value }]);
      return;
    }
    commit(rows.map((row, i) => (i === r ? { ...row, [col.key]: value } : row)));
  };
  const show = (col: GridColumn, row: Row): ReactNode => {
    const v = col.derive ? col.derive(row) : row[col.key];
    if (col.type === "money")
      return (
        <Money
          amount={typeof v === "number" ? v : null}
          {...(col.currency ? { currency: col.currency } : {})}
        />
      );
    if (v === null || v === undefined || v === "") return null;
    if (col.type === "multiplier" && typeof v === "number") {
      return (
        <span className="tabular-nums">
          {t("fmt.multiplier", {
            n: new Intl.NumberFormat(fmt.locale, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 2,
            }).format(v),
          })}
        </span>
      );
    }
    if (col.type === "code") return <span className="font-mono text-text-12">{String(v)}</span>;
    if (col.type === "number" && typeof v === "number")
      return <span className="tabular-nums">{fmt.number(v)}</span>;
    return String(v);
  };

  const move = (dr: number, dc: number) =>
    setSel(([r, c]) => [
      Math.max(0, Math.min(shown.length - 1, r + dr)),
      Math.max(0, Math.min(columns.length - 1, c + dc)),
    ]);

  const onKeyDown = (e: KeyboardEvent<HTMLTableCellElement>) => {
    if (editing) return;
    const [r, c] = sel;
    const col = columns[c];
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      [forward]: [0, 1],
      [back]: [0, -1],
    };
    const step = e.key === "Tab" ? ([0, e.shiftKey ? -1 : 1] as [number, number]) : moves[e.key];
    if (
      step &&
      !(e.key === "Tab" && ((e.shiftKey && c === 0) || (!e.shiftKey && c === columns.length - 1)))
    ) {
      e.preventDefault();
      move(step[0], step[1]);
    } else if (e.key === "Home") {
      e.preventDefault();
      setSel(e.ctrlKey || e.metaKey ? [0, 0] : [r, 0]);
    } else if (e.key === "End") {
      e.preventDefault();
      setSel(
        e.ctrlKey || e.metaKey ? [shown.length - 1, columns.length - 1] : [r, columns.length - 1],
      );
    } else if ((e.key === "Enter" || e.key === "F2") && col && editable(col)) {
      e.preventDefault();
      const v = shown[r]?.[col.key];
      setEditing({ draft: v === null || v === undefined ? "" : String(v) });
    } else if ((e.key === "Delete" || e.key === "Backspace") && col && editable(col)) {
      e.preventDefault();
      setCell(r, c, null);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && col && editable(col)) {
      e.preventDefault();
      setEditing({ draft: e.key });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTableElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text || editing) return;
    e.preventDefault();
    const grid = text
      .replace(/\r/g, "")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split("\t"));
    const next = rows.map((row) => ({ ...row }));
    grid.forEach((line, dr) => {
      const r = sel[0] + dr;
      // A paste reaching past the last row adds rows when the grid appends.
      if (appendRow) while (next.length <= r) next.push(blank());
      line.forEach((value, dc) => {
        const col = columns[sel[1] + dc];
        const row = next[r];
        if (row && col && editable(col)) row[col.key] = parseCell(col, value);
      });
    });
    commit(next);
  };

  const finish = (save: boolean, draft: string) => {
    const col = columns[sel[1]];
    if (save && col) setCell(sel[0], sel[1], parseCell(col, draft));
    setEditing(null);
  };

  const th = cx(
    "h-control-lg px-12 font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-e border-border-subtle",
  );
  const td = cx(
    "relative h-control-lg px-12 border-b border-e border-border-subtle whitespace-nowrap",
  );
  return (
    <div className="flex flex-col gap-6">
      <ScrollRegion label={label}>
        <table
          role="grid"
          aria-label={label}
          aria-rowcount={shown.length + 2}
          onPaste={onPaste}
          className="w-full border-collapse text-text-13"
        >
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col" className={cx(th, "w-(--space-40) text-center")}>
                <span className="sr-only">{t("grid.row")}</span>
              </th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(th, isNumeric(c) ? "text-end" : "text-start")}
                  style={c.width ? { inlineSize: c.width } : undefined}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, ri) => (
              <tr key={ri} aria-rowindex={ri + 2}>
                <td
                  className={cx(
                    td,
                    "text-center text-text-11 text-text-tertiary bg-bg-surface tabular-nums",
                  )}
                >
                  {ri < rows.length ? ri + 1 : <span aria-label={t("grid.newRow")}>+</span>}
                </td>
                {columns.map((c, ci) => {
                  const on = sel[0] === ri && sel[1] === ci;
                  const isEditing = on && editing !== null;
                  const message = errorAt(ri, c.key);
                  return (
                    <td
                      key={c.key}
                      ref={(el) => {
                        if (el) cells.current.set(`${ri}:${ci}`, el);
                        else cells.current.delete(`${ri}:${ci}`);
                      }}
                      role="gridcell"
                      aria-selected={on}
                      aria-readonly={editable(c) ? undefined : true}
                      aria-invalid={message ? true : undefined}
                      aria-describedby={message ? `${errorId}-${ri}-${c.key}` : undefined}
                      tabIndex={on ? 0 : -1}
                      title={c.derive ? t("grid.derived") : undefined}
                      onClick={() => setSel([ri, ci])}
                      onDoubleClick={() => {
                        setSel([ri, ci]);
                        if (editable(c)) {
                          const v = row[c.key];
                          setEditing({ draft: v === null || v === undefined ? "" : String(v) });
                        }
                      }}
                      onKeyDown={onKeyDown}
                      className={cx(
                        td,
                        isNumeric(c) && "text-end",
                        !editable(c) && "text-text-secondary",
                        message && "ring-(length:--stroke-width-hairline) ring-inset ring-danger",
                        on && "ring-(length:--stroke-width-focus) ring-inset ring-accent",
                        "outline-none forced-colors:border",
                      )}
                    >
                      {isEditing ? (
                        <input
                          ref={input}
                          aria-label={c.label}
                          aria-invalid={message ? true : undefined}
                          aria-describedby={message ? `${errorId}-${ri}-${c.key}` : undefined}
                          defaultValue={editing.draft}
                          onBlur={(e) => finish(true, e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              finish(true, e.currentTarget.value);
                              move(1, 0);
                            } else if (e.key === "Escape") finish(false, "");
                            else if (e.key === "Tab") {
                              e.preventDefault();
                              finish(true, e.currentTarget.value);
                              move(0, e.shiftKey ? -1 : 1);
                            }
                          }}
                          className="w-full border-0 bg-transparent outline-none text-inherit text-text-13 tabular-nums"
                        />
                      ) : (
                        show(c, row)
                      )}
                      {on && !isEditing && editable(c) ? (
                        <span
                          aria-hidden="true"
                          className="absolute -end-(--stroke-width-focus) -bottom-(--stroke-width-focus) z-base size-(--space-6) bg-accent border border-bg-canvas"
                        />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr aria-rowindex={shown.length + 2}>
              <td className={cx(td, "bg-bg-surface")} />
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={cx(td, "font-semibold bg-bg-surface", isNumeric(c) && "text-end")}
                >
                  {c.total ? (
                    <Money
                      amount={columnTotal(
                        rows.map((r) => (c.derive ? { ...r, [c.key]: c.derive(r) ?? null } : r)),
                        c.key,
                      )}
                      {...(c.currency ? { currency: c.currency } : {})}
                    />
                  ) : i === 0 ? (
                    (totalsLabel ?? t("table.total"))
                  ) : null}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </ScrollRegion>
      {errorList.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-12 text-danger-text">
          {errorList.map(([key, text]) => {
            const [r, col] = key.split(":");
            const column = columns.find((c) => c.key === col);
            return (
              <li key={key} id={`${errorId}-${r}-${col}`}>
                {t("grid.cellError", {
                  row: Number(r) + 1,
                  column: column?.label ?? col ?? "",
                  message: text,
                })}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="m-0 text-text-11 text-text-secondary">
        {appendRow ? t("grid.hintAppend") : t("grid.hint")}
      </p>
    </div>
  );
}
