"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NavLinkModel } from "@/lib/shell/nav-model";
import { recentProjectLinksAction } from "@/lib/shell/recents-actions";

/** Sent on window when a project page opens; the detail is the project's address. */
const PROJECT_OPENED_EVENT = "xos:project-opened";

const NONE: readonly NavLinkModel[] = [];

/**
 * Rendered by the project frame: tells the shell which project just opened, after the page noted the view
 * (app.record_recent_view), so the sidebar's recent projects list it without a reload (Section 4.5.2).
 */
export function ProjectOpened({ href }: { readonly href: string }) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(PROJECT_OPENED_EVENT, { detail: href }));
  }, [href]);
  return null;
}

/**
 * The pinned sidebar entries with the recent projects under Projects kept current. The shell stays mounted from page
 * to page, so when a project opens that is not already first, the links are read again from the server
 * (recentProjectLinksAction), built by the same navigation model and permissions as the first render.
 */
export function useRecentProjects(
  org: string,
  pinned: readonly NavLinkModel[],
): readonly NavLinkModel[] {
  const [fresh, setFresh] = useState<readonly NavLinkModel[] | null>(null);
  // A new render from the server brings its own list; take it.
  const [source, setSource] = useState(pinned);
  if (source !== pinned) {
    setSource(pinned);
    setFresh(null);
  }
  const projects = pinned.find((l) => l.id === "projects");
  const shown = fresh ?? projects?.children ?? NONE;
  const first = useRef(shown[0]?.href);
  useEffect(() => {
    first.current = shown[0]?.href;
  }, [shown]);

  const listsProjects = projects !== undefined;
  // A layout effect, so the listener is in place before the project frame's effect sends its event.
  useLayoutEffect(() => {
    if (!listsProjects) return;
    let live = true;
    const opened = (event: Event) => {
      if ((event as CustomEvent<string>).detail === first.current) return;
      recentProjectLinksAction(org).then(
        (links) => {
          if (live) setFresh(links);
        },
        (error: unknown) => console.error("Cannot read the recent projects", error),
      );
    };
    window.addEventListener(PROJECT_OPENED_EVENT, opened);
    return () => {
      live = false;
      window.removeEventListener(PROJECT_OPENED_EVENT, opened);
    };
  }, [org, listsProjects]);

  return useMemo(
    () =>
      fresh === null
        ? pinned
        : pinned.map((l) => {
            if (l.id !== "projects") return l;
            const entry: NavLinkModel = { id: l.id, label: l.label, href: l.href, icon: l.icon };
            return fresh.length > 0 ? { ...entry, children: fresh } : entry;
          }),
    [pinned, fresh],
  );
}
