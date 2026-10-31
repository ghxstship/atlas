import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { rpc, str, type Raw } from "./platform-common.ts";
import type { Reach } from "./access.ts";

/**
 * The role lens of the context switcher (Section 4.8.1, ADR 0107): All roles, or one role the person holds in
 * the org. A lens narrows what the shell shows (Home, My Work, Inbox, navigation and which controls appear) to
 * that role's capabilities, intersected with the person's own, so it never shows more than the person may already
 * do. Row level security and the RPCs decide every read and write with the person's full standing, as before.
 *
 * It reuses View as role's capability resolution (Section 8.4, app.view_as_capabilities): app.role_lens_capabilities
 * caps each capability of the role at the person's own reach, and only for a role the person holds.
 */

/** The cookie that holds the lens in Atlas and Gateway for the browser session: `<scope>:<lens id>`. */
export const ROLE_LENS_COOKIE = "xos-role-lens";

/** The scope of Gateway's lens, which spans every org the person works with. */
export const GATEWAY_LENS_SCOPE = "gateway";

/** The cookie value for a lens in a scope (an org slug, or `gateway`). */
export function roleLensCookie(scope: string, lens: string): string {
  return `${scope}:${lens}`;
}

/**
 * The lens a cookie names for a scope, or null for All roles: the cookie is missing, belongs to another scope or
 * does not match `pattern` (a role id in Atlas, a role type in Gateway).
 */
export function parseRoleLensCookie(
  value: string | undefined,
  scope: string,
  pattern: RegExp = /^[0-9a-f-]{36}$/,
): string | null {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at <= 0 || value.slice(0, at) !== scope) return null;
  const lens = value.slice(at + 1);
  return pattern.test(lens) ? lens : null;
}

/**
 * The capabilities a lens leaves: those of the chosen role that the person holds anyway. It is never wider than
 * `own`, whatever `role` contains, and keeps `own`'s type (Atlas types capabilities by their registered codes).
 */
export function lensCapabilities<C extends string>(
  own: ReadonlySet<C>,
  role: Iterable<string>,
): Set<C> {
  const held: ReadonlySet<string> = own;
  const out = new Set<C>();
  // Only codes `own` holds are added, so each is one of its members.
  for (const capability of role) if (held.has(capability)) out.add(capability as C);
  return out;
}

const REACH_ORDER: Readonly<Record<Reach, number>> = { own: 0, assigned: 1, organization: 2 };

/** The lesser of two reaches; null when either is null (the capability is not held). */
export function lesserReach(a: Reach | null, b: Reach | null): Reach | null {
  if (a === null || b === null) return null;
  return REACH_ORDER[a] <= REACH_ORDER[b] ? a : b;
}

export interface LensCapability {
  readonly capability: string;
  readonly roleReach: Reach;
  /** The person's own reach, from every role, grant and delegation they hold. */
  readonly viewerReach: Reach;
  /** The lesser of the two, the reach the lens shows. */
  readonly lensReach: Reach;
}

/**
 * The capabilities of a role the person holds in an org, each capped at the person's own reach
 * (app.role_lens_capabilities). A role the person does not hold is refused.
 */
export function roleLensCapabilities(
  db: XosClient,
  orgId: string,
  roleId: string,
): Promise<Result<LensCapability[]>> {
  return rpc(db, "role_lens_capabilities", { p_org_id: orgId, p_role_id: roleId }, (data) =>
    ((data as Raw[] | null) ?? []).map((r) => ({
      capability: str(r["capability_code"]),
      roleReach: str(r["role_reach"]) as Reach,
      viewerReach: str(r["viewer_reach"]) as Reach,
      lensReach: str(r["lens_reach"]) as Reach,
    })),
  );
}

/** The capabilities a lens shows at organization reach, the set the shell narrows controls to. */
export function lensOrgCapabilities(capabilities: readonly LensCapability[]): Set<string> {
  return new Set(
    capabilities.filter((c) => c.lensReach === "organization").map((c) => c.capability),
  );
}

// Inbox --------------------------------------------------------------------------------------------------------

/**
 * Per org, the capabilities the signed-in person holds through no role: a direct grant, an org-level record grant, a
 * delegation or their own break-glass session (app.role_lens_personal_capabilities). A notice picked by one of them
 * is addressed to the person, so the Inbox keeps it under every lens.
 */
export function personalCapabilities(db: XosClient): Promise<Result<Map<string, Set<string>>>> {
  return rpc(db, "role_lens_personal_capabilities", {}, (data) => {
    const byOrg = new Map<string, Set<string>>();
    for (const r of (data as Raw[] | null) ?? []) {
      const org = str(r["org_id"]);
      const set = byOrg.get(org) ?? new Set<string>();
      set.add(str(r["capability_code"]));
      byOrg.set(org, set);
    }
    return byOrg;
  });
}

/**
 * Notification kinds a person receives because of a capability they hold, and those capabilities (any one admits
 * the item), as each kind's sender picks its recipients (private.person_capability_reach and the helpers on it).
 * The sender checks of test/role-lens.test.ts compare each entry with its latest sender in the migrations.
 * weather.alert is left out: it also reaches the project roles a weather plan names, which are the person's own
 * assignments, not an org role, so it shows under every lens.
 */
export const ROLE_ROUTED_KINDS: Readonly<Record<string, readonly string[]>> = {
  "incident.reported": ["safety.incident.dispatch"],
  "occupancy.threshold": ["safety.incident.dispatch"],
  "content_report.filed": ["org.communication.write"],
  "content_report.overdue": ["org.communication.write"],
  "billing.payment_failed": ["org.billing.read"],
  "billing.read_only": ["org.billing.read"],
  "billing.trial_ending": ["org.billing.read"],
  "billing.trial_ended": ["org.billing.read"],
  "partner.client_left": ["org.partner.manage"],
};

/**
 * Notification kinds sent to the holders of platform roles, and those roles' codes: deletion and white-label
 * notices to the Owner role (private.org_owner_ids), break-glass notices to Owner and Admin. Only those roles'
 * lenses keep them; a custom role that holds the same capabilities did not bring them.
 */
export const SYSTEM_ROLE_ROUTED_KINDS: Readonly<Record<string, readonly string[]>> = {
  "organization.deletion_requested": ["owner"],
  "organization.deletion_recovered": ["owner"],
  "organization.white_label_reverting": ["owner"],
  "organization.white_label_reverted": ["owner"],
  "access.break_glass_started": ["owner", "admin"],
};

/** The parts of an Inbox item the lens reads; Atlas's InboxItem and Compass's notification rows both fit. */
export interface LensInboxItem {
  readonly kind: string;
  readonly subjectTable: string | null;
  /** For an approval request, the role the step it waits on names (app.inbox_items.approver_role_id). */
  readonly approverRoleId?: string | null;
}

/** Why an Inbox item reached the person, which decides the lenses that keep it. */
export type InboxRoute =
  /** Addressed to the person (a mention, an assignment, a step naming them, a delegation): every lens. */
  | { readonly by: "person" }
  /** A capability the sender picks by, any one of which keeps it. */
  | { readonly by: "capability"; readonly capabilities: readonly string[] }
  /** An approval step naming an org role: that role's lens, or every lens when the person holds no such role. */
  | { readonly by: "role"; readonly roleId: string }
  /** Holders of these platform roles. */
  | { readonly by: "system-role"; readonly codes: readonly string[] };

/**
 * How an Inbox item reached the person. A spend approval request follows its step (private.step_approver_person_ids,
 * 1395): a step naming a role reaches that role's holders, and a step naming a member reaches that member; an away
 * approver's delegate is asked in their place, which the person reads as a step naming a role they do not hold.
 * A timesheet request goes to everyone who approves timesheets org-wide (crew.timesheet.approve, 1140).
 */
export function inboxItemRoute(item: LensInboxItem): InboxRoute {
  if (item.kind === "approval.requested") {
    const table = item.subjectTable?.replace(/^app\./, "") ?? null;
    if (table === "timesheets")
      return { by: "capability", capabilities: ["crew.timesheet.approve"] };
    if (table === "approval_instances" && item.approverRoleId) {
      return { by: "role", roleId: item.approverRoleId };
    }
    return { by: "person" };
  }
  const capabilities = ROLE_ROUTED_KINDS[item.kind];
  if (capabilities) return { by: "capability", capabilities };
  const codes = SYSTEM_ROLE_ROUTED_KINDS[item.kind];
  if (codes) return { by: "system-role", codes };
  return { by: "person" };
}

/** What the Inbox reads of a role lens. */
export interface InboxLens {
  /** The lens role. */
  readonly roleId: string;
  /** The lens role's platform code, or null for a custom role. */
  readonly systemRoleCode: string | null;
  /** Every org role the person holds in the org. */
  readonly heldRoleIds: ReadonlySet<string>;
  /** The lens role's capabilities the person holds (any reach), and those they hold through no role. */
  readonly capabilities: ReadonlySet<string>;
}

/** The Inbox's view of a lens: the role, the roles the person holds, and the capabilities that keep an item. */
export function inboxLens(input: {
  readonly role: { readonly id: string; readonly code: string; readonly system: boolean };
  readonly heldRoleIds: Iterable<string>;
  readonly roleCapabilities: Iterable<string>;
  readonly personalCapabilities: Iterable<string>;
}): InboxLens {
  return {
    roleId: input.role.id,
    systemRoleCode: input.role.system ? input.role.code : null,
    heldRoleIds: new Set(input.heldRoleIds),
    capabilities: new Set([...input.roleCapabilities, ...input.personalCapabilities]),
  };
}

/**
 * True when an Inbox item shows under a lens: All roles (`lens` null) shows everything, and a role shows what is
 * addressed to the person plus what that role brought them.
 */
export function inboxItemInLens(item: LensInboxItem, lens: InboxLens | null): boolean {
  if (lens === null) return true;
  const route = inboxItemRoute(item);
  switch (route.by) {
    case "person":
      return true;
    case "capability":
      return route.capabilities.some((c) => lens.capabilities.has(c));
    case "role":
      return route.roleId === lens.roleId || !lens.heldRoleIds.has(route.roleId);
    case "system-role":
      return lens.systemRoleCode !== null && route.codes.includes(lens.systemRoleCode);
  }
}
