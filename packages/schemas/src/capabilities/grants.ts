import type {
  CapabilityDefinition,
  CapabilityReach,
  CapabilityRegistry,
  ModuleDefinition,
  RoleCode,
  RoleGrant,
} from "./model.ts";
import { ROLE_CODES } from "./model.ts";

/** Member write, approve and export in a project-scoped module reach only assigned projects. */
const MEMBER_ASSIGNED_CLASSES = new Set(["write", "approve", "export"]);

/**
 * The reach a role holds on one capability, or null when it holds none.
 * Rules are documented at the top of capabilities.yaml.
 */
export function grantFor(
  role: RoleCode,
  module: ModuleDefinition,
  capability: CapabilityDefinition,
): CapabilityReach | null {
  if (capability.roles !== null) return capability.roles[role] ?? null;
  const cls = capability.class;
  switch (module.visibility[role]) {
    case "full":
      if (role === "member") {
        if (cls === "manage") return null;
        if (module.projectScoped && MEMBER_ASSIGNED_CLASSES.has(cls)) return "assigned";
      }
      return "organization";
    case "read":
      return cls === "read" ? "organization" : null;
    case "assigned":
      return cls === "read" || cls === "write" ? "assigned" : null;
    case "own":
      return capability.own && (cls === "read" || cls === "write") ? "own" : null;
    case "hidden":
      return null;
  }
}

/** Every default role grant, ordered by role band, then registry order of capabilities. */
export function deriveRoleGrants(registry: CapabilityRegistry): RoleGrant[] {
  const grants: RoleGrant[] = [];
  for (const role of ROLE_CODES) {
    for (const module of registry.modules) {
      for (const capability of module.capabilities) {
        const reach = grantFor(role, module, capability);
        if (reach !== null) grants.push({ role, capability: capability.code, reach });
      }
    }
  }
  return grants;
}

/** Grants of one role as a map from capability code to reach. */
export function grantsByRole(
  registry: CapabilityRegistry,
): Record<RoleCode, Map<string, CapabilityReach>> {
  const byRole = Object.fromEntries(ROLE_CODES.map((r) => [r, new Map()])) as Record<
    RoleCode,
    Map<string, CapabilityReach>
  >;
  for (const g of deriveRoleGrants(registry)) byRole[g.role].set(g.capability, g.reach);
  return byRole;
}

/** Every capability in registry order. */
export function allCapabilities(registry: CapabilityRegistry): CapabilityDefinition[] {
  return registry.modules.flatMap((m) => m.capabilities);
}
