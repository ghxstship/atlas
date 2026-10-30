import { parseArchived, type ArchivedFilter } from "@xos/data/archive";

/** The Archived filter a page's query string asks for (`?archived=include|only`, A124). */
export function archivedOf(
  search: Readonly<Record<string, string | string[] | undefined>>,
): ArchivedFilter {
  const value = search["archived"];
  return parseArchived(Array.isArray(value) ? value[0] : value);
}
