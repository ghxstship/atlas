import type { ApplicationWithOpportunity, Engagement, Representation } from "@xos/data/gateway";
import { GATEWAY_LENS_SCOPE, parseRoleLensCookie } from "@xos/data/role-lens";

/**
 * Gateway's role lens (Section 4.8.1, A128, ADR 0086). In Gateway a person's roles are the role types of their
 * engagements (Crew, Artist, Vendor and the rest, Section 4.4.2). A person with two or more narrows Home, Work and
 * the navigation to one of them for the browser session; All roles shows everything. The lens only filters what
 * the person can already see; row level security decides every read and write as before.
 */

type RoleType = Engagement["roleType"];

export interface GatewayLens {
  /** The role types of the person's engagements, in name order; the switcher offers the lens for two or more. */
  readonly roleTypes: readonly RoleType[];
  /** The role type the lens narrows to, or null for All roles. */
  readonly roleType: RoleType | null;
}

/** A role type as the lens cookie spells it: `Artist Representative` is `artist-representative`. */
export function lensSlug(roleType: RoleType): string {
  return roleType.toLowerCase().replaceAll(" ", "-");
}

/** The lens from the person's role types and the lens cookie; a role type they no longer hold is All roles. */
export function resolveGatewayLens(
  roleTypes: readonly RoleType[],
  cookie: string | undefined,
): GatewayLens {
  const sorted = [...new Set(roleTypes)].sort((a, b) => a.localeCompare(b));
  const slug = parseRoleLensCookie(cookie, GATEWAY_LENS_SCOPE, /^[a-z]+(-[a-z]+)*$/);
  const roleType =
    slug === null || sorted.length < 2 ? null : (sorted.find((r) => lensSlug(r) === slug) ?? null);
  return { roleTypes: sorted, roleType };
}

/** True when something of a role type shows under the lens. */
export function inLens(lens: GatewayLens, roleType: RoleType): boolean {
  return lens.roleType === null || lens.roleType === roleType;
}

/** The engagements the lens shows. */
export function lensEngagements<E extends Pick<Engagement, "roleType">>(
  lens: GatewayLens,
  engagements: readonly E[],
): E[] {
  return engagements.filter((e) => inLens(lens, e.roleType));
}

/** The applications the lens shows: those for an opportunity of its role type, and any whose opportunity is gone. */
export function lensApplications(
  lens: GatewayLens,
  applications: readonly ApplicationWithOpportunity[],
): ApplicationWithOpportunity[] {
  return applications.filter((a) => a.opportunity === null || inLens(lens, a.opportunity.roleType));
}

/** Representations ask the artist to accept an agent, so they belong to the Artist role. */
export function lensRepresentations(
  lens: GatewayLens,
  representations: readonly Representation[],
): Representation[] {
  return inLens(lens, "Artist") ? [...representations] : [];
}

/** The role types that decide paid-work navigation: the lens's own, else all of them. */
export function lensRoleTypes(lens: GatewayLens, all: readonly RoleType[]): readonly RoleType[] {
  return lens.roleType === null ? all : [lens.roleType];
}
