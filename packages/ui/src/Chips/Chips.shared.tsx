import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { chipClass } from "./chipClass.tsx";

/* Pressed holds the hover fill: a brightness filter took small chip text under 4.5:1 (A24-004). */
export const buttonChipClass = cx("xos-hit cursor-pointer hover:bg-bg-hover active:bg-bg-hover");

export function Chip({
  onClick,
  title,
  children,
}: {
  onClick?: (() => void) | undefined;
  title?: string;
  children: ReactNode;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        className={cx(chipClass, buttonChipClass)}
        onClick={onClick}
        title={title}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={chipClass} title={title}>
      {children}
    </span>
  );
}
