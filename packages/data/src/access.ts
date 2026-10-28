import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import type { Database } from "./database.types.ts";

/**
 * Access transparency (A36, migration 1062; Section 8.4): View as role and Why can I see this. A
 * preview caps every capability at the viewer's own reach, and an explanation names only paths of the
 * signed-in person to a record they can already read.
 */

export type Reach = Database["app"]["Enums"]["capability_reach"];

export interface PreviewCapability {
  readonly capability: string;
  readonly roleReach: Reach;
  readonly viewerReach: Reach | null;
  /** The lesser of the two; null when the viewer lacks the capability. */
  readonly previewReach: Reach | null;
}

export function viewAsCapabilities(
  db: XosClient,
  orgId: string,
  roleId: string,
): Promise<Result<PreviewCapability[]>> {
  return rpc(db, "view_as_capabilities", { p_org_id: orgId, p_role_id: roleId }, (data) =>
    ((data as Raw[] | null) ?? []).map((r) => ({
      capability: str(r["capability_code"]),
      roleReach: str(r["role_reach"]) as Reach,
      viewerReach: strOrNull(r["viewer_reach"]) as Reach | null,
      previewReach: strOrNull(r["preview_reach"]) as Reach | null,
    })),
  );
}

/** The capabilities a preview grants at organization reach, the set the shell narrows controls to. */
export function previewOrgCapabilities(capabilities: readonly PreviewCapability[]): Set<string> {
  return new Set(
    capabilities.filter((c) => c.previewReach === "organization").map((c) => c.capability),
  );
}

export type AccessPathKind =
  | "Membership"
  | "Project Membership"
  | "Capability Grant"
  | "Record Grant"
  | "Support Session"
  | "Delegation"
  | "Policy";

export interface AccessPath {
  readonly kind: AccessPathKind;
  readonly label: string;
  readonly detail: string | null;
  readonly validTo: string | null;
}

/** Why the signed-in person can see a record of an app table; not-found when they cannot. */
export function explainAccess(
  db: XosClient,
  table: string,
  id: string,
): Promise<Result<AccessPath[]>> {
  return rpc(db, "explain_access", { p_subject_table: table, p_subject_id: id }, (data) =>
    ((data as Raw[] | null) ?? []).map((r) => ({
      kind: str(r["path_kind"]) as AccessPathKind,
      label: str(r["label"]),
      detail: strOrNull(r["detail"]),
      validTo: strOrNull(r["valid_to"]),
    })),
  );
}

/** The cookie that holds a View as preview: `<org slug>:<role id>`. */
export const VIEW_AS_COOKIE = "xos-view-as";

export function parseViewAsCookie(value: string | undefined, orgSlug: string): string | null {
  if (!value) return null;
  const [slug, roleId] = value.split(":");
  if (slug !== orgSlug || !roleId || !/^[0-9a-f-]{36}$/.test(roleId)) return null;
  return roleId;
}
