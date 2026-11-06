"use client";

import { Button } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

/** How often the muster list reads itself again while it is not paused (WCAG 2.2.2 lets the viewer pause it). */
const REFRESH_MS = 30_000;

/**
 * The muster list's refresh (B8, G-149): it rereads the page every 30 seconds in a transition, says when the list was
 * read, and can be paused. The pause button names itself by its label only, and the time is not a live region, so a
 * screen reader is not interrupted every 30 seconds. Hidden on the printed copy.
 */
export function MusterRefresh({
  updated,
  pauseLabel,
  resumeLabel,
}: {
  updated: string;
  pauseLabel: string;
  resumeLabel: string;
}) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => startTransition(() => router.refresh()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [paused, router]);

  return (
    <div className="flex flex-wrap items-center gap-8 print:hidden">
      <p className="m-0 text-text-12 text-text-secondary">{updated}</p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setPaused((p) => !p);
          if (paused) startTransition(() => router.refresh());
        }}
      >
        {paused ? resumeLabel : pauseLabel}
      </Button>
    </div>
  );
}
