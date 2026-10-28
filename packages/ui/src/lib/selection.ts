import { useRef, type KeyboardEvent, type MouseEvent } from "react";
import { singleKeyShortcutsEnabled } from "./preferences.ts";

/** Items selected by id (Section 11.7). The component only reports the selection; the page keeps it. */
export interface ItemSelection {
  /** Ids of the selected items. */
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}

/** What an item's own gestures can do to the selection; see useItemSelection. */
export interface ItemSelect {
  isSelected: (id: string) => boolean;
  /** Toggles an item, or with `range` selects every item from the last toggled one to it. */
  toggle: (id: string, range: boolean) => void;
  /** X, Shift+X, Cmd or Ctrl+A and Esc on a focused item; true when the key was handled. */
  onKey: (event: KeyboardEvent<HTMLElement>, id: string) => boolean;
  /** Cmd or Ctrl+click and Shift+click on an item; true when the click was a selection. */
  onClick: (event: MouseEvent<HTMLElement>, id: string) => boolean;
}

const NONE: ItemSelect = {
  isSelected: () => false,
  toggle: () => undefined,
  onKey: () => false,
  onClick: () => false,
};

/**
 * Selection gestures for RecordList, Board and Calendar, the same as DataTable's: X toggles the
 * focused item and Shift+X selects the range from the last toggled one; Cmd or Ctrl+click toggles and
 * Shift+click selects a range; Cmd or Ctrl+A selects every item and Esc clears. X follows the
 * single-key shortcuts setting. `order` lists the item ids in reading order when a gesture happens.
 */
export function useItemSelection(
  selection: ItemSelection | undefined,
  order: () => readonly string[],
): ItemSelect {
  const anchor = useRef<string | null>(null);
  if (!selection) return NONE;
  const toggle = (id: string, range: boolean) => {
    const next = new Set(selection.selected);
    const ids = order();
    const from = anchor.current === null ? -1 : ids.indexOf(anchor.current);
    const to = ids.indexOf(id);
    if (range && from !== -1 && to !== -1 && from !== to) {
      for (const each of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(each);
    } else {
      if (!next.delete(id)) next.add(id);
      anchor.current = id;
    }
    selection.onChange(next);
  };
  return {
    isSelected: (id) => selection.selected.has(id),
    toggle,
    onKey: (event, id) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && !event.altKey && !event.shiftKey && key === "a") {
        event.preventDefault();
        selection.onChange(new Set([...selection.selected, ...order()]));
        return true;
      }
      if (!ctrl && !event.altKey && key === "x" && singleKeyShortcutsEnabled()) {
        event.preventDefault();
        toggle(id, event.shiftKey);
        return true;
      }
      if (event.key === "Escape" && selection.selected.size > 0) {
        // Esc clears the selection first; a second Esc reaches the page (closing a peek).
        event.preventDefault();
        event.stopPropagation();
        selection.onChange(new Set());
        return true;
      }
      return false;
    },
    onClick: (event, id) => {
      if (event.metaKey || event.ctrlKey) toggle(id, false);
      else if (event.shiftKey) toggle(id, true);
      else return false;
      event.preventDefault();
      return true;
    },
  };
}

/** Whether a key opens an item's context menu: Shift+F10 or the Context Menu key (Section 11.7). */
export function isMenuKey(event: KeyboardEvent<HTMLElement>): boolean {
  return (event.key === "F10" && event.shiftKey) || event.key === "ContextMenu";
}
