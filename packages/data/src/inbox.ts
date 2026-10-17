import type { XosClient } from "./client.ts";
import { ok, type Result } from "./result.ts";
import { num, numOrNull, rows, rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * Inbox (A36, migration 1064; Section 11.10 rule 5): the signed-in person's live notifications in
 * Needs You and For Your Information, acted on where they arrive: approve (A), reject with a reason (R),
 * Done (E) and snooze (H). Approving runs app.decide_approval, so every approval rule still decides.
 */

export type InboxSection = "Needs You" | "For Your Information";
export type InboxAction = "approve" | "reject" | "done";

export interface InboxApproval {
  readonly instanceId: string;
  readonly documentType: string;
  readonly reference: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly state: string;
  readonly currentStep: number;
}

export interface InboxItem {
  readonly id: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly section: InboxSection;
  readonly read: boolean;
  readonly subjectTable: string | null;
  readonly subjectId: string | null;
  readonly projectId: string | null;
  readonly args: Readonly<Record<string, string>>;
  /** For an approval request: the approval it asks for, as it stands now. */
  readonly approval: InboxApproval | null;
}

function args(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, value] of Object.entries(v as Raw)) {
      if (typeof value === "string" || typeof value === "number") out[k] = String(value);
    }
  }
  return out;
}

/** The person's Inbox in one org, newest first, Needs You before For Your Information. */
export async function listInbox(db: XosClient, orgId: string): Promise<Result<InboxItem[]>> {
  const result = await rows(
    untyped(db)
      .from("inbox_items")
      .select(
        "id, created_at, kind, section, read_at, subject_table, subject_id, project_id, message_args, document_type, subject_reference, amount_minor, currency_code, approval_state, current_step",
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200),
  );
  if (!result.ok) return result;
  const items: InboxItem[] = result.data.map((r) => ({
    id: str(r["id"]),
    createdAt: str(r["created_at"]),
    kind: str(r["kind"]),
    section: str(r["section"]) as InboxSection,
    read: r["read_at"] !== null && r["read_at"] !== undefined,
    subjectTable: strOrNull(r["subject_table"]),
    subjectId: strOrNull(r["subject_id"]),
    projectId: strOrNull(r["project_id"]),
    args: args(r["message_args"]),
    approval:
      r["approval_state"] === null || r["approval_state"] === undefined
        ? null
        : {
            instanceId: str(r["subject_id"]),
            documentType: str(r["document_type"]),
            reference: strOrNull(r["subject_reference"]),
            amountMinor: numOrNull(r["amount_minor"]),
            currency: strOrNull(r["currency_code"]),
            state: str(r["approval_state"]),
            currentStep: num(r["current_step"]),
          },
  }));
  return ok(sortInbox(items));
}

export function sortInbox(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    if (a.section !== b.section) return a.section === "Needs You" ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** True when an item can be approved or rejected from the Inbox now. */
export function isActionableApproval(item: InboxItem): boolean {
  return item.kind === "approval.requested" && item.approval?.state === "In Review";
}

/** Approve, reject (with a reason) or mark Done; the item leaves the Inbox once decided. */
export function actOnInboxItem(
  db: XosClient,
  input: { id: string; action: InboxAction; comment?: string | null },
): Promise<Result<string>> {
  return rpc(
    db,
    "act_on_notification",
    { p_notification_id: input.id, p_action: input.action, p_comment: input.comment ?? null },
    str,
  );
}

/** Snoozes an item until a moment, at most 30 days ahead. */
export async function snoozeInboxItem(
  db: XosClient,
  input: { id: string; until: string },
): Promise<Result<string>> {
  const note = await rows(
    untyped(db).from("notifications").select("id, created_at").eq("id", input.id).limit(1),
  );
  if (!note.ok) return note;
  const row = note.data[0];
  if (!row) return { ok: false, error: { kind: "not-found" } };
  const result = await rows(
    untyped(db)
      .from("inbox_snoozes")
      .insert({
        notification_id: input.id,
        notification_created_at: str(row["created_at"]),
        snoozed_until: input.until,
      })
      .select("id"),
  );
  if (!result.ok) return result;
  return ok(str(result.data[0]?.["id"]));
}

/** When a snooze from the H key ends: 24 hours after it was set. */
export function snoozeUntil(now: Date = new Date()): string {
  return new Date(now.getTime() + 86_400_000).toISOString();
}
