import { listWorkforceRoles, type WorkforceRole } from "@xos/data/people";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/** The 61 canon workforce roles (xpms.dim_role) by code, read once per request. */
export const workforceRoles = cache(
  async (ctx: OrgContext): Promise<Map<string, WorkforceRole>> => {
    const roles = await listWorkforceRoles(ctx.viewer.db);
    if (!roles.ok) throw new Error(`Cannot read canon workforce roles: ${roles.error.kind}`);
    return new Map(roles.data.map((r) => [r.code, r]));
  },
);
