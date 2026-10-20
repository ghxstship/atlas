import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type TouchEvent,
} from "react";
import type { ColumnSizingState, Updater, columnResizingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Direction } from "radix-ui";
import type {
  DataTableColumn as ReferenceDataTableColumn,
  DataTableProps as ReferenceDataTableProps,
  RecordState,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { useNarrow } from "../lib/hooks.ts";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { Money } from "../Forms/Forms.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import type { DataTableResizer, StartResize } from "./DataTableResizer.tsx";

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
  /**
   * Below md the table becomes stacked cards with the three most important fields (Section 11.6):
   * these column keys, in order, the first as the card's title. By default the title is the first
   * text column among the first four (a name rather than a code) and the other two of the first
   * three follow. Pass false to keep the grid.
   */
  cardFields?: string[] | false;
};

/** A column as the grid lays it out: its id and label, current width and pinned position. */
interface LaidColumn {
  id: string;
  label: string;
  size: number;
  pinned: "start" | "end" | false;
  /** Offset from the logical start among start-pinned columns, or from the end among end-pinned ones. */
  offset: number;
}

const NONE: string[] = [];

const MIN_WIDTH = 64;
const MAX_WIDTH = 640;

const IDLE_RESIZE: columnResizingState = {
  startOffset: null,
  startSize: null,
  deltaOffset: null,
  deltaPercentage: null,
  isResizingColumn: false,
  columnSizingStart: [],
};

const RELEASE_EVENTS = ["mouseup", "touchend", "touchcancel"] as const;

type ResizerComponent = ComponentType<Parameters<typeof DataTableResizer>[0]>;

/** The pointer resize engine (TanStack Table) loads on the first approach to a resize handle. */
let resizerModule: Promise<{ DataTableResizer: typeof DataTableResizer }> | null = null;
const loadResizer = () => (resizerModule ??= import("./DataTableResizer.tsx"));

function apply<T>(updater: Updater<T>, old: T): T {
  return typeof updater === "function" ? (updater as (old: T) => T)(old) : updater;
}

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

/**
 * The full text of a cell that may be cut off with an ellipsis, as its title (Section 15: a longer
 * translation never hides text). Wrapping columns and numbers never clip.
 */
function cellTitle(
  column: ReferenceDataTableColumn | undefined,
  value: unknown,
): string | undefined {
  if (!column || column.wrap || column.type === "money" || column.type === "number")
    return undefined;
  if (column.type === "state") return isStateValue(value) ? value.label : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function defaultWidth(column: DataTableColumn): number {
  return column.width ?? (column.wrap ? 280 : DEFAULT_WIDTH[column.type ?? "text"]);
}

function pinStyle(column: LaidColumn): CSSProperties {
  return {
    inlineSize: column.size,
    ...(column.pinned === "start" ? { position: "sticky", insetInlineStart: column.offset } : {}),
    ...(column.pinned === "end" ? { position: "sticky", insetInlineEnd: column.offset } : {}),
  };
}

/**
 * Lays the columns out as TanStack Table's sizing and pinning features do: a width is the resized
 * width or the default, clamped to 64 to 640 px; start-pinned columns are offset from the logical
 * start in pinning order, end-pinned ones from the end.
 */
function layColumns(
  columns: DataTableColumn[],
  sizing: ColumnSizingState,
  pinning: { start: string[]; end: string[] },
): LaidColumn[] {
  const laid = columns.map((c): LaidColumn => {
    const size = Object.hasOwn(sizing, c.key) ? sizing[c.key] : defaultWidth(c);
    return {
      id: c.key,
      label: c.label,
      size: Math.min(Math.max(MIN_WIDTH, size ?? 0), MAX_WIDTH),
      pinned: pinning.start.includes(c.key) ? "start" : pinning.end.includes(c.key) ? "end" : false,
      offset: 0,
    };
  });
  const byId = new Map(laid.map((c) => [c.id, c]));
  let start = 0;
  for (const id of pinning.start) {
    const c = byId.get(id);
    if (c) {
      c.offset = start;
      start += c.size;
    }
  }
  let after = 0;
  for (const id of [...pinning.end].reverse()) {
    const c = byId.get(id);
    if (c) {
      c.offset = after;
      after += c.size;
    }
  }
  return laid;
}

const cellClass = cx(
  "px-12 border-b border-border-subtle whitespace-nowrap overflow-hidden text-ellipsis box-border",
);

/** A card's title (a plain-text column, so a name leads rather than a code) and two more fields. */
function defaultCardFields(columns: DataTableColumn[]): DataTableColumn[] {
  const title =
    columns.slice(0, 4).find((c) => (c.type ?? "text") === "text") ?? columns[0] ?? null;
  if (!title) return [];
  return [title, ...columns.slice(0, 3).filter((c) => c !== title)].slice(0, 3);
}

/**
 * The table as stacked cards below md (Section 11.6, A59-013): one card per row with its most
 * important fields, the first as the card's title. A row that opens is a button, so a tap or Enter
 * opens it as Enter on the grid does.
 */
function DataTableCards({
  label,
  caption,
  fields,
  rows,
  totals,
  totalsLabel,
  onRowActivate,
}: {
  label: string;
  caption: string | undefined;
  fields: DataTableColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown> | undefined;
  totalsLabel: string;
  onRowActivate: ((row: Record<string, unknown>, index: number) => void) | undefined;
}): ReactElement {
  const [first, ...rest] = fields;
  const details = (values: Record<string, unknown>, columns: DataTableColumn[]) =>
    columns.length > 0 ? (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-12 gap-y-2 m-0 text-text-12">
        {columns.map((c) => (
          <div key={c.key} className="contents">
            <dt className="text-text-secondary">{c.label}</dt>
            <dd className="m-0 min-w-0 truncate" title={cellTitle(c, values[c.key])}>
              <CellValue column={c} value={values[c.key]} />
            </dd>
          </div>
        ))}
      </dl>
    ) : null;
  return (
    <section aria-label={label} className="flex flex-col gap-8 min-w-0">
      {caption ? <p className="m-0 text-text-13 font-semibold">{caption}</p> : null}
      <ul className="flex flex-col gap-8 m-0 p-0 list-none">
        {rows.map((row, index) => {
          const title = first ? <CellValue column={first} value={row[first.key]} /> : null;
          return (
            <li
              key={index}
              className="flex flex-col gap-6 p-12 rounded-card border border-border-subtle bg-bg-surface"
            >
              {onRowActivate ? (
                <button
                  type="button"
                  onClick={() => onRowActivate(row, index)}
                  className="p-0 border-0 bg-transparent text-start text-text-14 font-medium text-text-primary cursor-pointer underline-offset-2 hover:underline pointer-coarse:min-h-target-coarse"
                >
                  {title}
                </button>
              ) : (
                <span className="text-text-14 font-medium text-text-primary">{title}</span>
              )}
              {details(row, rest)}
            </li>
          );
        })}
      </ul>
      {totals ? (
        <div className="flex flex-col gap-4 px-12">
          <p className="m-0 text-text-13 font-semibold">{totalsLabel}</p>
          {details(
            totals,
            fields.filter((c) => c.key in totals),
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The table inside a ScrollRegion, virtualized with TanStack Virtual: a keyboard grid (arrow keys,
 * Home and End, Ctrl+Home and Ctrl+End, Page Up and Page Down, Enter activates the row), with
 * column pinning and resizing. Null money renders Unpriced; long text columns wrap.
 *
 * The grid lays its columns out from its own column state. Keyboard resizing and reset change that
 * state directly. A pointer drag on a resize handle runs on TanStack Table, which loads when a
 * pointer first enters a handle or a handle takes focus, and then drives the same state (ADR 0027).
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
  cardFields,
}: DataTableProps): ReactElement {
  const t = useT();
  const narrow = useNarrow();
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

  // Pinning is fixed at mount, as the table's initial state.
  const [pinning] = useState(() => ({ start: pinStart, end: pinEnd }));
  // Column state updates synchronously, as TanStack Table's own store does: one drag step sets the
  // transient resize state and then commits the widths computed from it.
  const [resizing, setResizingState] = useState<columnResizingState>(IDLE_RESIZE);
  const [sizing, setSizingState] = useState<ColumnSizingState>({});
  const resizingRef = useRef(resizing);
  const sizingRef = useRef(sizing);
  const setResizing = (updater: Updater<columnResizingState>) => {
    resizingRef.current = apply(updater, resizingRef.current);
    setResizingState(resizingRef.current);
  };
  const setSizing = (updater: Updater<ColumnSizingState>) => {
    sizingRef.current = apply(updater, sizingRef.current);
    setSizingState(sizingRef.current);
  };

  const leafColumns = useMemo(
    () => layColumns(columns, sizing, pinning),
    [columns, sizing, pinning],
  );
  // Header order: start-pinned in pinning order, then the rest, then end-pinned in pinning order.
  const headers = useMemo(() => {
    const byId = new Map(leafColumns.map((c) => [c.id, c]));
    const pick = (ids: string[]) =>
      ids.map((id) => byId.get(id)).filter((c): c is LaidColumn => c !== undefined);
    return [
      ...pick(pinning.start),
      ...leafColumns.filter((c) => !pinning.start.includes(c.id) && !pinning.end.includes(c.id)),
      ...pick(pinning.end),
    ];
  }, [leafColumns, pinning]);
  const totalSize = leafColumns.reduce((sum, c) => sum + c.size, 0);
  const resizerColumns = useMemo(
    () =>
      columns.map((c) => ({
        id: c.key,
        size: defaultWidth(c),
        minSize: MIN_WIDTH,
        maxSize: MAX_WIDTH,
      })),
    [columns],
  );

  const [Resizer, setResizer] = useState<ResizerComponent | null>(null);
  const startRef = useRef<StartResize | null>(null);
  const pendingStart = useRef<Parameters<StartResize> | null>(null);
  const prepareResize = () => {
    if (Resizer) return;
    void loadResizer().then((m) => setResizer(() => m.DataTableResizer));
  };
  const startResize = (
    columnId: string,
    e: MouseEvent<HTMLDivElement> | TouchEvent<HTMLDivElement>,
  ) => {
    if (startRef.current) {
      startRef.current(columnId, e);
      return;
    }
    // The engine is still loading: the drag starts from this press once it is ready, unless the
    // pointer is released first.
    pendingStart.current = [
      columnId,
      "touches" in e
        ? { type: e.type, touches: Array.from(e.touches, (touch) => ({ clientX: touch.clientX })) }
        : { type: e.type, clientX: e.clientX },
    ];
    const release = () => {
      pendingStart.current = null;
      for (const type of RELEASE_EVENTS) document.removeEventListener(type, release);
    };
    for (const type of RELEASE_EVENTS) document.addEventListener(type, release);
    prepareResize();
  };
  const onResizerReady = () => {
    const pending = pendingStart.current;
    pendingStart.current = null;
    if (pending) startRef.current?.(...pending);
  };

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

  const items = virtual
    ? virtualizer.getVirtualItems()
    : rows.map((_, index) => ({ index, start: index * rowHeight, size: rowHeight }));
  const before = virtual && items.length > 0 ? (items[0]?.start ?? 0) : 0;
  const after =
    virtual && items.length > 0
      ? virtualizer.getTotalSize() - (items[items.length - 1]?.start ?? 0) - rowHeight
      : 0;

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

  const resizeByKey = (column: LaidColumn, e: KeyboardEvent<HTMLDivElement>) => {
    const grow = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const shrink = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const delta = e.key === grow ? 16 : e.key === shrink ? -16 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, column.size + delta));
    setSizing((old) => ({ ...old, [column.id]: next }));
  };
  const resetSize = (column: LaidColumn) =>
    setSizing((old) => Object.fromEntries(Object.entries(old).filter(([id]) => id !== column.id)));

  const pinnedClass = (column: LaidColumn) => (column.pinned ? "z-sticky bg-bg-canvas" : undefined);

  if (narrow && cardFields !== false) {
    const fields = cardFields
      ? cardFields
          .map((key) => columns.find((c) => c.key === key))
          .filter((c): c is DataTableColumn => c !== undefined)
      : defaultCardFields(columns);
    return (
      <DataTableCards
        label={label ?? caption ?? t("scroll.region")}
        caption={caption}
        fields={fields}
        rows={rows}
        totals={totals}
        totalsLabel={totalsLabel ?? t("table.total")}
        onRowActivate={onRowActivate}
      />
    );
  }

  return (
    <ScrollRegion
      ref={scrollRef}
      label={label ?? caption ?? t("scroll.region")}
      {...(virtual ? { style: { maxBlockSize: height }, className: "overflow-y-auto" } : {})}
    >
      {Resizer ? (
        <Resizer
          columns={resizerColumns}
          sizing={sizing}
          resizing={resizing}
          onSizingChange={setSizing}
          onResizingChange={setResizing}
          direction={dir === "rtl" ? "rtl" : "ltr"}
          startRef={startRef}
          onReady={onResizerReady}
        />
      ) : null}
      <table
        role="grid"
        aria-rowcount={rows.length + 1 + (totals ? 1 : 0)}
        aria-colcount={leafColumns.length}
        className="border-separate border-spacing-0 table-fixed text-text-13 print:text-paper-ink"
        style={{ inlineSize: totalSize }}
      >
        {caption ? <caption className="pb-8 text-start font-semibold">{caption}</caption> : null}
        <thead className="sticky top-0 z-sticky">
          <tr aria-rowindex={1}>
            {headers.map((header, ci) => {
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
                    header.pinned && "z-sticky",
                  )}
                  style={pinStyle(header)}
                >
                  {header.label}
                  {resizable ? (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t("table.resizeColumn", { column: header.label })}
                      aria-valuenow={header.size}
                      aria-valuemin={MIN_WIDTH}
                      aria-valuemax={MAX_WIDTH}
                      tabIndex={0}
                      onPointerEnter={prepareResize}
                      onFocus={prepareResize}
                      onMouseDown={(e) => startResize(header.id, e)}
                      onTouchStart={(e) => startResize(header.id, e)}
                      onDoubleClick={() => resetSize(header)}
                      onKeyDown={(e) => resizeByKey(header, e)}
                      className={cx(
                        "absolute inset-y-0 end-0 w-(--ui-handle) cursor-col-resize touch-none select-none",
                        "hover:bg-accent focus-visible:bg-accent",
                        resizing.isResizingColumn === header.id && "bg-accent",
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
            const row = rows[item.index];
            if (!row) return null;
            return (
              <tr
                key={item.index}
                aria-rowindex={item.index + 2}
                className={cx(
                  ROW_CLASS[density],
                  "hover:[&>td]:bg-bg-hover",
                  onRowActivate && "cursor-pointer",
                )}
                onDoubleClick={onRowActivate ? () => onRowActivate(row, item.index) : undefined}
              >
                {leafColumns.map((cell, ci) => {
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
                        pinnedClass(cell),
                      )}
                      style={pinStyle(cell)}
                      title={cellTitle(column, column ? row[column.key] : undefined)}
                    >
                      {column ? <CellValue column={column} value={row[column.key]} /> : null}
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
