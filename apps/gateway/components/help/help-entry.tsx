"use client";

import { useEffect, useState } from "react";
import { installRecentErrors } from "@/lib/recent-errors";
import type { HelpPanel } from "./help-panel";

/** The panel module; the type import keeps it out of the page's JavaScript. */
interface PanelModule {
  readonly HelpPanel: typeof HelpPanel;
}

let loading: Promise<PanelModule> | null = null;

/** Fetches the help panel once; a failed fetch (offline, a new deploy) may succeed next time. */
function loadPanel(): Promise<PanelModule> {
  loading ??= import("./help-panel").catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/**
 * Help in the Gateway shell (Section 11.16). The shell's Help button, the avatar menu's Help and the
 * `?` key open it. The panel, the article index and the article bodies load the first time Help
 * opens, never with the page (ADR 0027), so this part only records the visit's errors for a support
 * request and fetches the panel.
 */
export function HelpEntry({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [panel, setPanel] = useState<PanelModule | null>(null);

  useEffect(() => installRecentErrors(window), []);

  useEffect(() => {
    if (!open || panel) return;
    let live = true;
    loadPanel().then(
      (m) => {
        if (live) setPanel(() => m);
      },
      (error: unknown) => console.error("Help did not load", error),
    );
    return () => {
      live = false;
    };
  }, [open, panel]);

  return panel ? <panel.HelpPanel open={open} onOpenChange={onOpenChange} /> : null;
}
