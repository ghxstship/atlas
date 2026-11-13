import { listRoleCapabilities } from "@xos/data";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Capabilities whose every write policy takes them only org-wide (private.orgs_with_capability): venues and their
 * levels, specs and contacts take places.venue.write, spaces, zones, geofences and levels places.space.write. A Field
 * lead or Collaborator holds both at assigned reach, which those policies refuse, so offering Add venue, Add space or
 * Add zone to them only led to "Not saved" and a cleared form (crawl 4.9).
 */
export const ORG_REACH_ONLY = ["places.venue.write", "places.space.write"] as const;

/**
 * The held set for showing controls: every capability held at any reach, except an org-reach-only one, which counts
 * only when it is held org-wide (`orgWide`, the context's set).
 */
export function controlCapabilities(
  held: Iterable<string>,
  orgWide: ReadonlySet<string>,
): ReadonlySet<string> {
  const orgOnly: ReadonlySet<string> = new Set(ORG_REACH_ONLY);
  return new Set([...held].filter((c) => !orgOnly.has(c) || orgWide.has(c)));
}

/**
 * Capabilities the viewer holds at any reach (organization, assigned or own), for showing controls.
 * Project-scoped work (a Coordinator writing permits on their project) is held at assigned reach, so
 * the org-wide set on the context is not enough to decide whether to show a button. The places writes
 * the policies take only org-wide (ORG_REACH_ONLY) count only at organization reach. Row level
 * security and the RPCs still decide every write; a refused write comes back with its reason.
 */
export const heldCapabilities = cache(async (ctx: OrgContext): Promise<ReadonlySet<string>> => {
  const result = await listRoleCapabilities(
    ctx.viewer.db,
    ctx.org.roles.map((r) => r.id),
  );
  if (!result.ok) throw new Error(`Cannot read capabilities: ${JSON.stringify(result.error)}`);
  return controlCapabilities(result.data.keys(), ctx.capabilities);
});
