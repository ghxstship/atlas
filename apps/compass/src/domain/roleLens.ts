/**
 * The role lens in the org switcher (Section 4.8.1, A128, ADR 0086): All roles, or one of the person's roles in the
 * active org. A member narrows to one org role they hold: the screens follow that role's capabilities, intersected
 * with their own, so the lens never shows a control All roles would not. A person engaged by the org narrows to
 * one role type of their engagements (Crew, Artist and the rest): the screens follow those engagements only. The
 * lens lives in memory for the app session, per org, and never changes what the device downloads: row level
 * security and the RPCs decide every act as before.
 */
import type { Audience } from "@xos/sync";
import { lensCapabilities } from "@xos/data/role-lens";
import type { CompassIdentity } from "./access";

/** One org role the person holds, with its capabilities (role_capabilities), for the lens. */
export interface LensRole {
  readonly id: string;
  readonly code: string;
  /** A custom role's name; null for a platform role, whose label comes from the catalog. */
  readonly name: string | null;
  readonly capabilities: readonly string[];
}

/** A choice the switcher offers: an org role (member) or an engagement role type (engaged). */
export interface LensOption {
  readonly id: string;
  readonly kind: "role" | "role-type";
  /** The platform role code or the audience, for the catalog label; a custom role carries its name. */
  readonly code: string;
  readonly name: string | null;
}

/** The parts of an org context the lens reads. */
export interface LensContext {
  readonly kind: "member" | "engaged";
  readonly identity: CompassIdentity;
  readonly roles?: readonly LensRole[];
}

/** What the switcher offers in an org; empty when the person has fewer than two roles there. */
export function lensOptions(context: LensContext): LensOption[] {
  const options: LensOption[] =
    context.kind === "member"
      ? (context.roles ?? []).map((r) => ({ id: r.id, kind: "role", code: r.code, name: r.name }))
      : [...new Set(context.identity.engagements.map((e) => e.roleType))]
          .sort()
          .map((audience) => ({ id: audience, kind: "role-type", code: audience, name: null }));
  return options.length >= 2 ? options : [];
}

/** The lens actually in force: a remembered choice the person still has, else All roles (null). */
export function activeLens(context: LensContext, chosen: string | null | undefined): string | null {
  if (!chosen) return null;
  return lensOptions(context).some((o) => o.id === chosen) ? chosen : null;
}

/**
 * The identity the screens read under a lens. All roles returns it unchanged. A member keeps only the chosen
 * role's capabilities that they hold (project roles add none under a lens); an engaged person keeps only that
 * role type's engagements. `audience` picks the audience for the narrowed capabilities.
 */
export function lensIdentity(
  context: LensContext,
  chosen: string | null | undefined,
  audience: (capabilities: readonly string[]) => Audience,
): CompassIdentity {
  const lens = activeLens(context, chosen);
  const identity = context.identity;
  if (lens === null) return identity;
  if (context.kind === "member") {
    const role = context.roles?.find((r) => r.id === lens);
    if (!role) return identity;
    const capabilities = [
      ...lensCapabilities(new Set(identity.capabilities), role.capabilities),
    ].sort();
    return { ...identity, capabilities, audience: audience(capabilities) };
  }
  const engagements = identity.engagements.filter((e) => e.roleType === lens);
  return { ...identity, engagements, audience: lens as Audience };
}

/** The capabilities the Inbox narrows to under a lens: a member's narrowed set, else null (everything shows). */
export function lensInboxCapabilities(
  context: LensContext,
  chosen: string | null | undefined,
  narrowed: CompassIdentity,
): ReadonlySet<string> | null {
  if (activeLens(context, chosen) === null || context.kind !== "member") return null;
  return new Set(narrowed.capabilities);
}
