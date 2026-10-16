/**
 * The demo people the sweep signs in as (supabase/seeds/0010, shared demo password) and the
 * platform role each holds. The Viewer is not in seed 0010 yet (finding A23-001); until it is, the
 * Viewer pass skips when the sign-in fails.
 */
export const DEMO_PASSWORD = ["xos", "demo", "2026"].join("-");

export const DEMO_ORG = "demo-productions";

export const ROLES = [
  { role: "owner", email: "owner@example.com" },
  { role: "manager", email: "producer@example.com" },
  { role: "field", email: "field@example.com" },
  { role: "viewer", email: "viewer@example.com" },
] as const;

export type SweepRole = (typeof ROLES)[number]["role"];

/** Roles this run covers: A11Y_ROLES (comma separated) or all of them. */
export function activeRoles(): (typeof ROLES)[number][] {
  const wanted = (process.env["A11Y_ROLES"] ?? "").split(",").filter(Boolean);
  return wanted.length === 0 ? [...ROLES] : ROLES.filter((r) => wanted.includes(r.role));
}

export function storageStatePath(role: string): string {
  return `node_modules/.cache/a11y/atlas-${role}.json`;
}
