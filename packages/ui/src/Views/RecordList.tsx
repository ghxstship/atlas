import {
  Children,
  createContext,
  isValidElement,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { useFormat, useT } from "../lib/context.tsx";
import { rovingIndex } from "../lib/hooks.ts";
import { singleKeyShortcutsEnabled } from "../lib/preferences.ts";
import { isMenuKey, useItemSelection, type ItemSelect } from "../lib/selection.ts";
import { type RecordListProps } from "./Views.types.ts";

/** A selectable list's selection, for its rows' checkboxes and selected state. */
export const RecordListSelection = createContext<ItemSelect | null>(null);

/**
 * The list of RecordRows with the grid role and the list's name. Arrow Up and Down, J and K move
 * between rows; Home and End jump. With `selection`, rows select as in DataTable: a row's checkbox,
 * Cmd or Ctrl+click and Shift+click, X and Shift+X on the focused row, Cmd or Ctrl+A for every row
 * and Esc to clear. Right-click, Shift+F10 or the Context Menu key on a row calls
 * `onItemContextMenu` with the row's id.
 */
export function RecordList({
  label,
  children,
  selection,
  onItemContextMenu,
}: RecordListProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const rowsOf = () => [...(ref.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const select = useItemSelection(selection, () =>
    rowsOf().flatMap((r) => (r.dataset["item"] ? [r.dataset["item"]] : [])),
  );
  /** The row an event happened in, with its id when it has one. */
  const rowAt = (target: EventTarget) => {
    const row = target instanceof Element ? target.closest<HTMLElement>("[data-row]") : null;
    return row && ref.current?.contains(row) ? row : null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = rowsOf();
    const index = rows.findIndex((r) => r.contains(document.activeElement));
    const focused = rows[index];
    const id = focused?.dataset["item"];
    // Selection and the menu act on the focused row itself, never on a control inside it.
    if (id && focused === e.target && !e.defaultPrevented) {
      if (onItemContextMenu && isMenuKey(e)) {
        e.preventDefault();
        onItemContextMenu(id, null, focused);
        return;
      }
      if (select.onKey(e, id)) return;
    }
    const letters = singleKeyShortcutsEnabled();
    const key =
      letters && e.key === "j" ? "ArrowDown" : letters && e.key === "k" ? "ArrowUp" : e.key;
    const next = rovingIndex(key, Math.max(0, index), rows.length, "vertical");
    if (next === null || rows.length === 0) return;
    if (index === -1 && key !== "Home" && key !== "End") return;
    e.preventDefault();
    rows[next]?.focus();
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const id = rowAt(e.target)?.dataset["item"];
    if (id) select.onClick(e, id);
  };
  const grid = (
    <div
      ref={ref}
      role="grid"
      aria-label={label}
      aria-multiselectable={selection ? true : undefined}
      tabIndex={entered ? -1 : 0}
      onFocus={(e) => {
        if (e.target === e.currentTarget) {
          rowsOf()[0]?.focus();
          setEntered(true);
        }
      }}
      onKeyDown={onKeyDown}
      {...(selection
        ? {
            onClick,
            onMouseDown: (e: MouseEvent<HTMLDivElement>) => {
              // Shift+click selects a range, not the text between.
              if (e.shiftKey && rowAt(e.target)) e.preventDefault();
            },
          }
        : {})}
      {...(onItemContextMenu
        ? {
            onContextMenu: (e: MouseEvent<HTMLDivElement>) => {
              const row = rowAt(e.target);
              const id = row?.dataset["item"];
              if (!row || !id) return;
              e.preventDefault();
              onItemContextMenu(id, { x: e.clientX, y: e.clientY }, e.target as HTMLElement);
            },
          }
        : {})}
      className="xos-rlist flex flex-col overflow-hidden rounded-card border border-border-subtle"
    >
      {/* The list stays headless on screen; screen readers moving across a row hear which value
          each cell is (1.3.1, A23-012). */}
      <div role="row" className="sr-only">
        {[
          ...(selection ? ["select"] : []),
          "state",
          "key",
          "title",
          "labels",
          "next",
          "owner",
          "action",
        ].map((c) => (
          <span key={c} role="columnheader">
            {t(`recordList.columns.${c}`)}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
  if (!selection) return grid;
  // The rows of this list that are selected: lists on one page may share a selection.
  const count = Children.toArray(children).filter(
    (child) =>
      isValidElement<{ id?: unknown }>(child) &&
      typeof child.props.id === "string" &&
      select.isSelected(child.props.id),
  ).length;
  return (
    <RecordListSelection value={select}>
      <span role="status" className="sr-only">
        {count > 0 ? t("bulk.selected", { n: fmt.number(count) }) : ""}
      </span>
      {grid}
    </RecordListSelection>
  );
}
