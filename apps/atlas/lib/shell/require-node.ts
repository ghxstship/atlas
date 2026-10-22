import { getNode, isNodeVisible, routeParams } from "@xos/ia";
import { notFound } from "next/navigation";
import { DATA_PARAMS, PAGE_RESOLVED_PARAMS } from "@/ia/routes.config";
import { getProjectContextFor } from "@/lib/projects/context";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

type Params = Readonly<Record<string, string>>;

/**
 * Route guard for a page (ADR 0006, Section 4.5.9): the org context must exist, the node must be
 * visible to the viewer's role, conditions and modules, and any data row the route names must
 * resolve. Anything else is 404, never 403. The proxy runs the same guard first.
 */
export async function requireNode(node: string, params: Params): Promise<OrgContext> {
  const slug = params["org"] ?? params["partnerSlug"];
  const ctx = slug === undefined ? null : await getOrgContext(slug);
  if (!ctx || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  const route = getNode(sitemap, node).node.route ?? "";
  // Routes naming a project resolve it through A07's project context: a project the viewer may
  // not read answers 404 (invariant 2). Routes naming another data row belong to their module
  // agents: records (A08), saved views (A31) and custom objects (A18). Each owner replaces its
  // page with a lookup; until then those routes answer 404.
  // The workspace and team settings pages look their row up themselves (PAGE_RESOLVED_PARAMS).
  const rowParams = routeParams(route).filter(
    (p) =>
      (DATA_PARAMS as readonly string[]).includes(p) &&
      !(PAGE_RESOLVED_PARAMS as readonly string[]).includes(p),
  );
  if (rowParams.some((p) => p !== "projectKey")) notFound();
  if (rowParams.includes("projectKey") && !(await getProjectContextFor(params))) notFound();
  return ctx;
}
