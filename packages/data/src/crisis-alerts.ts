import type { XosClient } from "./client.ts";
import { listEmergencyCodes } from "./incidents.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The crisis alerts in force for the signed-in person (crawl 4.9): what Home's alerts and the shell's crisis banner
 * show while an alert is active. A crisis alert (app.crisis_alerts, 0353) tells the people on its project through
 * crisis_alert.issued (6800) and gives the all-clear through crisis_alert.ended, but nothing in Atlas read it back, so
 * a recipient's Home said "No alerts right now" in the middle of a Code Red.
 *
 * Two sources, because the people an alert reaches are wider than the people who may read its row: a crew member on a
 * shift, an engagement or a roster entry of the project is told without being a project member, and the row's policy
 * (safety.incident.read on the project) hides it from them.
 *   * The alert rows the person may read: active while ended_at and deleted_at are null. A row they can read decides,
 *     whatever their notifications say, so the person who gave the all-clear (who is not sent crisis_alert.ended) and
 *     anyone whose all-clear is still with the worker see it end at once.
 *   * Their own crisis_alert.issued notifications, for alerts whose row they cannot read: active until a
 *     crisis_alert.ended notification about the same alert reaches them. Marking the Inbox item Done does not end it,
 *     since only the all-clear does. Only the last seven days count, so an all-clear that could not be sent never
 *     leaves a banner up for good.
 */

export interface ActiveCrisisAlert {
  readonly id: string;
  /** The project's key, when the row was readable; null when only the notification told the person. */
  readonly projectKey: string | null;
  /** The project's name as the notification carried it, or null. */
  readonly projectName: string | null;
  /** The code's label (Code Red), or the code itself when no label is known. */
  readonly title: string;
  readonly message: string;
  readonly issuedAt: string;
}

/** One readable alert row, as listActiveCrisisAlerts reads it. */
export interface CrisisAlertRow {
  readonly id: string;
  readonly projectKey: string | null;
  readonly emergencyCode: string;
  readonly message: string;
  readonly issuedAt: string;
  readonly endedAt: string | null;
  readonly deletedAt: string | null;
}

/** One of the person's own crisis alert notifications. */
export interface CrisisAlertNote {
  readonly kind: string;
  readonly subjectId: string | null;
  readonly createdAt: string;
  readonly args: Readonly<Record<string, string>>;
}

/** How far back a notification alone keeps an alert in force. */
export const CRISIS_NOTE_WINDOW_MS = 7 * 86_400_000;

/**
 * The alerts in force, newest first, from the rows the person may read, their own notifications and the org's code
 * labels (code to label). Pure, so the rule is tested without a database.
 */
export function activeCrisisAlerts(input: {
  readonly rows: readonly CrisisAlertRow[];
  readonly notes: readonly CrisisAlertNote[];
  readonly labels: ReadonlyMap<string, string>;
  readonly now?: Date;
}): ActiveCrisisAlert[] {
  const since = (input.now ?? new Date()).getTime() - CRISIS_NOTE_WINDOW_MS;
  const readable = new Map(input.rows.map((r) => [r.id, r]));
  const ended = new Set(
    input.notes.filter((n) => n.kind === "crisis_alert.ended").map((n) => n.subjectId),
  );
  const out = new Map<string, ActiveCrisisAlert>();
  for (const r of input.rows) {
    if (r.endedAt !== null || r.deletedAt !== null) continue;
    const note = input.notes.find((n) => n.kind === "crisis_alert.issued" && n.subjectId === r.id);
    out.set(r.id, {
      id: r.id,
      projectKey: r.projectKey,
      projectName: note?.args["project"] ?? null,
      title: input.labels.get(r.emergencyCode) ?? note?.args["title"] ?? r.emergencyCode,
      message: r.message,
      issuedAt: r.issuedAt,
    });
  }
  for (const n of input.notes) {
    if (n.kind !== "crisis_alert.issued" || n.subjectId === null) continue;
    if (readable.has(n.subjectId) || ended.has(n.subjectId) || out.has(n.subjectId)) continue;
    if (Date.parse(n.createdAt) < since) continue;
    out.set(n.subjectId, {
      id: n.subjectId,
      projectKey: null,
      projectName: n.args["project"] ?? null,
      title: n.args["title"] ?? "",
      message: n.args["message"] ?? "",
      issuedAt: n.createdAt,
    });
  }
  return [...out.values()].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

function stringArgs(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number") out[key] = String(v);
  }
  return out;
}

/** The crisis alerts in force for the signed-in person in one org (see the module comment). */
export async function listActiveCrisisAlerts(
  db: XosClient,
  input: { readonly orgId: string; readonly personId: string | null; readonly now?: Date },
): Promise<Result<ActiveCrisisAlert[]>> {
  const now = input.now ?? new Date();
  const [notes, codes] = await Promise.all([
    input.personId === null
      ? Promise.resolve({ data: [], error: null })
      : db
          .from("notifications")
          .select("kind, subject_id, created_at, message_args")
          .eq("org_id", input.orgId)
          .eq("recipient_person_id", input.personId)
          .eq("subject_table", "app.crisis_alerts")
          .in("kind", ["crisis_alert.issued", "crisis_alert.ended"])
          .is("deleted_at", null)
          .gte("created_at", new Date(now.getTime() - CRISIS_NOTE_WINDOW_MS).toISOString())
          .order("created_at", { ascending: false })
          .limit(200),
    listEmergencyCodes(db, input.orgId),
  ]);
  if (notes.error) return fail(toDataError(notes.error));
  if (!codes.ok) return codes;
  const noteRows: CrisisAlertNote[] = (
    notes.data as {
      kind: string;
      subject_id: string | null;
      created_at: string;
      message_args: unknown;
    }[]
  ).map((n) => ({
    kind: n.kind,
    subjectId: n.subject_id,
    createdAt: n.created_at,
    args: stringArgs(n.message_args),
  }));
  // Every active row the person may read, and the rows of alerts they were told of, in whatever state, so a row
  // they can read decides over their notifications.
  const told = [
    ...new Set(
      noteRows.flatMap((n) =>
        n.subjectId && /^[0-9a-f-]{36}$/i.test(n.subjectId) ? [n.subjectId] : [],
      ),
    ),
  ];
  let query = db
    .from("crisis_alerts")
    .select(
      "id, emergency_code, message, issued_at, ended_at, deleted_at, project:projects!crisis_alerts_project_id_fkey(project_key)",
    )
    .eq("org_id", input.orgId);
  query =
    told.length > 0
      ? query.or(`and(ended_at.is.null,deleted_at.is.null),id.in.(${told.join(",")})`)
      : query.is("ended_at", null).is("deleted_at", null);
  const rows = await query.order("issued_at", { ascending: false }).limit(200);
  if (rows.error) return fail(toDataError(rows.error));
  return ok(
    activeCrisisAlerts({
      rows: (
        rows.data as unknown as {
          id: string;
          emergency_code: string;
          message: string;
          issued_at: string;
          ended_at: string | null;
          deleted_at: string | null;
          project: { project_key: string } | null;
        }[]
      ).map((r) => ({
        id: r.id,
        projectKey: r.project?.project_key ?? null,
        emergencyCode: r.emergency_code,
        message: r.message,
        issuedAt: r.issued_at,
        endedAt: r.ended_at,
        deletedAt: r.deleted_at,
      })),
      notes: noteRows,
      labels: new Map(codes.data.map((c) => [c.code, c.label])),
      now,
    }),
  );
}
