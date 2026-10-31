"use client";

import { Maximize2, X } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The side peek (Section 11.7): a record opened from a list without leaving it. The URL carries the
 * open record (`?peek=<id>`), so the peek survives a reload and can be shared; Escape and the close
 * link return to the list. Below md it covers the screen (Section 11.6). Focus moves to the title on
 * open so a keyboard or screen reader user lands in the record. The panel is a record region for the
 * shell's record shortcuts (@xos/ui/shortcut-targets), with Open full as the Open full page target.
 */
export function PeekPanel({
  title,
  recordKey,
  kindLabel,
  closeHref,
  fullHref,
  closeLabel,
  fullLabel,
  children,
}: {
  title: string;
  recordKey: string;
  kindLabel: string;
  closeHref: Route;
  fullHref: Route;
  closeLabel: string;
  fullLabel: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented)
        router.push(closeHref, { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeHref, router]);

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="peek-title"
      data-shortcut-scope="record"
      className="fixed inset-y-0 end-0 z-peek flex w-layout-peek max-w-full flex-col overflow-y-auto border-s border-border-subtle bg-bg-surface shadow-dialog max-md:w-full"
    >
      <header className="flex items-center justify-between gap-8 border-b border-border-subtle py-8 ps-20 pe-12">
        <span className="flex items-center gap-6 text-text-12 text-text-secondary">
          <span>{kindLabel}</span>
          <span className="font-mono">{recordKey}</span>
        </span>
        <span className="flex items-center gap-2">
          <Link
            href={fullHref}
            data-shortcut="record.open"
            aria-label={fullLabel}
            title={fullLabel}
            className="flex size-32 items-center justify-center rounded-control text-text-secondary hover:bg-bg-hover"
          >
            <Maximize2 aria-hidden="true" className="size-16" />
          </Link>
          <Link
            href={closeHref}
            scroll={false}
            aria-label={closeLabel}
            title={closeLabel}
            className="flex size-32 items-center justify-center rounded-control text-text-secondary hover:bg-bg-hover"
          >
            <X aria-hidden="true" className="size-16" />
          </Link>
        </span>
      </header>
      <div className="flex flex-col gap-20 p-20">
        <h2
          id="peek-title"
          ref={heading}
          tabIndex={-1}
          className="m-0 text-heading-20 font-semibold outline-none"
        >
          {title}
        </h2>
        {children}
      </div>
    </aside>
  );
}
