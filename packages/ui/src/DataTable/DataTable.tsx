import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type Column,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Direction } from "radix-ui";
import type {
  DataTableColumn as ReferenceDataTableColumn,
  DataTableProps as ReferenceDataTableProps,
  RecordState,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { Money } from "../Forms/Forms.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";

export interface DataTableColumn extends ReferenceDataTableColumn {
  /** Width in pixels; defaults by type. */
  width?: number;
}

export type DataTableProps = Omit<ReferenceDataTableProps, "columns"> & {
  columns: DataTableColumn[];
  /** Names the scroll region; the caption by default. */
  label?: string;
  /** Column keys pinned to the logical start or end; they stay visible while the grid scrolls. */
  pinStart?: string[];
  pinEnd?: string[];
  /** Columns resize by pointer or keyboard; on by default. */
  resizable?: boolean;
  /** Rows above which the body virtualizes; 100 by default. */
  virtualizeAbove?: number;
  /** Height of the scroll region when virtualized, as a CSS length; 60 percent of the viewport by default. */
  height?: string;
  /** Enter on a cell, or a double click, activates its row. */
  onRowActivate?: (row: Record<string, unknown>, index: number) => void;
};

const features = tableFeatures({
  columnSizingFeature,
  columnResizingFeature,
  columnPinningFeature,
});

type Row = Record<string, unknown>;

const NONE: string[] = [];

const DEFAULT_WIDTH: Record<NonNullable<ReferenceDataTableColumn["type"]>, number> = {
  text: 200,
  code: 128,
  number: 112,
  money: 128,
  state: 144,
};

const ROW_HEIGHT: Record<NonNullable<ReferenceDataTableProps["density"]>, number> = {
  compact: 32,
  default: 36,
  comfortable: 44,
};

const ROW_CLASS: Record<NonNullable<ReferenceDataTableProps["density"]>, string> = {
  compact: cx("h-row-compact"),
  default: cx("h-row-default"),
  comfortable: cx("h-row-comfortable"),
};

function isNumeric(column: ReferenceDataTableColumn): boolean {
  return column.type === "money" || column.type === "number";
}

function isStateValue(value: unknown): value is { state: RecordState; label: string } {
  return typeof value === "object" && value !== null && "state" in value && "label" in value;
}

function CellValue({
  column,
  value,
}: {
  column: ReferenceDataTableColumn;
  value: unknown;
}): ReactNode {
  if (column.type === "money") {
    return (
      <Money
        amount={typeof value === "number" ? value : null}
        {...(column.currency ? { currency: column.currency } : {})}
      />
    );
  }
  if (column.type === "state") {
    return isStateValue(value) ? (
      <span className="inline-flex items-center gap-6 whitespace-nowrap">
        <StateIcon state={value.state} />
        {value.label}
      </span>
    ) : null;
  }
  if (value === null || value === undefined) return null;
  if (column.type === "code")
    return <span className="font-mono text-text-12">{String(value)}</span>;
  if (column.type === "number") return <span className="tabular-nums">{String(value)}</span>;
  return String(value);
}

function pinStyle(column: Column<typeof features, Row, unknown>): CSSProperties {
  const pinned = column.getIsPinned();
  return {
    inlineSize: column.getSize(),
    ...(pinned === "start"
      ? { position: "sticky", insetInlineStart: column.getStart("start") }
      : {}),
    ...(pinned === "end" ? { position: "sticky", insetInlineEnd: column.getAfter("end") } : {}),
  };
}

const cellClass = cx(
  "px-12 border-b border-border-subtle whitespace-nowrap overflow-hidden text-ellipsis box-border",
);

/**
 * The table on TanStack Table and TanStack Virtual inside a ScrollRegion: a keyboard grid (arrow
 * keys, Home and End, Ctrl+Home and Ctrl+End, Page Up and Page Down, Enter activates the row), with
 * column pinning and resizing. Null money renders Unpriced; long text columns wrap.
 */
export function DataTable({
  columns: givenColumns,
  rows,
  caption,
  density = "default",
  totals,
  totalsLabel,
  label,
  pinStart = NONE,
  pinEnd = NONE,
  resizable = true,
  virtualizeAbove = 100,
  height = "60vh",
  onRowActivate,
}: DataTableProps): ReactElement {
  const t = useT();
  const dir = Direction.useDirection();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const [focusPending, setFocusPending] = useState(false);
  // Pinned columns lead and trail in their regions so sticky offsets match the DOM order.
  const columns = useMemo(
    () => [
      ...givenColumns.filter((c) => pinStart.includes(c.key)),
      ...givenColumns.filter((c) => !pinStart.includes(c.key) && !pinEnd.includes(c.key)),
      ...givenColumns.filter((c) => pinEnd.includes(c.key)),
    ],
    [givenColumns, pinStart, pinEnd],
  );

  const columnDefs = useMemo(
    () =>
      columns.map((c) => ({
        id: c.key,
        accessorFn: (row: Row) => row[c.key],
        header: c.label,
        size: c.width ?? (c.wrap ? 280 : DEFAULT_WIDTH[c.type ?? "text"]),
        minSize: 64,
        maxSize: 640,
      })),
    [columns],
  );
  const table = useTable({
    features,
    columns: columnDefs,
    data: rows,
    columnResizeMode: "onChange",
    columnResizeDirection: dir,
    initialState: { columnPinning: { start: pinStart, end: pinEnd } },
  });

  const virtual = rows.length > virtualizeAbove;
  const rowHeight = ROW_HEIGHT[density];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    initialRect: { width: 0, height: rowHeight * 20 },
    enabled: virtual,
  });

  const tableRows = table.getRowModel().rows;
  const items = virtual
    ? virtualizer.getVirtualItems()
    : tableRows.map((_, index) => ({ index, start: index * rowHeight, size: rowHeight }));
  const before = virtual && items.length > 0 ? (items[0]?.start ?? 0) : 0;
  const after =
    virtual && items.length > 0
      ? virtualizer.getTotalSize() - (items[items.length - 1]?.start ?? 0) - rowHeight
      : 0;
  const leafColumns = table.getAllLeafColumns();

  useEffect(() => {
    if (!focusPending) return;
    const cell = cellRefs.current.get(`${active[0]}:${active[1]}`);
    if (cell) {
      cell.focus();
      setFocusPending(false);
    }
  });

  const moveTo = (r: number, c: number) => {
    const row = Math.max(0, Math.min(rows.length - 1, r));
    const col = Math.max(0, Math.min(leafColumns.length - 1, c));
    setActive([row, col]);
    if (virtual) virtualizer.scrollToIndex(row);
    setFocusPending(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableCellElement>, r: number, c: number) => {
    const page = Math.max(
      1,
      Math.floor((scrollRef.current?.clientHeight || rowHeight * 10) / rowHeight) - 1,
    );
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const ctrl = e.ctrlKey || e.metaKey;
    const moves: Record<string, [number, number] | undefined> = {
      ArrowDown: [r + 1, c],
      ArrowUp: [r - 1, c],
      [forward]: [r, c + 1],
      [back]: [r, c - 1],
      Home: ctrl ? [0, 0] : [r, 0],
      End: ctrl ? [rows.length - 1, leafColumns.length - 1] : [r, leafColumns.length - 1],
      PageDown: [r + page, c],
      PageUp: [r - page, c],
    };
    const target = moves[e.key];
    if (target) {
      e.preventDefault();
      moveTo(target[0], target[1]);
    } else if (e.key === "Enter" && onRowActivate) {
      e.preventDefault();
      const row = rows[r];
      if (row) onRowActivate(row, r);
    }
  };

  const resizeByKey = (
    column: Column<typeof features, Row, unknown>,
    e: KeyboardEvent<HTMLDivElement>,
  ) => {
    const grow = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const shrink = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const delta = e.key === grow ? 16 : e.key === shrink ? -16 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = Math.max(64, Math.min(640, column.getSize() + delta));
    table.setColumnSizing((sizing) => ({ ...sizing, [column.id]: next }));
  };

  const pinnedClass = (column: Column<typeof features, Row, unknown>) =>
    column.getIsPinned() ? "z-sticky bg-bg-canvas" : undefined;

  return (
    <ScrollRegion
      ref={scrollRef}
      label={label ?? caption ?? t("scroll.region")}
      {...(virtual ? { style: { maxBlockSize: height }, className: "overflow-y-auto" } : {})}
    >
      <table
        role="grid"
        aria-rowcount={rows.length + 1 + (totals ? 1 : 0)}
        aria-colcount={leafColumns.length}
        className="border-separate border-spacing-0 table-fixed text-text-13 print:text-paper-ink"
        style={{ inlineSize: table.getTotalSize() }}
      >
        {caption ? <caption className="pb-8 text-start font-semibold">{caption}</caption> : null}
        <thead className="sticky top-0 z-sticky">
          <tr aria-rowindex={1}>
            {table.getFlatHeaders().map((header, ci) => {
              const column = columns[ci];
              return (
                <th
                  key={header.id}
                  scope="col"
                  aria-colindex={ci + 1}
                  className={cx(
                    "relative h-control-lg px-12 font-medium text-text-12 text-text-secondary bg-bg-surface",
                    "border-b border-border-subtle box-border",
                    column && isNumeric(column) ? "text-end" : "text-start",
                    header.column.getIsPinned() && "z-sticky",
                  )}
                  style={pinStyle(header.column)}
                >
                  {String(header.column.columnDef.header ?? "")}
                  {resizable ? (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`${t("panel.resize")}: ${String(header.column.columnDef.header ?? "")}`}
                      aria-valuenow={header.column.getSize()}
                      aria-valuemin={64}
                      aria-valuemax={640}
                      tabIndex={0}
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onDoubleClick={() => header.column.resetSize()}
                      onKeyDown={(e) => resizeByKey(header.column, e)}
                      className={cx(
                        "absolute inset-y-0 end-0 w-(--ui-handle) cursor-col-resize touch-none select-none",
                        "hover:bg-accent focus-visible:bg-accent",
                        header.column.getIsResizing() && "bg-accent",
                      )}
                    />
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {before > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={leafColumns.length} style={{ blockSize: before }} />
            </tr>
          ) : null}
          {items.map((item) => {
            const row = tableRows[item.index];
            if (!row) return null;
            return (
              <tr
                key={row.id}
                aria-rowindex={item.index + 2}
                className={cx(ROW_CLASS[density], "hover:[&>td]:bg-bg-hover")}
                onDoubleClick={
                  onRowActivate ? () => onRowActivate(row.original, item.index) : undefined
                }
              >
                {row.getAllCells().map((cell, ci) => {
                  const column = columns[ci];
                  const isActive = active[0] === item.index && active[1] === ci;
                  return (
                    <td
                      key={cell.id}
                      ref={(el) => {
                        const key = `${item.index}:${ci}`;
                        if (el) cellRefs.current.set(key, el);
                        else cellRefs.current.delete(key);
                      }}
                      role="gridcell"
                      aria-colindex={ci + 1}
                      tabIndex={isActive ? 0 : -1}
                      onFocus={() => setActive([item.index, ci])}
                      onKeyDown={(e) => onKeyDown(e, item.index, ci)}
                      className={cx(
                        cellClass,
                        column && isNumeric(column) && "text-end",
                        column?.wrap && "whitespace-normal py-8",
                        "focus-visible:outline-offset-[calc(var(--stroke-width-focus)*-1)]",
                        pinnedClass(cell.column),
                      )}
                      style={pinStyle(cell.column)}
                    >
                      {column ? <CellValue column={column} value={cell.getValue()} /> : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {after > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={leafColumns.length} style={{ blockSize: after }} />
            </tr>
          ) : null}
        </tbody>
        {totals ? (
          <tfoot className="sticky bottom-0 z-sticky">
            <tr aria-rowindex={rows.length + 2} className={ROW_CLASS[density]}>
              {columns.map((c, ci) => {
                const column = leafColumns[ci];
                return (
                  <td
                    key={c.key}
                    className={cx(
                      cellClass,
                      "font-semibold bg-bg-surface",
                      isNumeric(c) && "text-end",
                    )}
                    style={column ? pinStyle(column) : undefined}
                  >
                    {c.key in totals ? (
                      <CellValue column={c} value={totals[c.key]} />
                    ) : ci === 0 ? (
                      (totalsLabel ?? t("table.total"))
                    ) : null}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </ScrollRegion>
  );
}
