import type { ReactElement } from "react";
import type { KbdProps as ReferenceKbdProps } from "../types/reference";
import { cx } from "../lib/cx.ts";

export type KbdProps = ReferenceKbdProps;

const kbdClass = cx(
  "inline-flex items-center justify-center min-w-(--ui-kbd) h-(--ui-kbd) px-4 rounded-chip",
  "border border-border-strong bg-bg-surface text-text-secondary font-sans font-medium text-text-11 leading-none",
  "forced-colors:border-[CanvasText]",
);

/** One key in a shortcut. */
export function Kbd({ children }: KbdProps): ReactElement {
  return <kbd className={kbdClass}>{children}</kbd>;
}

/** A shortcut written with spaces between keys (`⌘ K`, `G then P` as `G P`) as one Kbd per key. */
export function Keys({ keys }: { keys: string }): ReactElement {
  return (
    <span className="inline-flex items-center gap-2">
      {keys
        .split(" ")
        .filter(Boolean)
        .map((key, i) => (
          <Kbd key={`${key}-${i}`}>{key}</Kbd>
        ))}
    </span>
  );
}
