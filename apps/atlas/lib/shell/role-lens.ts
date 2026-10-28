import { systemRoleForBand, type Role, type XosClient } from "@xos/data";
import {
  lensCapabilities,
  lensOrgCapabilities,
  parseRoleLensCookie,
  roleLensCapabilities,
} from "@xos/data/role-lens";
import type { NavContext } from "@xos/ia";
import type { Membership } from "./membership";

/**
 * The role lens of the org switcher (Section 4.8.1, A128, ADR 0089). A person who holds several roles in the org
 * narrows the shell to one of them for the browser session: navigation, search, the command and Create menus,
 * Home, My Work, Inbox and every control the context hides follow that role's capabilities, intersected with the
 * person's own (app.role_lens_capabilities), so the lens never shows more than All roles does. Row level security
 * and the RPCs still decide every read and write with the person's full standing.
 */
export interface RoleLens {
  /** The roles the person holds in the org; the switcher offers the lens when there are two or more. */
  readonly roles: readonly Role[];
  /** The role the lens narrows to, or null for All roles. */
  readonly role: Role | null;
  /** The lens's capabilities at any reach, for the Inbox; null for All roles. */
  readonly capabilities: ReadonlySet<string> | null;
  /** Navigation for all the person's roles: the route guard follows it, as the proxy does. */
  readonly ownNav: NavContext;
}

export interface LensedMembership extends Membership {
  readonly lens: RoleLens;
}

export async function applyRoleLens(
  db: XosClient,
  membership: Membership,
  cookieValue: string | undefined,
): Promise<LensedMembership> {
  const roles = membership.org.roles;
  const allRoles: LensedMembership = {
    ...membership,
    lens: { roles, role: null, capabilities: null, ownNav: membership.nav },
  };
  const roleId = parseRoleLensCookie(cookieValue, membership.org.slug);
  const role = roleId === null || roles.length < 2 ? undefined : roles.find((r) => r.id === roleId);
  if (!role) return allRoles;
  const capabilities = await roleLensCapabilities(db, membership.org.id, role.id);
  if (!capabilities.ok) {
    // A role the person no longer holds falls back to All roles.
    if (capabilities.error.kind === "refusal" || capabilities.error.kind === "not-found") {
      return allRoles;
    }
    throw new Error(`Cannot narrow to the role: ${JSON.stringify(capabilities.error)}`);
  }
  // The role's band, never better than the best band the person holds.
  const band = Math.max(role.band, membership.org.bestBand ?? role.band);
  const lensRole = systemRoleForBand(band);
  return {
    ...membership,
    org: { ...membership.org, roles: [role], bestBand: band },
    role: lensRole,
    capabilities: lensCapabilities(membership.capabilities, lensOrgCapabilities(capabilities.data)),
    nav: { ...membership.nav, role: lensRole },
    lens: {
      roles,
      role,
      capabilities: new Set(capabilities.data.map((c) => c.capability)),
      ownNav: membership.nav,
    },
  };
}
