import { findRoute } from "@xos/ia";
import { clientSitemap, listNodes } from "@/ia/sitemap.client.generated";
import type { PeekHandoff } from "./peek-handoff";

/**
 * The shell's global `?peek={recordKey}` (Section 4.5.3: the side peek uses `?peek={recordKey}` on any
 * route; the sitemap's globalQuery). A collection page (a node with a list) opens the rows of its own
 * collection in its own peek or, with `&full=1`, as its full record page, so the shell leaves `?peek`
 * to it unless the page hands a key over (lib/shell/peek-handoff.ts). On every other route (home,
 * inbox, dashboards, settings, the Aurora center, a record's full page) the shell opens the record the
 * key names. Aurora citation links and proposed sitemap nodes build their links with peekHref.
 */
/**
 * Lists that open no peek of their own (their rows link elsewhere, open nothing, as the chart of
 * accounts' and the posting-line export's do with `activatable={false}`, or open the shell's peek
 * with a record key, as My Work's do), so the shell opens `?peek`. A list page that reads no
 * `?peek` belongs here, and one here puts no row's id in `?peek` (test/peek-handoff.test.ts).
 */
const NO_OWN_PEEK_NODES: ReadonlySet<string> = new Set([
  "activity.audit-log",
  "activity.feed",
  "approvals",
  "credentials.access-grid",
  "credentials.scan-log",
  "finance.chart-of-accounts",
  "finance.universal-posting-line-export",
  "home.alerts",
  "home.gate-readiness",
  "home.recent",
  "home.today",
  "inbox",
  "my-work",
  "opportunities.engagements",
  "opportunities.onboarding",
  "opportunities.pipeline",
  "opportunities.pools",
  "opportunities.postings",
  "opportunities.ratings",
  "opportunities.requisitions",
  "project.activity",
  "project.engagements",
  "project.gates",
  "project.scope",
  "projects.templates",
  "reports.budget-versus-actual",
  "reports.coordinate-matrix",
  "reports.dashboards",
  "reports.final-cost-report",
  "reports.gate-readiness",
  "reports.incidents",
  "reports.labor",
  "reports.measurement",
  "reports.purchase-order-exposure",
  "site-ops.weather",
  "trash",
]);

export function pageOwnsPeek(pathname: string): boolean {
  const match = findRoute(clientSitemap, pathname.split("?")[0] ?? pathname);
  if (!match || NO_OWN_PEEK_NODES.has(match.id)) return false;
  return listNodes.has(match.id);
}

/**
 * What the shell does with the URL's `?peek`: `open` the record on a page that does not peek its own
 * rows; on a collection page, leave the key to the page and open the record only when the page hands
 * it over (`handoff`: a key the collection shows no row for); and `none` without a key or on a
 * collection's full record page (`&full=1`, its Open full page), where the key is a row the page
 * renders itself, not a record key the shell can read.
 */
export type ShellPeekMode = "open" | "handoff" | "none";

export function shellPeekMode(
  pathname: string,
  search: Pick<URLSearchParams, "get">,
): ShellPeekMode {
  const key = search.get("peek");
  if (key === null || key.length === 0) return "none";
  if (!pageOwnsPeek(pathname)) return "open";
  return search.get("full") === "1" ? "none" : "handoff";
}

/**
 * Whether the shell opens the URL's `?peek` now: always where it owns the key, and on a collection
 * page only once the page has handed this key over on this path. Until then the key is the page's,
 * however long its own panel takes to appear.
 */
export function shellOpensPeek(
  pathname: string,
  search: Pick<URLSearchParams, "get">,
  handoffs: readonly PeekHandoff[],
): boolean {
  const mode = shellPeekMode(pathname, search);
  if (mode !== "handoff") return mode === "open";
  const key = search.get("peek");
  return handoffs.some((h) => h.path === pathname && h.key === key);
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
