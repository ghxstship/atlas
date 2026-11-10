"use server";

import { gatewaySearch, gatewaySearchRequest } from "@xos/data/gateway";
import { parseSearchQuery } from "@xos/data/search-query";
import { observability } from "@/lib/observability";
import { getGatewayContext } from "@/lib/shell/context";
import {
  actionItems,
  hitGroups,
  settingItems,
  type SearchResultGroup,
} from "@/lib/shell/search-index";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export type { SearchResultGroup, SearchResultItem } from "@/lib/shell/search-index";

/**
 * Gateway search, the server half (Section 11.10 item 1, trace S11.10-02, A126, ADR 0088): the command
 * menu and the phone Home ask here as the person types. It answers with the actions and settings whose
 * words match and the person's own engagements, documents, conversations and opportunities from
 * app.gateway_search, which returns only what they read in Gateway; on an org's custom domain, only that
 * org's. It runs on demand, so none of the person's rows and none of the settings registry ship with
 * a page.
 */
export async function searchGateway(input: { query: string }): Promise<SearchResultGroup[]> {
  if (typeof input?.query !== "string") return [];
  const query = input.query.trim().slice(0, 200);
  if (query.length < 2) return [];
  const ctx = await getGatewayContext();
  if (!ctx) return [];
  const t = await getTranslate();
  const parsed = parseSearchQuery(query);
  const words = [...parsed.terms, ...parsed.phrases];
  const plain = parsed.tokens.every((tk) => tk.kind === "term" && !tk.negated);

  const result = await gatewaySearch(ctx.db, {
    request: gatewaySearchRequest(parsed),
    orgId: ctx.brand.kind === "org" ? ctx.brand.org.orgId : null,
  });
  if (!result.ok) {
    observability.logger.error("Gateway search failed", { error: result.error });
  }

  const actions = plain ? actionItems({ words, sitemap, nav: ctx.nav, t }) : [];
  const settings = plain ? settingItems({ words, sitemap, nav: ctx.nav, t }) : [];
  return [
    ...(actions.length > 0
      ? [{ id: "actions" as const, label: t("gatewaySearch.groups.actions"), items: actions }]
      : []),
    ...hitGroups(result.ok ? result.data : [], t),
    ...(settings.length > 0
      ? [{ id: "settings" as const, label: t("gatewaySearch.groups.settings"), items: settings }]
      : []),
  ];
}
