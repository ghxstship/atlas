import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Project debriefs (B7, migration 2965, ADR 0146 decisions 5 and 6): the wrap-up's structured debrief and its
 * management summary. Every read and write runs as the caller; the RPCs and row level security decide. A summary
 * drafted with Aurora is saved only when a person saves it, with the request it came from, and printed as drafted
 * with Aurora and reviewed by them.
 */

export const DEBRIEF_AREAS = [
  "Schedule",
  "Budget",
  "Safety",
  "Audience",
  "Sustainability",
  "Crew",
  "Vendors",
  "Other",
] as const;
export type DebriefArea = (typeof DEBRIEF_AREAS)[number];

export const DEBRIEF_ITEM_KINDS = ["Went Well", "To Improve", "Action"] as const;
export type DebriefItemKind = (typeof DEBRIEF_ITEM_KINDS)[number];

/** Catalog slugs of the areas and kinds, for copy keys. */
export const DEBRIEF_AREA_SLUGS: Readonly<Record<DebriefArea, string>> = {
  Schedule: "schedule",
  Budget: "budget",
  Safety: "safety",
  Audience: "audience",
  Sustainability: "sustainability",
  Crew: "crew",
  Vendors: "vendors",
  Other: "other",
};
export const DEBRIEF_KIND_SLUGS: Readonly<Record<DebriefItemKind, string>> = {
  "Went Well": "wentWell",
  "To Improve": "toImprove",
  Action: "action",
};

/** The refusal rules of the debrief RPCs and guards, each with its own copy. */
export const DEBRIEF_RULES = [
  "debrief_completed",
  "debrief_ai_request",
  "debrief_summary",
] as const;

export const MAX_DEBRIEF_POINT = 2000;
export const MAX_MANAGEMENT_SUMMARY = 4000;

export interface ProjectDebrief {
  readonly id: string;
  readonly projectId: string;
  readonly completedAt: string | null;
  readonly completedBy: string | null;
  readonly completedByName: string | null;
}

export interface DebriefItem {
  readonly id: string;
  readonly area: DebriefArea;
  readonly kind: DebriefItemKind;
  readonly body: string;
  readonly position: number;
  readonly ownerMembershipId: string | null;
  readonly ownerName: string | null;
}

export interface DebriefSummary {
  readonly text: string;
  /** True when the saved text was drafted with Aurora; it outlives the purge of the request row. */
  readonly aiDrafted: boolean;
  readonly aiRequestId: string | null;
  readonly by: string | null;
  readonly byName: string | null;
  readonly at: string | null;
}

async function names(db: XosClient, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const { data } = await db.from("people").select("id, full_name").in("id", wanted);
  return new Map((data ?? []).flatMap((p) => (p.full_name ? [[p.id, p.full_name] as const] : [])));
}

/** The project's live debrief, or null when none was started. */
export async function getProjectDebrief(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectDebrief | null>> {
  const { data, error } = await untyped(db)
    .from("project_debriefs")
    .select("id, project_id, completed_at, completed_by")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  const row = data as {
    id: string;
    project_id: string;
    completed_at: string | null;
    completed_by: string | null;
  };
  const people = await names(db, [row.completed_by]);
  return ok({
    id: row.id,
    projectId: row.project_id,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    completedByName: row.completed_by ? (people.get(row.completed_by) ?? null) : null,
  });
}

/** A debrief's live points in order, with each Action owner's name. */
export async function listDebriefItems(
  db: XosClient,
  debriefId: string,
): Promise<Result<DebriefItem[]>> {
  const { data, error } = await untyped(db)
    .from("project_debrief_items")
    .select(
      "id, area, item_kind, body, position, owner_membership_id, owner:memberships!project_debrief_items_owner_membership_id_fkey(person:people!memberships_person_id_fkey(full_name))",
    )
    .eq("debrief_id", debriefId)
    .is("deleted_at", null)
    .order("position");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        area: DebriefArea;
        item_kind: DebriefItemKind;
        body: string;
        position: number;
        owner_membership_id: string | null;
        owner: { person: { full_name: string | null } | null } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      area: r.area,
      kind: r.item_kind,
      body: r.body,
      position: r.position,
      ownerMembershipId: r.owner_membership_id,
      ownerName: r.owner?.person?.full_name ?? null,
    })),
  );
}

/**
 * The debrief's management summary, or null when there is none or the caller may not read it: it is drafted from
 * budget, gate, incident and ledger facts, and only readers of all of them read it (2965).
 */
export async function getDebriefSummary(
  db: XosClient,
  debriefId: string,
): Promise<Result<DebriefSummary | null>> {
  const { data, error } = await untyped(db)
    .from("project_debrief_summaries")
    .select(
      "management_summary, management_summary_ai_request_id, ai_drafted, summary_by, summary_at",
    )
    .eq("debrief_id", debriefId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  const row = data as {
    management_summary: string;
    management_summary_ai_request_id: string | null;
    ai_drafted: boolean;
    summary_by: string | null;
    summary_at: string | null;
  };
  const people = await names(db, [row.summary_by]);
  return ok({
    text: row.management_summary,
    aiDrafted: row.ai_drafted,
    aiRequestId: row.management_summary_ai_request_id,
    by: row.summary_by,
    byName: row.summary_by ? (people.get(row.summary_by) ?? null) : null,
    at: row.summary_at,
  });
}

/**
 * Starts the project's debrief when there is none and returns its id. With a summary it saves the management
 * summary: blank clears it; with `aiRequestId` it is the reviewed Aurora draft of that request.
 */
export async function saveProjectDebrief(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly summary?: string | null;
    readonly aiRequestId?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db).rpc("save_project_debrief", {
    p_project_id: input.projectId,
    p_management_summary: input.summary ?? null,
    p_ai_request_id: input.aiRequestId ?? null,
  });
  if (error) return fail(toDataError(error));
  return typeof data === "string" ? ok({ id: data }) : fail({ kind: "not-found" });
}

/** Completes a debrief once; its points and summary lock until it is reopened. */
export async function completeProjectDebrief(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await untyped(db).rpc("complete_project_debrief", { p_project_debrief_id: id });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Reopens a completed debrief. */
export async function reopenProjectDebrief(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await untyped(db).rpc("reopen_project_debrief", { p_project_debrief_id: id });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface DebriefItemInput {
  readonly area: DebriefArea;
  readonly kind: DebriefItemKind;
  readonly body: string;
  /** Only an Action has an owner. */
  readonly ownerMembershipId?: string | null;
}

function itemRow(input: DebriefItemInput) {
  return {
    area: input.area,
    item_kind: input.kind,
    body: input.body.trim(),
    owner_membership_id: input.kind === "Action" ? (input.ownerMembershipId ?? null) : null,
  };
}

/** Adds a point at the end of the debrief. */
export async function addDebriefItem(
  db: XosClient,
  debriefId: string,
  input: DebriefItemInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db)
    .from("project_debrief_items")
    .insert({ debrief_id: debriefId, ...itemRow(input) })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

export async function updateDebriefItem(
  db: XosClient,
  id: string,
  input: DebriefItemInput,
): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("project_debrief_items")
    .update(itemRow(input))
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Moves a point to Trash; restoreDebriefItem is its Undo. */
export async function deleteDebriefItem(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("project_debrief_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export async function restoreDebriefItem(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("project_debrief_items")
    .update({ deleted_at: null })
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}
