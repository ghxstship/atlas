import type { ArchiveFilter } from "@xos/data/places";
import { archivedOf } from "@/lib/archive/param";
import { param } from "../kit/views";

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** The venues the list loads for the Archived filter (`?archived=include|only`, A124). */
export function archiveOf(search: SearchParams): ArchiveFilter {
  const value = archivedOf(search);
  if (value === "only") return "archived";
  if (value === "include") return "all";
  return "live";
}

/**
 * The query changes that move the older `?archive=archived|all` (which the other Places collections
 * still use) to the Archived filter, or undefined when the link has no `archive`. The venue list sends
 * such a link once to the same list with `archived=`, so saved views and bookmarks open as they did
 * while the filter control, the export and the list all read one parameter. When both are present,
 * `archived` wins.
 */
export function legacyArchiveChanges(
  search: SearchParams,
): Record<string, string | undefined> | undefined {
  const legacy = param(search, "archive");
  if (legacy === undefined) return undefined;
  const mapped = legacy === "archived" ? "only" : legacy === "all" ? "include" : undefined;
  return { archive: undefined, archived: param(search, "archived") ?? mapped };
}
