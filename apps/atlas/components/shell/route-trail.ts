import { findRoute } from "@xos/ia";
import { clientSitemap } from "@/ia/sitemap.client.generated";
import { breadcrumbItems, type CrumbContext } from "@/lib/shell/breadcrumbs";

/**
 * Where a page the shell navigated to sits in the sitemap: its breadcrumbs and its node (for the
 * help panel). The server shell hands over both for the page it rendered, so this module and the
 * client sitemap load with the person's first interaction, before any client navigation can need
 * them, and not with the page (ADR 0027).
 */
export function trailFor(pathname: string, context: CrumbContext, t: (key: string) => string) {
  return breadcrumbItems(clientSitemap, pathname, context, t);
}

export function nodeIdFor(pathname: string): string | null {
  return findRoute(clientSitemap, pathname)?.id ?? null;
}
