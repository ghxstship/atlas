"use client";

import { useEffect, useMemo, useState } from "react";
import type { NavLinkModel } from "@/lib/shell/nav-model";

/** Sent on window by the project frame once a project opens; the detail is the links under Projects, read anew. */
export const RECENT_PROJECTS_EVENT = "xos:recent-projects";

/**
 * The pinned sidebar entries with the recent projects under Projects kept current (Section 4.5.2). The shell stays
 * mounted from page to page, so the project frame (project-opened.tsx) reads the links again when a project opens
 * and sends them here; a new render from the server brings its own.
 */
export function useRecentProjects(pinned: readonly NavLinkModel[]): readonly NavLinkModel[] {
  const [fresh, setFresh] = useState<readonly NavLinkModel[] | null>(null);
  const [source, setSource] = useState(pinned);
  if (source !== pinned) {
    setSource(pinned);
    setFresh(null);
  }
  useEffect(() => {
    const opened = (event: Event) => setFresh((event as CustomEvent<NavLinkModel[]>).detail);
    window.addEventListener(RECENT_PROJECTS_EVENT, opened);
    return () => window.removeEventListener(RECENT_PROJECTS_EVENT, opened);
  }, []);
  return useMemo(
    () =>
      fresh === null
        ? pinned
        : pinned.map((l) => (l.id === "projects" ? { ...l, children: fresh } : l)),
    [pinned, fresh],
  );
}
