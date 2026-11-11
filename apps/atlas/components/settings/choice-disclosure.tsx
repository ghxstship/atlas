"use client";

import { Icon } from "@xos/ui";
import { useCallback, useRef, useState, type ReactNode } from "react";

/**
 * A group of choices inside a form, closed behind a summary of what is chosen (Section 11.10, Section 18 gate 27: a
 * form shows at most seven fields and puts the rest behind progressive disclosure). Long checkbox lists (departments,
 * event types, scopes) and each row of the notification matrix use it, so the page opens on a few summaries rather
 * than dozens of boxes. Closed, the choices stay in the DOM, hidden, so they keep their values and submit with the
 * form; the summary keeps what is chosen readable without opening it.
 */
export function ChoiceDisclosure({
  title,
  summary,
  open = false,
  children,
}: {
  title: string;
  /** What is chosen, in words, for example "3 chosen" or "In app, Email". */
  summary: string;
  /** Opens the group, for example when one of its choices has an error to show. */
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group/choice rounded-card border border-border-subtle">
      <summary className="flex min-h-target-fine cursor-pointer list-none flex-wrap items-center gap-x-8 gap-y-2 px-12 py-8 pointer-coarse:min-h-target-coarse [&::-webkit-details-marker]:hidden">
        <Icon
          name="ChevronRight"
          size={14}
          className="shrink-0 text-text-secondary transition-transform duration-fast ease-standard group-open/choice:rotate-90 group-open/choice:rtl:-rotate-90"
        />
        <span className="text-text-13 font-medium text-text-primary">{title}</span>
        <span className="text-text-12 text-text-secondary">{summary}</span>
      </summary>
      {/* Not displayed while closed, as the Accordion's kept-mounted content is: a closed details only skips
          painting its content, which still has a box, so a closed group would still read as shown. */}
      <div className="flex flex-col gap-8 px-12 pb-12 group-not-open/choice:hidden">{children}</div>
    </details>
  );
}

const CHECKED = "input[type=checkbox]:checked";

/**
 * How many boxes inside the element given the returned ref are checked, for a ChoiceDisclosure summary. It counts
 * when the element mounts, when a box changes (pass `recount` as its onChange) and when the form resets (Discard, or
 * the reset after a save).
 */
export function useCheckedCount<T extends HTMLElement>(initial: number) {
  const node = useRef<T | null>(null);
  const [count, setCount] = useState(initial);
  const recount = useCallback(() => {
    if (node.current) setCount(node.current.querySelectorAll(CHECKED).length);
  }, []);
  const ref = useCallback(
    (el: T | null) => {
      node.current = el;
      if (!el) return;
      // A group shown again (a form swapped back in after a save) starts from what its boxes hold.
      setCount(el.querySelectorAll(CHECKED).length);
      const form = el.closest("form");
      if (!form) return;
      // The reset event fires before the boxes return to their defaults, so count once they have.
      const onReset = () => setTimeout(recount, 0);
      form.addEventListener("reset", onReset);
      return () => form.removeEventListener("reset", onReset);
    },
    [recount],
  );
  return { ref, count, recount };
}
