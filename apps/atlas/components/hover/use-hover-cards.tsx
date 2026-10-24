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
import { hoverIntent } from "@/lib/hover/intent";

/**
 * A record's card, with every label already formatted. With its kind, state, owner and next date it
 * is the design system's HoverCard; without them it shows the key, title, `detail` and whatever else
 * it has, for rows that are not on the record spine (a shift, an invoice, an asset unit, a vendor).
 */
export interface RecordPreview {
  readonly recordKey: string;
  readonly recordKind?: RecordKind;
  readonly title: string;
  readonly state?: RecordState;
  readonly stateLabel?: string;
  readonly owner?: string;
  readonly next?: string;
  /** One more line under the title, such as a counterparty or an amount. */
  readonly detail?: string;
}

/** What a part previews: a record, a record the card reads by its key, or a person. */
export type HoverInfo =
  | ({ readonly kind: "record" } & RecordPreview)
  | { readonly kind: "recordKey"; readonly org: string; readonly recordKey: string }
  | {
      readonly kind: "person";
      readonly org: string;
      readonly personId: string;
      readonly name: string;
    };

/** The card itself loads with the first hover (ADR 0027). */
const previewModule = onDemand(() => import("./hover-preview"));

interface Shown {
  readonly info: HoverInfo;
  readonly rect: DOMRect;
  /** The part the card sits beside. */
  readonly cell: HTMLElement;
  /** The element the card describes: the part, or the row or card that has the focus. */
  readonly describes: HTMLElement;
}

/**
 * The part an event is on, and its item: an element with `data-column` inside one with `data-item`
 * (a DataTable cell in its row, a RecordRow's key, a Board card's title, a Calendar event). A row or
 * card that takes the focus itself previews its key.
 */
function partAt(
  node: EventTarget | null,
  root: HTMLElement,
  focus: boolean,
): { part: HTMLElement; item: string; column: string } | null {
  if (!(node instanceof HTMLElement)) return null;
  const found = node.closest<HTMLElement>("[data-column]");
  const item = (found ?? node).closest<HTMLElement>("[data-item]");
  if (!item || !root.contains(item)) return null;
  const part =
    found && item.contains(found)
      ? found
      : focus && node === item
        ? item.querySelector<HTMLElement>('[data-column="key"]')
        : null;
  const id = item.dataset["item"];
  const column = part?.dataset["column"];
  return part && id && column ? { part, item: id, column } : null;
}

/**
 * Hover cards (Section 11.7) on DataTable rows and on RecordList rows, Board cards and Calendar
 * events: hovering a part that names a record (its key, title or owner, an event), or focusing it
 * or its row from the keyboard, for 400 ms shows the card `lookup` gives for the item's id
 * (`data-item`) and the part's column (`data-column`). Spread `hoverProps` on an element around the
 * view and render `card` after it. Esc, leaving or moving on closes it; the part, or the focused row,
 * is described by the card while it shows.
 */
export function useHoverCards(lookup: (id: string, column: string) => HoverInfo | null): {
  hoverProps: {
    onPointerOver: (event: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  card: ReactNode;
} {
  const [shown, setShown] = useState<Shown | null>(null);
  const read = useRef(lookup);
  useEffect(() => {
    read.current = lookup;
  });
  const [intent] = useState(() =>
    hoverIntent<HTMLElement, Omit<Shown, "rect">>((value) =>
      setShown({ ...value, rect: value.cell.getBoundingClientRect() }),
    ),
  );
  const loaded = useOnDemand(previewModule, shown !== null);

  const stop = () => {
    intent.leave();
    setShown(null);
  };
  const start = (event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>, focus: boolean) => {
    const at = partAt(event.target, event.currentTarget, focus);
    const info = at ? read.current(at.item, at.column) : null;
    const describes = focus && event.target instanceof HTMLElement ? event.target : at?.part;
    const changed = intent.enter(
      at?.part ?? null,
      at && info && describes ? { info, cell: at.part, describes } : undefined,
    );
    if (!changed) return;
    setShown(null);
    if (info) void previewModule.load().catch(() => undefined);
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
  useEffect(() => intent.leave, [intent]);

  return {
    hoverProps: {
      onPointerOver: (event) => start(event, false),
      onPointerLeave: stop,
      onFocus: (event) => start(event, true),
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stop();
      },
    },
    card: loaded && shown ? <loaded.HoverPreview {...shown} /> : null,
  };
}

/**
 * Hover cards for a view whose items are named by their record key (`data-item`): the key or title
 * previews the record, read on demand as the viewer (an Activity line, a record's dependencies, the
 * punch and recurring lists).
 */
export function useRecordKeyHovers(org: string): ReturnType<typeof useHoverCards> {
  return useHoverCards((recordKey, column) =>
    column === "key" || column === "title" ? { kind: "recordKey", org, recordKey } : null,
  );
}
