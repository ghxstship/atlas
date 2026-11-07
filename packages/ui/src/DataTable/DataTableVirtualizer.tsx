import { useLayoutEffect, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** The rows a table renders, inclusive; `end` below `start` when none fit. */
export interface RowWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * The TanStack Virtual engine behind a DataTable over its row limit. DataTable loads it on the first
 * interaction with the table (ADR 0027): until then the first screen of rows needs no engine, and
 * this one moves the same window from that point on. It renders nothing.
 */
export function DataTableVirtualizer({
  count,
  rowHeight,
  overscan,
  viewport,
  scrollRef,
  scrollToRef,
  onWindow,
  onReady,
}: {
  count: number;
  rowHeight: number;
  overscan: number;
  /** The height the table has measured, until the engine has measured its own. */
  viewport: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollToRef: RefObject<((index: number) => void) | null>;
  onWindow: (window: RowWindow) => void;
  /** Called once the engine can scroll. */
  onReady: () => void;
}): null {
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    initialRect: { width: 0, height: viewport },
    // The first scroll is often what loaded the engine, and it scrolls to its offset as it mounts.
    initialOffset: () => scrollRef.current?.scrollTop ?? 0,
  });
  const items = virtualizer.getVirtualItems();
  const start = items[0]?.index ?? 0;
  const end = items[items.length - 1]?.index ?? -1;

  useLayoutEffect(() => onWindow({ start, end }), [onWindow, start, end]);
  useLayoutEffect(() => {
    scrollToRef.current = (index) => virtualizer.scrollToIndex(index);
    onReady();
    return () => {
      scrollToRef.current = null;
    };
  }, [virtualizer, scrollToRef, onReady]);
  return null;
}
