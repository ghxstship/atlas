import { fillRoute, getNode, isNodeVisible, type NavContext } from "@xos/ia";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { sitemap } from "@/ia/sitemap.generated";
import { getGatewayContext, requireContext, type GatewayContext } from "./context";

export { sitemap };

/** The URL of a node with its params filled. */
export function nodeHref(id: string, params: Readonly<Record<string, string>> = {}): Route {
  const route = getNode(sitemap, id).node.route;
  if (route === undefined) throw new Error(`Sitemap node ${id} has no route.`);
  return fillRoute(route, params) as Route;
}

/** Whether the viewer may open a node (the same rule the proxy applies). */
export function canSee(id: string, ctx: NavContext): boolean {
  return isNodeVisible(sitemap, id, ctx);
}

/**
 * Every session page starts here: it needs a signed-in person and a node their standing may see,
 * else sign-in or 404 (the proxy already decided; pages repeat it so a matcher change never opens
 * a hidden page).
 */
export async function requireNode(
  id: string,
  params: Readonly<Record<string, string>> = {},
): Promise<GatewayContext> {
  const ctx = await requireContext(nodeHref(id, params));
  if (!canSee(id, ctx.nav)) notFound();
  return ctx;
}

/** The context when someone is signed in; public pages render for everyone either way. */
export async function optionalContext(): Promise<GatewayContext | null> {
  return getGatewayContext();
}
