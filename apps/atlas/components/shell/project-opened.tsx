"use client";

import { useEffect } from "react";
import { recentProjectLinksAction } from "@/lib/shell/recents-actions";

/** Heard by the shell (recent-projects.tsx); each file spells it, so the shell shares no module with this one. */
const RECENT_PROJECTS_EVENT = "xos:recent-projects";

/**
 * Rendered by the project frame, after the page noted the view (app.record_recent_view): reads the links under
 * Projects again and hands them to the shell, so the project just opened leads the recent projects without a reload
 * (Section 4.5.2). The read lives here, in the project pages, rather than in the shell every page carries.
 */
export function ProjectOpened({ org, href }: { readonly org: string; readonly href: string }) {
  useEffect(() => {
    let live = true;
    recentProjectLinksAction(org).then(
      (links) => {
        if (live) window.dispatchEvent(new CustomEvent(RECENT_PROJECTS_EVENT, { detail: links }));
      },
      (error: unknown) => console.error("Cannot read the recent projects", error),
    );
    return () => {
      live = false;
    };
  }, [org, href]);
  return null;
}
