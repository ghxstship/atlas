import { getNode } from "@xos/ia";
import { sitemap } from "@/lib/shell/sitemap";

type Search = Readonly<Record<string, string | string[] | undefined>>;

/** The views a node's sitemap list allows and the one the query string picks (Section 4.5.3). */
export function pickView(node: string, search: Search): { views: string[]; view: string } {
  const list = getNode(sitemap, node).node.list;
  const views = list?.views ?? ["list"];
  const raw = search["view"];
  const requested = Array.isArray(raw) ? raw[0] : raw;
  return { views, view: views.find((v) => v === requested) ?? list?.default ?? views[0] ?? "list" };
}
