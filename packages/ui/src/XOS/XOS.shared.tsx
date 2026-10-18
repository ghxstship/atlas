import { useRef, useState, type KeyboardEvent } from "react";
import { Direction } from "radix-ui";
import type { EmergencyAuthority } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { type Translate } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type Result } from "./XOS.types.ts";

export const RESULT: Record<Result, { icon: string; className: string; key: string }> = {
  met: { icon: "CircleCheck", className: cx("text-success"), key: "result.met" },
  gap: { icon: "CircleX", className: cx("text-danger"), key: "result.gap" },
  unknown: { icon: "CircleHelp", className: cx("text-warning"), key: "result.unknown" },
};

export function ResultIcon({
  result,
  t,
  labeled = true,
}: {
  result: Result;
  t: Translate;
  labeled?: boolean;
}) {
  const r = RESULT[result];
  return (
    <span className={r.className}>
      <Icon name={r.icon} size={14} {...(labeled ? { label: t(r.key) } : {})} />
    </span>
  );
}

export const tableClass = cx("w-full border-collapse text-text-13");

export const thClass = cx(
  "h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle",
);

export const tdClass = cx("h-row-default px-12 border-b border-border-subtle whitespace-nowrap");

export const SERVICES: EmergencyAuthority["service"][] = [
  "fire",
  "ems",
  "lawEnforcement",
  "bombSquad",
  "federal",
];

/** Roving focus over the cells of an ARIA grid: arrows move, Home and End jump within a row, Ctrl with them jumps to the corners. */
export function useGridFocus(rows: number, cols: number) {
  const dir = Direction.useDirection();
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const refs = useRef(new Map<string, HTMLElement>());
  const register = (r: number, c: number) => (el: HTMLElement | null) => {
    if (el) refs.current.set(`${r}:${c}`, el);
    else refs.current.delete(`${r}:${c}`);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>, r: number, c: number) => {
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const ctrl = e.ctrlKey || e.metaKey;
    const target: [number, number] | null =
      e.key === "ArrowDown"
        ? [r + 1, c]
        : e.key === "ArrowUp"
          ? [r - 1, c]
          : e.key === forward
            ? [r, c + 1]
            : e.key === back
              ? [r, c - 1]
              : e.key === "Home"
                ? ctrl
                  ? [0, 0]
                  : [r, 0]
                : e.key === "End"
                  ? ctrl
                    ? [rows - 1, cols - 1]
                    : [r, cols - 1]
                  : null;
    if (!target) return;
    e.preventDefault();
    const next: [number, number] = [
      Math.max(0, Math.min(rows - 1, target[0])),
      Math.max(0, Math.min(cols - 1, target[1])),
    ];
    setActive(next);
    refs.current.get(`${next[0]}:${next[1]}`)?.focus();
  };
  const tabIndex = (r: number, c: number) => (active[0] === r && active[1] === c ? 0 : -1);
  return { register, onKeyDown, tabIndex, setActive };
}
