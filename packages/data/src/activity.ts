import type { XosClient } from "./client.ts";
import { untypedRpc } from "./projects.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Activity repository (Section 4.2 Activity): the user-facing feed, read through
 * `app.activity_feed` (migration 0400) from A18's activity rows and the domain events they show,
 * and the compliance audit ledger, read from `app.audit_events` under its row level security
 * (audit.log.read, Owner and Admin). The two are separate on purpose: the feed tells people what
 * happened; the ledger proves it.
 */

export interface ActivityEntry {
  readonly id: string;
  readonly at: string;
  /** Domain event code from the catalog, for example `project.state_changed`. */
  readonly type: string;
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly project: { readonly id: string; readonly key: string; readonly name: string } | null;
  readonly actor: string | null;
  readonly recordKey: string | null;
  readonly recordTitle: string | null;
  /** The event's outbound payload: the named, non-restricted subject fields. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ActivityPage<T> {
  readonly entries: T[];
  /** Pass as `before` to read the next, older page; null on the last page. */
  readonly next: string | null;
}

interface FeedRow {
  id: string;
  occurred_at: string;
  event_type: string;
  subject_table: string;
  subject_id: string;
  project_id: string | null;
  project_key: string | null;
  project_name: string | null;
  actor_person_id: string | null;
  actor_name: string | null;
  record_key: string | null;
  record_title: string | null;
  data: Record<string, unknown> | null;
}

/** The activity feed of an org, or of one project, newest first. */
export async function listActivity(
  db: XosClient,
  query: {
    readonly orgId: string;
    readonly projectId?: string | null;
    readonly before?: string | null;
    readonly limit?: number;
  },
): Promise<Result<ActivityPage<ActivityEntry>>> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const { data, error } = await untypedRpc<FeedRow[]>(db, "activity_feed", {
    p_org_id: query.orgId,
    p_project_id: query.projectId ?? null,
    p_before: query.before ?? null,
    p_limit: limit,
  });
  if (error) return fail(toDataError(error));
  const rows = data ?? [];
  const entries = rows.map((r): ActivityEntry => ({
    id: r.id,
    at: r.occurred_at,
    type: r.event_type,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    project:
      r.project_id && r.project_key && r.project_name
        ? { id: r.project_id, key: r.project_key, name: r.project_name }
        : null,
    actor: r.actor_name,
    recordKey: r.record_key,
    recordTitle: r.record_title,
    data: r.data ?? {},
  }));
  return ok({
    entries,
    next: rows.length === limit ? (rows[rows.length - 1]?.occurred_at ?? null) : null,
  });
}

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actorKind: string;
  readonly actor: string | null;
  readonly action: string;
  readonly subjectTable: string;
  readonly subjectId: string | null;
  readonly diff: Readonly<Record<string, unknown>>;
  readonly redacted: boolean;
}

/** The compliance audit ledger of an org, newest first; readable only with audit.log.read. */
export async function listAuditEvents(
  db: XosClient,
  query: { readonly orgId: string; readonly before?: string | null; readonly limit?: number },
): Promise<Result<ActivityPage<AuditEntry>>> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  let q = db
    .from("audit_events")
    .select(
      "id, created_at, actor_kind, action, subject_table, subject_id, diff, redacted_at, actor:people!audit_events_actor_person_id_fkey(full_name)",
    )
    .eq("org_id", query.orgId);
  if (query.before) q = q.lt("created_at", query.before);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    created_at: string;
    actor_kind: string;
    action: string;
    subject_table: string;
    subject_id: string | null;
    diff: Record<string, unknown> | null;
    redacted_at: string | null;
    actor: { full_name: string | null } | null;
  }[];
  return ok({
    entries: rows.map((r) => ({
      id: r.id,
      at: r.created_at,
      actorKind: r.actor_kind,
      actor: r.actor?.full_name ?? null,
      action: r.action,
      subjectTable: r.subject_table,
      subjectId: r.subject_id,
      diff: r.diff ?? {},
      redacted: r.redacted_at !== null,
    })),
    next: rows.length === limit ? (rows[rows.length - 1]?.created_at ?? null) : null,
  });
}
