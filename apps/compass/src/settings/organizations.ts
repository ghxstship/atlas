/**
 * Settings, Organizations in Compass (Section 4.5.6 item 5, ADR 0070): every org the person belongs to or works
 * with, which one is open now, which one is their default, and leaving an org they belong to. Memberships come with
 * the roles held (listMyOrganizations, as Atlas shows them); orgs the person works with come from their engagements.
 * Gateway's company accounts are listed beside them, as Gateway's Organizations shows them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgContext } from "../data/identity";

/** A role as listMyOrganizations returns it: its own name, or a system code to translate. */
export interface HeldRole {
  readonly code: string;
  readonly name: string | null;
}

export interface OrgRow {
  readonly orgId: string;
  readonly name: string;
  readonly kind: "member" | "engaged";
  /** Roles held, for a membership; empty for an org the person only works with. */
  readonly roles: readonly HeldRole[];
  /** Engagements with the org, for an org the person works with. */
  readonly engagements: number;
  /** The org Compass shows now. */
  readonly open: boolean;
  /** The org recorded as the person's default (app.active_org_selections). */
  readonly isDefault: boolean;
  /** A membership can be left (app.leave_organization); an engagement ends with its contract, not here. */
  readonly canLeave: boolean;
}

/**
 * The person's orgs for the list: memberships first, then orgs they work with, each by name. A membership's roles
 * come from `roles` by org id when the server answered; the device does not keep them.
 */
export function organizationRows(input: {
  readonly contexts: readonly OrgContext[];
  readonly openOrgId: string | null;
  readonly defaultOrgId: string | null;
  readonly roles: ReadonlyMap<string, readonly HeldRole[]>;
  readonly brandName?: (orgId: string) => string | undefined;
}): OrgRow[] {
  const rows = input.contexts.map((c): OrgRow => ({
    orgId: c.orgId,
    name: input.brandName?.(c.orgId) || c.orgName,
    kind: c.kind,
    roles: c.kind === "member" ? (input.roles.get(c.orgId) ?? []) : [],
    engagements:
      c.kind === "engaged" ? c.identity.engagements.filter((e) => e.orgId === c.orgId).length : 0,
    open: c.orgId === input.openOrgId,
    isDefault: c.orgId === input.defaultOrgId,
    canLeave: c.kind === "member",
  }));
  const byName = (a: OrgRow, b: OrgRow) => a.name.localeCompare(b.name);
  return [
    ...rows.filter((r) => r.kind === "member").sort(byName),
    ...rows.filter((r) => r.kind === "engaged").sort(byName),
  ];
}

/**
 * The org the person chose as their default, from app.active_org_selections (0920), or null when they never chose
 * one or the read failed. Row level security returns only the caller's own row.
 */
export async function readDefaultOrg(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("active_org_selections")
    .select("org_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const orgId = (data as { org_id?: unknown }).org_id;
  return typeof orgId === "string" ? orgId : null;
}

/** The catalog key of a company account role (gateway.enums.accountRole.*): Account Owner reads accountOwner. */
export function accountRoleKey(role: string): string {
  const words = role.split(/\s+/).filter(Boolean);
  const key = words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`,
    )
    .join("");
  return `gateway.enums.accountRole.${key}`;
}

/** A role's label: a custom role's own name, else the system role's catalog label (shell.roles.*). */
export function roleLabelKey(role: HeldRole): { readonly name: string } | { readonly key: string } {
  return role.name ? { name: role.name } : { key: `shell.roles.${role.code}` };
}
