import { systemRoleForBand, type XosClient } from "@xos/data";
import { parseViewAsCookie, previewOrgCapabilities, viewAsCapabilities } from "@xos/data/access";
import type { Membership } from "@/lib/shell/membership";

/**
 * View as role (A36, Section 8.4). While the View as cookie names a role for this org, the shell shows
 * the org as that role: navigation, search and the command menu follow the role, and controls follow
 * app.view_as_capabilities, which caps every capability at the viewer's own reach. Reads keep the
 * viewer's own row level security, so a preview never shows more than the viewer may already see.
 * Only roles at or below the viewer's own band can be previewed.
 */

export interface ViewAsPreview {
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleName: string | null;
  readonly system: boolean;
}

export interface PreviewedMembership extends Membership {
  readonly preview: ViewAsPreview | null;
}

export async function applyViewAs(
  db: XosClient,
  membership: Membership,
  cookieValue: string | undefined,
): Promise<PreviewedMembership> {
  const roleId = parseViewAsCookie(cookieValue, membership.org.slug);
  if (
    !roleId ||
    !membership.capabilities.has("org.view_as_role.use") ||
    membership.org.bestBand === null
  ) {
    return { ...membership, preview: null };
  }
  const { data: role, error } = await db
    .from("roles")
    .select("id, code, name, band, org_id")
    .eq("id", roleId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Cannot read the previewed role: ${error.message}`);
  if (!role || role.band < membership.org.bestBand) return { ...membership, preview: null };
  const capabilities = await viewAsCapabilities(db, membership.org.id, roleId);
  if (!capabilities.ok) {
    if (capabilities.error.kind === "refusal" || capabilities.error.kind === "not-found") {
      return { ...membership, preview: null };
    }
    throw new Error(`Cannot preview the role: ${JSON.stringify(capabilities.error)}`);
  }
  const previewRole = systemRoleForBand(role.band);
  return {
    ...membership,
    role: previewRole,
    capabilities: previewOrgCapabilities(capabilities.data),
    nav: { ...membership.nav, role: previewRole },
    preview: { roleId, roleCode: role.code, roleName: role.name, system: role.org_id === null },
  };
}
