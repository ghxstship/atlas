import {
  useEffect,
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

function sameRow(a: Row, b: Row): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
}

interface Received {
  readonly rows: readonly Row[];
  /** The last row received for each key, which a new `rows` is compared against. */
  readonly byKey: ReadonlyMap<string, Row>;
}

/**
 * Merges new `rows` into the grid's rows by key. A row takes the incoming values only when they
 * differ from the last ones received for it, never because they differ from what the person typed:
 * a refresh carrying the version from before this tab's own save leaves the typed value in place.
 * The row with an open cell keeps its values, and its last received row stays as it was, so the
 * difference applies with the next rows after the cell closes.
 */
function reconcile(
  incoming: readonly Row[],
  local: readonly Row[],
  received: ReadonlyMap<string, Row>,
  keyOf: (row: Row) => string,
  editingKey: string | null,
): { rows: Row[]; byKey: Map<string, Row> } {
  const mine = new Map(local.map((r) => [keyOf(r), r]));
  const byKey = new Map<string, Row>();
  const rows = incoming.map((row) => {
    const key = keyOf(row);
    const current = mine.get(key);
    const before = received.get(key);
    if (current && key === editingKey) {
      byKey.set(key, before ?? row);
      return current;
    }
    byKey.set(key, row);
    return current && before && sameRow(before, row) ? current : { ...row };
  });
  return { rows, byKey };
}

/**
 * Spreadsheet-speed editing as an ARIA grid (the accessible model a Glide Data Grid surface keeps):
 * arrows and Tab move, Enter or typing edits, Escape cancels, Delete clears to Unpriced, and a paste
 * from Excel fills the range from the selected cell. Derived columns are read-only.
 */
export function SpreadsheetGrid({
  label,
  columns,
  rows: given,
  totalsLabel,
  onChange,
  rowKey,
  onEditingChange,
}: SpreadsheetGridProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const dir = Direction.useDirection();
  const [rows, setRows] = useState<Row[]>(() => given.map((r) => ({ ...r })));
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const [editing, setEditing] = useState<{ draft: string } | null>(null);
  const cells = useRef(new Map<string, HTMLTableCellElement>());
  const input = useRef<HTMLInputElement>(null);
  const keyOf = (row: Row | undefined) => (row && rowKey ? String(row[rowKey] ?? "") : "");
  const [received, setReceived] = useState<Received>(() => ({
    rows: given,
    byKey: new Map(given.map((r) => [rowKey ? String(r[rowKey] ?? "") : "", r])),
  }));

  // New rows from the page, merged by key while the selection and the open cell follow their row.
  if (rowKey && given !== received.rows) {
    const selectedKey = keyOf(rows[sel[0]]);
    const merged = reconcile(given, rows, received.byKey, keyOf, editing ? selectedKey : null);
    const at = merged.rows.findIndex((r) => keyOf(r) === selectedKey);
    setReceived({ rows: given, byKey: merged.byKey });
    setRows(merged.rows);
    if (at < 0) {
      setSel([Math.max(0, Math.min(sel[0], merged.rows.length - 1)), sel[1]]);
      if (editing) setEditing(null);
    } else if (at !== sel[0]) {
      setSel([at, sel[1]]);
    }
  }

  const editingKey = rowKey && editing ? keyOf(rows[sel[0]]) : null;
  const reportEditing = useRef(onEditingChange);
  reportEditing.current = onEditingChange;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (reported.current === editingKey) return;
    reported.current = editingKey;
    reportEditing.current?.(editingKey);
  }, [editingKey]);

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
      Math.max(0, Math.min(rows.length - 1, r + dr)),
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
        e.ctrlKey || e.metaKey ? [rows.length - 1, columns.length - 1] : [r, columns.length - 1],
      );
    } else if ((e.key === "Enter" || e.key === "F2") && col && editable(col)) {
      e.preventDefault();
      const v = rows[r]?.[col.key];
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
      line.forEach((value, dc) => {
        const r = sel[0] + dr;
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
          aria-rowcount={rows.length + 2}
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
            {rows.map((row, ri) => (
              <tr key={rowKey ? `k:${keyOf(row)}` : ri} aria-rowindex={ri + 2}>
                <td
                  className={cx(
                    td,
                    "text-center text-text-11 text-text-tertiary bg-bg-surface tabular-nums",
                  )}
                >
                  {ri + 1}
                </td>
                {columns.map((c, ci) => {
                  const on = sel[0] === ri && sel[1] === ci;
                  const isEditing = on && editing !== null;
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
                        on && "ring-(length:--stroke-width-focus) ring-inset ring-accent",
                        "outline-none forced-colors:border",
                      )}
                    >
                      {isEditing ? (
                        <input
                          ref={input}
                          aria-label={c.label}
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
            <tr aria-rowindex={rows.length + 2}>
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
      <p className="m-0 text-text-11 text-text-secondary">{t("grid.hint")}</p>
    </div>
  );
}
