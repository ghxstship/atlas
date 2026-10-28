import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { rpc, str, type Raw } from "./platform-common.ts";
import type { Reach } from "./access.ts";

/**
 * The role lens of the context switcher (Section 4.8.1, ADR 0086): All roles, or one role the person holds in
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
 * `own`, whatever `role` contains.
 */
export function lensCapabilities(own: ReadonlySet<string>, role: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const capability of role) if (own.has(capability)) out.add(capability);
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

/** The capability each spend document type is approved with (private.spend_approve_capability, 1395). */
export const SPEND_APPROVE_CAPABILITY: Readonly<Record<string, string>> = {
  "Purchase Order": "finance.po.approve",
  "Change Order": "finance.change_order.approve",
  "Invoice Approval": "finance.invoice.approve",
  Requisition: "people.requisition.approve",
  Expense: "finance.expense.approve",
  "Payroll Run": "crew.pay_period.manage",
};

/**
 * Notification kinds a person receives because of a capability a role gives them, and those capabilities (any
 * one admits the item), as each kind's sender picks its recipients. Every other kind is addressed to the person
 * (a mention, an assignment, their own shift, account notice or report) and shows under every lens.
 */
export const ROLE_ROUTED_KINDS: Readonly<Record<string, readonly string[]>> = {
  "incident.reported": ["safety.incident.dispatch"],
  "occupancy.threshold": ["safety.incident.dispatch", "safety.incident.write"],
  "weather.alert": ["safety.incident.dispatch", "safety.incident.write"],
  "content_report.filed": ["org.communication.write"],
  "content_report.overdue": ["org.communication.write"],
  "billing.payment_failed": ["org.billing.read"],
  "billing.read_only": ["org.billing.read"],
  "billing.trial_ending": ["org.organization.delete"],
  "billing.trial_ended": ["org.organization.delete"],
  "organization.deletion_requested": ["org.organization.delete"],
  "organization.deletion_recovered": ["org.organization.delete"],
  "organization.white_label_reverting": ["org.organization.delete"],
  "organization.white_label_reverted": ["org.organization.delete"],
  "partner.client_left": ["org.partner.manage"],
  "access.break_glass_started": ["org.security.write"],
};

/** The parts of an Inbox item the lens reads; Atlas's InboxItem and Compass's notification rows both fit. */
export interface LensInboxItem {
  readonly kind: string;
  readonly subjectTable: string | null;
  /** For an approval request, the spend document type it asks about, when the reader has it. */
  readonly documentType?: string | null;
}

/**
 * The capabilities that brought an Inbox item to the person, any one of which keeps it under a lens; null when
 * the item is addressed to the person and shows under every lens. An approval request whose document type the
 * reader does not have is kept by any spend approval capability.
 */
export function inboxItemCapabilities(item: LensInboxItem): readonly string[] | null {
  if (item.kind === "approval.requested") {
    const table = item.subjectTable?.replace(/^app\./, "") ?? null;
    if (table === "timesheets") return ["crew.timesheet.approve"];
    if (table !== "approval_instances") return null;
    const approve = item.documentType ? SPEND_APPROVE_CAPABILITY[item.documentType] : undefined;
    return approve ? [approve] : Object.values(SPEND_APPROVE_CAPABILITY);
  }
  return ROLE_ROUTED_KINDS[item.kind] ?? null;
}

/**
 * True when an Inbox item shows under a lens: All roles (`lens` null) shows everything, and a role shows what is
 * addressed to the person plus what one of its capabilities brought (any reach).
 */
export function inboxItemInLens(item: LensInboxItem, lens: ReadonlySet<string> | null): boolean {
  if (lens === null) return true;
  const needs = inboxItemCapabilities(item);
  return needs === null || needs.some((c) => lens.has(c));
}
