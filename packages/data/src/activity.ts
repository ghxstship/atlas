import type { XosClient } from "./client.ts";
import { untypedRpc } from "./projects.ts";
import { personNames } from "./person-names.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

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
  /** The catalog description of the event type (migration 0951). */
  readonly description: string | null;
  readonly actorPersonId: string | null;
  /** What the entry acted on when it is not a record: a credential number, a party, a host name. */
  readonly subjectLabel?: string | null;
  /** When the subject happens (a shift's start), for the label's date. */
  readonly subjectAt?: string | null;
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
  description?: string | null;
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
  return ok({
    entries: rows.map(toEntry),
    next: rows.length === limit ? (rows[rows.length - 1]?.occurred_at ?? null) : null,
  });
}

function toEntry(r: FeedRow): ActivityEntry {
  return {
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
    actorPersonId: r.actor_person_id,
    recordKey: r.record_key,
    recordTitle: r.record_title,
    data: r.data ?? {},
    description: r.description ?? null,
  };
}

/** One feed entry by id under the feed rule (migration 0951), or not-found. */
export async function getActivityEntry(
  db: XosClient,
  orgId: string,
  activityId: string,
): Promise<Result<ActivityEntry>> {
  const { data, error } = await untypedRpc<FeedRow[]>(db, "activity_feed", {
    p_org_id: orgId,
    p_project_id: null,
    p_before: null,
    p_limit: 1,
    p_activity_id: activityId,
  });
  if (error) return fail(toDataError(error));
  const row = data?.[0];
  return row ? ok(toEntry(row)) : fail({ kind: "not-found" });
}

/**
 * Names the thing each entry acted on (finding A59-030), so a line reads "clocked in on NWS-17
 * Stagehand · Load-in" instead of "clocked in on a time entry". A shift, or a time entry on a shift,
 * takes its record's key and title (and opens it); a credential reads as its number and holder; an
 * engagement as its party; an approval as its reference; a domain as its host name. Lookups run under
 * the reader's row level security, so an entry keeps its generic noun when its subject is hidden.
 * A failed lookup never fails the feed.
 */
export async function labelActivity(
  db: XosClient,
  entries: readonly ActivityEntry[],
): Promise<ActivityEntry[]> {
  const table = (e: ActivityEntry) => e.subjectTable.replace(/^app\./, "");
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const pending = entries.filter((e) => !e.recordKey);
  if (pending.length === 0) return [...entries];
  const shiftOf = (e: ActivityEntry) =>
    table(e) === "shifts"
      ? e.subjectId
      : table(e) === "time_entries"
        ? text(e.data["shift_id"])
        : null;
  const idsOf = (name: string) =>
    [...new Set(pending.filter((e) => table(e) === name).map((e) => e.subjectId))].filter(Boolean);
  const shiftIds = [...new Set(pending.map(shiftOf).filter((id): id is string => id !== null))];
  const credentialIds = idsOf("credentials");
  const engagementIds = idsOf("engagements");
  const approvalIds = idsOf("approval_instances");
  const read = async (query: PromiseLike<{ data: unknown; error: unknown }> | null) => {
    if (!query) return [] as Record<string, unknown>[];
    try {
      const { data, error } = await query;
      return error || !Array.isArray(data) ? [] : (data as Record<string, unknown>[]);
    } catch {
      return [];
    }
  };
  const client = untyped(db);
  const [shifts, credentials, engagements, approvals] = await Promise.all([
    read(
      shiftIds.length > 0
        ? client
            .from("shifts")
            .select(
              "id, role_code, starts_at, record:records!shifts_record_id_fkey(record_number, title, project:projects!records_project_id_fkey(project_key))",
            )
            .in("id", shiftIds)
        : null,
    ),
    read(
      credentialIds.length > 0
        ? client
            .from("credentials")
            .select("id, credential_number, holder_person_id")
            .in("id", credentialIds)
        : null,
    ),
    read(
      engagementIds.length > 0
        ? client
            .from("engagement_board")
            .select("engagement_id, party_name")
            .in("engagement_id", engagementIds)
        : null,
    ),
    read(
      approvalIds.length > 0
        ? client
            .from("approval_instances")
            .select("id, document_type, subject_reference")
            .in("id", approvalIds)
        : null,
    ),
  ]);
  const roleCodes = [
    ...new Set(shifts.map((s) => text(s["role_code"])).filter((c): c is string => c !== null)),
  ];
  const canon = untyped(db).schema("xpms");
  const [holders, roles] = await Promise.all([
    personNames(
      db,
      credentials.map((c) => text(c["holder_person_id"])),
    ),
    read(
      roleCodes.length > 0
        ? canon.from("role").select("role_code, job_title").in("role_code", roleCodes)
        : null,
    ),
  ]);
  const jobTitle = new Map(roles.map((r) => [String(r["role_code"]), text(r["job_title"])]));
  /** A shift without a record reads as its role and when it starts (in the reader's zone). */
  const shiftLabels = new Map<string, { label: string; at: string | null }>();
  const records = new Map<string, { key: string; title: string }>();
  for (const s of shifts) {
    const record = s["record"] as {
      record_number?: number;
      title?: string;
      project?: { project_key?: string };
    } | null;
    const key = record?.project?.project_key;
    if (record && key && typeof record.record_number === "number") {
      records.set(String(s["id"]), {
        key: `${key}-${record.record_number}`,
        title: record.title ?? "",
      });
    } else {
      const code = text(s["role_code"]);
      const title = code ? (jobTitle.get(code) ?? null) : null;
      if (title) shiftLabels.set(String(s["id"]), { label: title, at: text(s["starts_at"]) });
    }
  }
  const labels = new Map<string, string>();
  for (const c of credentials) {
    const holder = holders.get(String(c["holder_person_id"] ?? ""));
    const number = text(c["credential_number"]);
    if (number) labels.set(String(c["id"]), holder ? `${number} · ${holder}` : number);
  }
  for (const e of engagements) {
    const name = text(e["party_name"]);
    if (name) labels.set(String(e["engagement_id"]), name);
  }
  for (const a of approvals) {
    const reference = text(a["subject_reference"]);
    if (reference) labels.set(String(a["id"]), reference);
  }
  return entries.map((e) => {
    if (e.recordKey) return e;
    const shift = shiftOf(e);
    const record = shift ? records.get(shift) : undefined;
    if (record) return { ...e, recordKey: record.key, recordTitle: record.title };
    const role = shift ? shiftLabels.get(shift) : undefined;
    if (role) return { ...e, subjectLabel: role.label, subjectAt: role.at };
    const label =
      labels.get(e.subjectId) ?? (table(e) === "org_domains" ? text(e.data["hostname"]) : null);
    return label ? { ...e, subjectLabel: label } : e;
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
