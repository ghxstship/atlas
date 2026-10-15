import { listRoleCapabilities } from "@xos/data";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Capabilities the viewer holds at any reach (organization, assigned or own), for showing controls.
 * Project-scoped work (a Coordinator writing permits on their project) is held at assigned reach, so
 * the org-wide set on the context is not enough to decide whether to show a button. Row level
 * security and the RPCs still decide every write; a refused write comes back with its reason.
 */
export const heldCapabilities = cache(async (ctx: OrgContext): Promise<ReadonlySet<string>> => {
  const result = await listRoleCapabilities(
    ctx.viewer.db,
    ctx.org.roles.map((r) => r.id),
  );
  if (!result.ok) throw new Error(`Cannot read capabilities: ${JSON.stringify(result.error)}`);
  return new Set(result.data.keys());
});
