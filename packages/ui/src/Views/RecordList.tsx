import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { rovingIndex } from "../lib/hooks.ts";
import { singleKeyShortcutsEnabled } from "../lib/preferences.ts";
import { type RecordListProps } from "./Views.types.ts";

/**
 * The list of RecordRows with the grid role and the list's name. Arrow Up and Down, J and K move
 * between rows; Home and End jump.
 */
export function RecordList({ label, children }: RecordListProps): ReactElement {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const rowsOf = () => [...(ref.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = rowsOf();
    const index = rows.findIndex((r) => r.contains(document.activeElement));
    const letters = singleKeyShortcutsEnabled();
    const key =
      letters && e.key === "j" ? "ArrowDown" : letters && e.key === "k" ? "ArrowUp" : e.key;
    const next = rovingIndex(key, Math.max(0, index), rows.length, "vertical");
    if (next === null || rows.length === 0) return;
    if (index === -1 && key !== "Home" && key !== "End") return;
    e.preventDefault();
    rows[next]?.focus();
  };
  return (
    <div
      ref={ref}
      role="grid"
      aria-label={label}
      tabIndex={entered ? -1 : 0}
      onFocus={(e) => {
        if (e.target === e.currentTarget) {
          rowsOf()[0]?.focus();
          setEntered(true);
        }
      }}
      onKeyDown={onKeyDown}
      className="xos-rlist flex flex-col overflow-hidden rounded-card border border-border-subtle"
    >
      {/* The list stays headless on screen; screen readers moving across a row hear which value
          each cell is (1.3.1, A23-012). */}
      <div role="row" className="sr-only">
        {["state", "key", "title", "labels", "next", "owner", "action"].map((c) => (
          <span key={c} role="columnheader">
            {t(`recordList.columns.${c}`)}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}
