"use client";

import type { RecordKind, RecordState } from "@xos/ui";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

/** What a cell previews: a record by its key, or a person by name. */
export type HoverInfo =
  | {
      readonly kind: "record";
      readonly recordKey: string;
      readonly recordKind: RecordKind;
      readonly title: string;
      readonly state: RecordState;
      readonly stateLabel: string;
      readonly owner: string;
      readonly next: string;
    }
  | {
      readonly kind: "person";
      readonly org: string;
      readonly personId: string;
      readonly name: string;
    };

/** The card itself loads with the first hover (ADR 0027). */
const previewModule = onDemand(() => import("./hover-preview"));

/** Section 11.7: a record key previews after 400 ms. */
const OPEN_DELAY_MS = 400;

interface Shown {
  readonly info: HoverInfo;
  readonly rect: DOMRect;
  readonly cell: HTMLElement;
}

/**
 * Hover cards for a DataTable (Section 11.7): hovering a cell, or focusing it from the keyboard, for
 * 400 ms shows the card `lookup` gives for its row and column (a record key, an owner). Spread
 * `hoverProps` on an element around the table and render `card` after it. Esc, leaving or moving on
 * closes it; the cell is described by the card while it shows.
 */
export function useHoverCards(lookup: (index: number, column: string) => HoverInfo | null): {
  hoverProps: {
    onPointerOver: (event: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  card: ReactNode;
} {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<HTMLElement | null>(null);
  const read = useRef(lookup);
  useEffect(() => {
    read.current = lookup;
  });
  const loaded = useOnDemand(previewModule, shown !== null);

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const stop = () => {
    cancel();
    current.current = null;
    setShown(null);
  };
  const start = (target: EventTarget | null) => {
    const cell = target instanceof Element ? target.closest<HTMLElement>("td[data-column]") : null;
    if (cell === current.current) return;
    cancel();
    current.current = cell;
    setShown(null);
    if (!cell) return;
    const index = Number(cell.closest("tr")?.getAttribute("aria-rowindex")) - 2;
    const info =
      Number.isInteger(index) && index >= 0
        ? read.current(index, cell.dataset["column"] ?? "")
        : null;
    if (!info) return;
    void previewModule.load().catch(() => undefined);
    timer.current = setTimeout(
      () => setShown({ info, rect: cell.getBoundingClientRect(), cell }),
      OPEN_DELAY_MS,
    );
  };

  useEffect(() => {
    if (!shown) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShown(null);
    };
    const onScroll = () => setShown(null);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [shown]);
  useEffect(() => cancel, []);

  return {
    hoverProps: {
      onPointerOver: (event) => start(event.target),
      onPointerLeave: stop,
      onFocus: (event) => start(event.target),
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stop();
      },
    },
    card: loaded && shown ? <loaded.HoverPreview {...shown} /> : null,
  };
}
