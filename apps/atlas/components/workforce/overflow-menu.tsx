"use client";

import { buttonClass, Icon } from "@xos/ui";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * A "More" disclosure for a card's secondary actions (A59-027, the five-action toolbar budget): the
 * actions are ordinary buttons and forms, so they work before hydration; Escape and a click outside
 * close it, and focus returns to the toggle on Escape.
 */
export function OverflowMenu({
  label,
  title,
  children,
}: {
  label: string;
  /** Accessible name of the toggle, naming what the actions act on. */
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        el.open = false;
        el.querySelector("summary")?.focus();
        return;
      }
      if (event.target instanceof Node && !el.contains(event.target)) el.open = false;
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, []);
  return (
    <details ref={ref} className="relative">
      <summary
        aria-label={title}
        className={`${buttonClass("ghost", "sm")} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
      >
        <Icon name="Ellipsis" size={14} />
        {label}
      </summary>
      <div className="absolute end-0 z-10 mt-4 flex w-max flex-col items-stretch gap-2 rounded-card border border-border-subtle bg-bg-raised p-4 shadow-menu">
        {children}
      </div>
    </details>
  );
}
