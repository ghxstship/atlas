import { getNode } from "@xos/ia";
import { sitemap } from "@/lib/shell/sitemap";
import type { Translate } from "@/lib/shell/translate";
import { pickView, type AssetView } from "./views";

/**
 * The views a page offers and its default, read from the node's `list` entry in the sitemap
 * (Section 11.15: the registry decides; a view the data does not fit never appears).
 */
export function pageViews(
  node: string,
  requested: string | undefined,
  t: Translate,
): { view: AssetView; views: { value: string; label: string }[] } {
  const list = getNode(sitemap, node).node.list;
  const offered = list?.views ?? ["table"];
  const fallback = list?.default ?? offered[0] ?? "table";
  return {
    view: pickView(requested, offered, fallback),
    views: offered.map((v) => ({ value: v, label: t(`assets.views.${v}`) })),
  };
}

/** The org's operating currency for new amounts until the org base currency setting exists. */
export const DEFAULT_CURRENCY = "USD";

/** The first day of the month of an ISO date, for the calendar view. */
export function monthOf(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`;
}
