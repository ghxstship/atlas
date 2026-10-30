import { cx } from "../lib/cx.ts";

/*
 * The Sidebar's classes in a module of their own, for lists built beside it (the Atlas Favorites, which reorder):
 * a list loaded on demand can share them without pulling the Sidebar itself apart from the page that renders it.
 */

/** One sidebar item, for lists built beside the Sidebar (the Atlas Favorites, which reorder). */
export const sidebarItemClass = cx(
  "flex items-center gap-8 w-full h-control-md px-8 rounded-control border-0 bg-transparent box-border",
  "font-medium text-text-13 text-text-secondary text-start no-underline cursor-pointer",
  "hover:bg-bg-hover hover:text-text-primary aria-[current=page]:bg-bg-hover aria-[current=page]:text-text-primary",
  "pointer-coarse:min-h-target-coarse",
);

/** The sidebar's frame, for lists built beside the Sidebar so they match it. */
export const sidebarClass =
  "w-(--layout-sidebar) max-w-full p-8 box-border bg-bg-surface border border-border-subtle rounded-card print:hidden";
