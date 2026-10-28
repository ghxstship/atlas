import type { BulkRow } from "@xos/data/bulk";
import type { GatewayBulkResource } from "@xos/data/gateway-bulk";

/**
 * The actions a Gateway collection offers on a selection (Section 11.7, ADR 0082): each is an
 * action a row of that list already offers one at a time, sent for many rows at once through the
 * person's own bulk RPC (migration 2160). Pages name the action; the table, its bulk bar, the row
 * menu and the server action read the rest from here, so server and client agree.
 */

export const GATEWAY_ACTION_IDS = ["sign", "submit", "withdraw"] as const;
export type GatewayActionId = (typeof GATEWAY_ACTION_IDS)[number];

export interface GatewayAction {
  readonly id: GatewayActionId;
  readonly resource: GatewayBulkResource;
  /** The column the action sets, and the value it sets it to. */
  readonly field: string;
  readonly value: string;
  /** Whether the undo stack can take it back: a submit is recalled; a signature or withdrawal is final. */
  readonly undoable: boolean;
  readonly icon: string;
}

export const GATEWAY_ACTIONS: Readonly<Record<GatewayActionId, GatewayAction>> = {
  sign: {
    id: "sign",
    resource: "my_engagement_documents",
    field: "engagement_document_state",
    value: "Signed",
    undoable: false,
    icon: "FileSignature",
  },
  submit: {
    id: "submit",
    resource: "my_timesheets",
    field: "timesheet_state",
    value: "Submitted",
    undoable: true,
    icon: "Send",
  },
  withdraw: {
    id: "withdraw",
    resource: "my_applications",
    field: "application_state",
    value: "Withdrawn",
    undoable: false,
    icon: "Undo2",
  },
};

export function isGatewayActionId(value: unknown): value is GatewayActionId {
  return (GATEWAY_ACTION_IDS as readonly unknown[]).includes(value);
}

/** The rows that apply an action to each id. */
export function actionRows(action: GatewayAction, ids: readonly string[]): BulkRow[] {
  return ids.map((id) => ({ id, set: { [action.field]: action.value } }));
}

/**
 * Redo of an undone change: the change again, expecting the values its undo put back. The undo
 * rows are the call's inverse ({set: before, expect: after}).
 */
export function redoRows(inverse: readonly BulkRow[]): BulkRow[] {
  return inverse.map((r) => ({ id: r.id, set: { ...(r.expect ?? {}) }, expect: { ...r.set } }));
}

/**
 * Refusal rules with their own copy under `gateway.collections.refusals`; any other rule reads as
 * the generic refusal. They come from 1451's driver and 2160's row functions.
 */
export const KNOWN_BULK_REFUSALS = [
  "bulk_stale",
  "bulk_row_not_found",
  "bulk_field_not_editable",
  "not_allowed",
  "timesheet_open_entry",
  "timesheet_recall_not_submitter",
  "document_not_awaiting_signature",
  "application_offered",
  "lifecycle_transition",
  "lifecycle_conflict",
] as const;

/** The catalog key of a refused row's copy. */
export function refusalKey(rule: string): string {
  return (KNOWN_BULK_REFUSALS as readonly string[]).includes(rule)
    ? `refusals.${rule}`
    : "refusals.refused";
}

/** Which of the selected rows the action applies to, in the table's order. */
export function eligibleIds(
  rows: readonly { readonly id: string; readonly eligible: boolean }[],
  selected: ReadonlySet<string>,
): string[] {
  return rows.filter((r) => r.eligible && selected.has(r.id)).map((r) => r.id);
}
