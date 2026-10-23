import { findRoute } from "@xos/ia";
import { clientSitemap, listNodes } from "@/ia/sitemap.client.generated";

/**
 * The shell's global `?peek={recordKey}` (Section 4.5.3: the side peek uses `?peek={recordKey}` on any
 * route; the sitemap's globalQuery). A collection page (a node with a list) opens the rows of its own
 * collection in its own peek or, with `&full=1`, as its full record page, so the shell leaves `?peek`
 * to it. On every other route (home, inbox, dashboards, settings, the Aurora center, a record's full
 * page) the shell opens the record the key names. Aurora citation links and proposed sitemap nodes
 * build their links with peekHref.
 */
/** Pages without a list in the sitemap that still peek the rows they show: a saved view's collection. */
const OWN_PEEK_NODES: ReadonlySet<string> = new Set(["saved-view"]);

export function pageOwnsPeek(pathname: string): boolean {
  const match = findRoute(clientSitemap, pathname.split("?")[0] ?? pathname);
  if (!match) return false;
  return OWN_PEEK_NODES.has(match.id) || listNodes.has(match.id);
}

/**
 * What the shell does with the URL's `?peek`: `open` the record on a page that does not peek its own
 * rows; on a collection page, wait for the page to `claim` the key with its own peek and open the
 * record only when it does not; and `none` without a key or on a collection's full record page
 * (`&full=1`, its Open full page), where the key is a row of the collection that the page renders
 * itself, not a record key the shell can read. The full page is no dialog, so waiting for a claim
 * would never see it.
 */
export type ShellPeekMode = "open" | "claim" | "none";

export function shellPeekMode(
  pathname: string,
  search: Pick<URLSearchParams, "get">,
): ShellPeekMode {
  const key = search.get("peek");
  if (key === null || key.length === 0) return "none";
  if (!pageOwnsPeek(pathname)) return "open";
  return search.get("full") === "1" ? "none" : "claim";
}

/**
 * A link that opens a record in the side peek on the current page, or on the record's full page when
 * the current page is a collection that peeks its own rows.
 */
export function peekHref(org: string, pathname: string, search: string, recordKey: string): string {
  if (pageOwnsPeek(pathname)) return `/${org}/r/${encodeURIComponent(recordKey)}`;
  const params = new URLSearchParams(search);
  params.set("peek", recordKey);
  params.delete("full");
  return `${pathname}?${params.toString()}`;
}
