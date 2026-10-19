import { useLayoutEffect, type RefObject } from "react";
import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnSizingState,
  type OnChangeFn,
  type columnResizingState,
} from "@tanstack/react-table";

/** Starts a pointer resize of one column from its handle's mousedown or touchstart. */
export type StartResize = (
  columnId: string,
  event: { type: string; clientX?: number; touches?: ArrayLike<{ clientX: number }> },
) => void;

const features = tableFeatures({ columnSizingFeature, columnResizingFeature });

const NO_ROWS: Record<string, unknown>[] = [];

/**
 * The TanStack Table column engine behind a DataTable's pointer resize. DataTable loads it on the
 * first interaction with a resize handle (ADR 0027): the table renders from its own column state
 * until then, and this engine drives the same state, controlled, from that point on. It renders
 * nothing.
 */
export function DataTableResizer({
  columns,
  sizing,
  resizing,
  onSizingChange,
  onResizingChange,
  direction,
  startRef,
  onReady,
}: {
  columns: { id: string; size: number; minSize: number; maxSize: number }[];
  sizing: ColumnSizingState;
  resizing: columnResizingState;
  onSizingChange: OnChangeFn<ColumnSizingState>;
  onResizingChange: OnChangeFn<columnResizingState>;
  direction: "ltr" | "rtl";
  startRef: RefObject<StartResize | null>;
  /** Called once the engine can start a resize. */
  onReady: () => void;
}): null {
  const table = useTable({
    features,
    columns,
    data: NO_ROWS,
    state: { columnSizing: sizing, columnResizing: resizing },
    onColumnSizingChange: onSizingChange,
    onColumnResizingChange: onResizingChange,
    columnResizeMode: "onChange",
    columnResizeDirection: direction,
  });
  useLayoutEffect(() => {
    startRef.current = (columnId, event) => {
      const header = table.getFlatHeaders().find((h) => h.column.id === columnId);
      header?.getResizeHandler()(event);
    };
  });
  useLayoutEffect(() => {
    onReady();
    return () => {
      startRef.current = null;
    };
    // Once per mount: the handle that loaded the engine may be waiting to start its drag.
  }, []);
  return null;
}
