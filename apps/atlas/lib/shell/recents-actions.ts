"use server";

import { getOrgContext } from "./context";
import { recentProjectLinks, type NavLinkModel } from "./nav-model";
import { recentProjects } from "./recents";
import { sitemap } from "./sitemap";
import { getTranslate } from "./translate";

/**
 * The links under the pinned Projects entry, read again once the person opens a project. The shell stays mounted
 * from page to page, so without this the project they just opened would join the list only on the next full load
 * (Section 4.5.2). Built by the same navigation model as the first render, so it respects the same permissions.
 */
export async function recentProjectLinksAction(orgSlug: string): Promise<readonly NavLinkModel[]> {
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) return [];
  const [t, recent] = await Promise.all([getTranslate(), recentProjects(ctx)]);
  return recentProjectLinks(sitemap, recent, { nav: ctx.nav, params: { org: ctx.org.slug }, t });
}
