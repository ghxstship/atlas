"use client";

import { Button } from "@xos/ui";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";

/** The QR code loads only when the person opens the control, so pages carry no QR encoder. */
const HandoffCode = lazy(() => import("./handoff-code"));

export interface ContinueOnDeviceLabels {
  readonly button: string;
  readonly title: string;
  readonly sentence: string;
  readonly qr: string;
  readonly link: string;
}

/**
 * Continue on another device (Section 11.10 item 13, ADR 0030): a QR code that opens this item in
 * Compass. The server builds the link (`@xos/ia/handoff`) and passes the copy already translated.
 * A plain disclosure rather than an overlay component, so no overlay code joins the pages' shared
 * chunks (route JavaScript budget, ADR 0027); Esc and a click outside close it.
 */
export function ContinueOnDevice({
  url,
  labels,
}: {
  readonly url: string;
  readonly labels: ContinueOnDeviceLabels;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  return (
    <div ref={root} className="relative inline-flex">
      <Button
        variant="ghost"
        size="sm"
        icon="Smartphone"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {labels.button}
      </Button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          data-handoff=""
          className="absolute end-0 top-full z-popover mt-4 flex w-(--ui-popover) max-w-[calc(100vw-var(--space-32))] flex-col items-center gap-8 rounded-card border border-border-subtle bg-bg-raised p-12 text-text-primary shadow-menu"
        >
          <strong id={titleId} className="self-start font-semibold">
            {labels.title}
          </strong>
          <p className="m-0 text-text-secondary">{labels.sentence}</p>
          <Suspense fallback={null}>
            <HandoffCode url={url} label={labels.qr} />
          </Suspense>
          <p className="m-0 w-full text-text-12 text-text-secondary">
            <span className="sr-only">{labels.link} </span>
            <code className="block break-all font-mono" data-handoff-url="">
              {url}
            </code>
          </p>
        </div>
      ) : null}
    </div>
  );
}
