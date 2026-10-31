import type { XosClient } from "./client.ts";
import type { ProjectCopyPart } from "./event-types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

export type { ProjectCopyPart } from "./event-types.ts";

/**
 * Copy from the last event (B14, G-252, migration 3036, ADR 0153 decision D4): the org-owned setup of a past project
 * (plan, pass categories, hotel blocks, budgets and advance forms) copied into another project of the org, every date
 * and time moved by the same number of days on the wall clock. The preview and the commit return the same rows; the
 * preview writes nothing. Shifts, engagements, people, credentials, allocations and the party's answers are never
 * copied. The roster is the party's own and is reused in Gateway (roster.ts).
 */

export const PROJECT_COPY_PARTS: readonly ProjectCopyPart[] = [
  "Plan",
  "Pass Categories",
  "Hotel Blocks",
  "Budgets",
  "Advance Forms",
];

/** Why an item stays out of a copy, or what was left out of a copied one (event_cost_center_cleared). */
export type ProjectCopySkipReason =
  | "scope_code_taken"
  | "outside_copy"
  | "dependency_needs_timeline"
  | "day_taken"
  | "day_needs_timeline"
  | "code_taken"
  | "zone_other_venue"
  | "event_cost_center_cleared"
  | "category_missing";

export interface ProjectCopyItem {
  readonly part: ProjectCopyPart;
  /** Scope Node, Record, Record Parent, Dependency, Project Day, Credential Category, Access Grid, Hotel Block, ... */
  readonly itemKind: string;
  readonly sourceId: string;
  readonly label: string;
  readonly outcome: "copy" | "skip";
  readonly skipReason: ProjectCopySkipReason | null;
  readonly newOn: string | null;
  readonly newAt: string | null;
}

export interface ProjectCopyRequest {
  readonly sourceProjectId: string;
  /** Null previews a project not created yet, at the would-be venue and zone. */
  readonly targetProjectId: string | null;
  readonly parts: readonly ProjectCopyPart[];
  /** Days to move everything by; null takes the difference of the projects' first show days. */
  readonly offsetDays?: number | null;
  readonly targetVenueId?: string | null;
  readonly targetTimeZone?: string | null;
}

interface Row {
  part: ProjectCopyPart;
  item_kind: string;
  source_id: string;
  label: string | null;
  outcome: "copy" | "skip";
  skip_reason: ProjectCopySkipReason | null;
  new_on: string | null;
  new_at: string | null;
}

async function run(
  db: XosClient,
  request: ProjectCopyRequest,
  commit: boolean,
): Promise<Result<ProjectCopyItem[]>> {
  const { data, error } = await untyped(db).rpc("copy_project_setup", {
    p_source_project_id: request.sourceProjectId,
    p_target_project_id: request.targetProjectId,
    p_parts: [...request.parts],
    p_commit: commit,
    p_offset_days: request.offsetDays ?? null,
    p_target_venue_id: request.targetVenueId ?? null,
    p_target_time_zone: request.targetTimeZone ?? null,
  });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as Row[]).map((r) => ({
      part: r.part,
      itemKind: r.item_kind,
      sourceId: r.source_id,
      label: r.label ?? "",
      outcome: r.outcome,
      skipReason: r.skip_reason,
      newOn: r.new_on,
      newAt: r.new_at,
    })),
  );
}

/** What a copy would do, item by item; writes nothing. */
export function previewProjectCopy(
  db: XosClient,
  request: ProjectCopyRequest,
): Promise<Result<ProjectCopyItem[]>> {
  return run(db, request, false);
}

/** Copies, writing exactly the rows the preview showed; needs a target. */
export function commitProjectCopy(
  db: XosClient,
  request: ProjectCopyRequest & { readonly targetProjectId: string },
): Promise<Result<ProjectCopyItem[]>> {
  return run(db, request, true);
}

/** Items copied and skipped per part, for the preview's headings and the toast. */
export function summarizeProjectCopy(items: readonly ProjectCopyItem[]) {
  return PROJECT_COPY_PARTS.map((part) => {
    const of = items.filter((i) => i.part === part);
    return {
      part,
      copied: of.filter((i) => i.outcome === "copy").length,
      skipped: of.filter((i) => i.outcome === "skip").length,
    };
  }).filter((p) => p.copied + p.skipped > 0);
}

export interface CopySourceProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly startsOn: string | null;
  readonly archived: boolean;
}

/**
 * Projects of the org the viewer reads that setup can be copied from, newest first by first show day. Archived
 * projects are included: last year's event is usually archived.
 */
export async function listCopySourceProjects(
  db: XosClient,
  orgId: string,
  excludeProjectId?: string | null,
): Promise<Result<CopySourceProject[]>> {
  let query = untyped(db)
    .from("projects")
    .select("id, project_key, name, starts_on, archived_at")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("starts_on", { ascending: false, nullsFirst: false })
    .order("project_key", { ascending: true })
    .limit(200);
  if (excludeProjectId) query = query.neq("id", excludeProjectId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as {
        id: string;
        project_key: string;
        name: string;
        starts_on: string | null;
        archived_at: string | null;
      }[]
    ).map((p) => ({
      id: p.id,
      key: p.project_key,
      name: p.name,
      startsOn: p.starts_on,
      archived: p.archived_at !== null,
    })),
  );
}

/** Days between two first show days, for prefilling the offset; null when either is unknown. */
export function offsetBetween(
  sourceStartsOn: string | null,
  targetStartsOn: string | null,
): number | null {
  if (!sourceStartsOn || !targetStartsOn) return null;
  const day = (iso: string) =>
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((day(targetStartsOn) - day(sourceStartsOn)) / 86_400_000);
}
