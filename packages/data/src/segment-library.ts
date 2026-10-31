import type { XosClient } from "./client.ts";
import { CUE_CALL_KINDS, isCueCallKind, type CueCallKind } from "./cue-calls.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { intervalSeconds, isSegmentColor, type SegmentColor } from "./show.ts";
import { untyped } from "./untyped.ts";

/**
 * The segment library (B3, ADR 0142 decision 8; migration 2921): an org's reusable show segments, each a named block
 * of cues with their department calls, copied into running orders and republished to them when the library copy
 * changes (Global Elements Manager semantics: a publish replaces the copy's uncalled cues, local edits included).
 *
 * - Members read the library; holders of show.run_of_show.write org-wide edit it. Table writes go under row level
 *   security; the database keeps each segment's version and caps it at 100 cues.
 * - {@link insertLibrarySegment} and {@link publishLibrarySegment} are definer RPCs, one transaction each, that
 *   renumber the running order and refuse a place at or before the last called cue or a run past 300 cues.
 * - The tables are newer than the generated data types, so every row is mapped here (untyped.ts).
 */

export interface LibrarySegment {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly colorKey: SegmentColor | null;
  readonly version: number;
  readonly cueCount: number;
  readonly updatedAt: string;
}

export interface LibraryCue {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly durationSeconds: number | null;
  readonly description: string | null;
  readonly script: string | null;
  readonly calls: readonly { readonly kind: CueCallKind; readonly instruction: string }[];
}

export interface LibrarySegmentDetail extends LibrarySegment {
  readonly cues: readonly LibraryCue[];
}

interface SegmentRow {
  id: string;
  name: string;
  description: string | null;
  color_key: string | null;
  version: number;
  updated_at: string;
  cues?: { id: string; deleted_at: string | null }[] | null;
}

interface LibraryCueRow {
  id: string;
  position: number;
  label: string;
  duration: string | null;
  description: string | null;
  script: string | null;
  deleted_at: string | null;
  calls: { call_kind: string; instruction: string; deleted_at: string | null }[] | null;
}

function toSegment(r: SegmentRow): LibrarySegment {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    colorKey: isSegmentColor(r.color_key) ? r.color_key : null,
    version: r.version,
    cueCount: (r.cues ?? []).filter((c) => c.deleted_at === null).length,
    updatedAt: r.updated_at,
  };
}

function toLibraryCue(r: LibraryCueRow): LibraryCue {
  return {
    id: r.id,
    position: r.position,
    label: r.label,
    durationSeconds: intervalSeconds(r.duration),
    description: r.description,
    script: r.script,
    calls: (r.calls ?? [])
      .filter((c) => c.deleted_at === null && isCueCallKind(c.call_kind))
      .map((c) => ({ kind: c.call_kind as CueCallKind, instruction: c.instruction }))
      .sort((a, b) => CUE_CALL_KINDS.indexOf(a.kind) - CUE_CALL_KINDS.indexOf(b.kind)),
  };
}

const SEGMENT_COLUMNS =
  "id, name, description, color_key, version, updated_at, cues:segment_library_cues(id, deleted_at)";

/** The org's live library segments, by name. */
export async function listLibrarySegments(
  db: XosClient,
  orgId: string,
): Promise<Result<LibrarySegment[]>> {
  const { data, error } = await untyped(db)
    .from("segment_library")
    .select(SEGMENT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name")
    .limit(500);
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as SegmentRow[]).map(toSegment));
}

/** One library segment with its live cues in order and their department calls. */
export async function getLibrarySegment(
  db: XosClient,
  id: string,
): Promise<Result<LibrarySegmentDetail>> {
  const { data, error } = await untyped(db)
    .from("segment_library")
    .select(
      `${SEGMENT_COLUMNS}, detail:segment_library_cues(id, position, label, duration, description, script, deleted_at, calls:segment_library_cue_calls(call_kind, instruction, deleted_at))`,
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as SegmentRow & { detail: LibraryCueRow[] | null };
  return ok({
    ...toSegment(row),
    cues: (row.detail ?? [])
      .filter((c) => c.deleted_at === null)
      .sort((a, b) => a.position - b.position)
      .map(toLibraryCue),
  });
}

/** Creates (no id) or edits a library segment; the database keeps the version. */
export async function saveLibrarySegment(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly id?: string;
    readonly name: string;
    readonly description: string | null;
    readonly colorKey: SegmentColor | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    name: input.name.trim(),
    description: input.description?.trim() ? input.description.trim() : null,
    color_key: input.colorKey,
  };
  if (input.id) {
    const { data, error } = await untyped(db)
      .from("segment_library")
      .update(row)
      .eq("id", input.id)
      .select("id");
    if (error) return fail(toDataError(error));
    return (data ?? []).length === 1 ? ok({ id: input.id }) : fail({ kind: "not-found" });
  }
  const { data, error } = await untyped(db)
    .from("segment_library")
    .insert({ org_id: input.orgId, ...row })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

/** Removes a library segment (soft delete; it can be restored from Trash). Copies in running orders stay. */
export async function removeLibrarySegment(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("segment_library")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data ?? []).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Adds a cue at the end of a library segment (no id) or edits one. */
export async function saveLibraryCue(
  db: XosClient,
  input: {
    readonly segmentId: string;
    readonly id?: string;
    readonly label: string;
    readonly durationSeconds: number | null;
    readonly description: string | null;
    readonly script: string | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    label: input.label.trim(),
    duration: input.durationSeconds === null ? null : `${input.durationSeconds} seconds`,
    description: input.description?.trim() ? input.description.trim() : null,
    script: input.script === "" ? null : input.script,
  };
  if (input.id) {
    const { data, error } = await untyped(db)
      .from("segment_library_cues")
      .update(row)
      .eq("id", input.id)
      .select("id");
    if (error) return fail(toDataError(error));
    return (data ?? []).length === 1 ? ok({ id: input.id }) : fail({ kind: "not-found" });
  }
  const current = await untyped(db)
    .from("segment_library_cues")
    .select("position")
    .eq("segment_library_id", input.segmentId)
    .is("deleted_at", null);
  if (current.error) return fail(toDataError(current.error));
  const position =
    Math.max(0, ...((current.data ?? []) as { position: number }[]).map((r) => r.position)) + 1;
  const { data, error } = await untyped(db)
    .from("segment_library_cues")
    .insert({ segment_library_id: input.segmentId, position, ...row })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

/** Removes a cue from a library segment (soft delete; it comes back with the segment). */
export async function removeLibraryCue(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("segment_library_cues")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data ?? []).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Saves a library cue's department calls, as app.save_cue_calls does for a running order's cue: text is the
 * department's call, null or blank clears it, departments left out are untouched.
 */
export async function saveLibraryCueCalls(
  db: XosClient,
  cueId: string,
  calls: Partial<Record<CueCallKind, string | null>>,
): Promise<Result<null>> {
  const current = await untyped(db)
    .from("segment_library_cue_calls")
    .select("id, call_kind")
    .eq("segment_library_cue_id", cueId)
    .is("deleted_at", null);
  if (current.error) return fail(toDataError(current.error));
  const rows = (current.data ?? []) as { id: string; call_kind: string }[];
  for (const [kind, raw] of Object.entries(calls) as [CueCallKind, string | null][]) {
    const text = raw?.trim() ?? "";
    const existing = rows.find((r) => r.call_kind === kind);
    const write = existing
      ? untyped(db)
          .from("segment_library_cue_calls")
          .update(text === "" ? { deleted_at: new Date().toISOString() } : { instruction: text })
          .eq("id", existing.id)
      : text === ""
        ? null
        : untyped(db)
            .from("segment_library_cue_calls")
            .insert({ segment_library_cue_id: cueId, call_kind: kind, instruction: text });
    if (write) {
      const { error } = await write;
      if (error) return fail(toDataError(error));
    }
  }
  return ok(null);
}

/**
 * Copies a library segment into a running order (app.insert_library_segment) before the cue at the 1-based place
 * `beforePosition` (null appends). With `startsAt` the copies are planned from it; without, they are unplanned.
 * Returns the new segment instance.
 */
export async function insertLibrarySegment(
  db: XosClient,
  input: {
    readonly runOfShowId: string;
    readonly segmentId: string;
    readonly beforePosition: number | null;
    readonly startsAt: string | null;
  },
): Promise<Result<{ instanceId: string }>> {
  const { data, error } = await untyped(db).rpc("insert_library_segment", {
    p_run_of_show_id: input.runOfShowId,
    p_segment_library_id: input.segmentId,
    p_before_position: input.beforePosition,
    p_starts_at: input.startsAt,
  });
  if (error) return fail(toDataError(error));
  return ok({ instanceId: String(data) });
}

/** What publishing did to one copy of the segment, or to a running order without one. */
export type PublishOutcome = "Published" | "Current" | "Called" | "Linked" | "No Instance";

export const PUBLISH_OUTCOMES: readonly PublishOutcome[] = [
  "Published",
  "Current",
  "Called",
  "Linked",
  "No Instance",
];

export interface PublishResult {
  readonly runOfShowId: string;
  readonly instanceId: string | null;
  readonly outcome: PublishOutcome;
}

/** Publishes a segment's current version to chosen running orders (app.publish_library_segment, at most 50). */
export async function publishLibrarySegment(
  db: XosClient,
  segmentId: string,
  runIds: readonly string[],
): Promise<Result<PublishResult[]>> {
  const { data, error } = await untyped(db).rpc("publish_library_segment", {
    p_segment_library_id: segmentId,
    p_run_ids: runIds,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as {
        run_of_show_id: string;
        segment_instance_id: string | null;
        outcome: string;
      }[]
    ).map((r) => ({
      runOfShowId: r.run_of_show_id,
      instanceId: r.segment_instance_id,
      outcome: (PUBLISH_OUTCOMES as readonly string[]).includes(r.outcome)
        ? (r.outcome as PublishOutcome)
        : "No Instance",
    })),
  );
}

/** A running order holding a copy of the segment, for the publish picker. */
export interface SegmentCopy {
  readonly instanceId: string;
  readonly runOfShowId: string;
  readonly runName: string;
  readonly showDate: string;
  readonly libraryVersion: number;
}

/** The live copies of a segment in running orders the caller can read, by show date. */
export async function listSegmentCopies(
  db: XosClient,
  segmentId: string,
): Promise<Result<SegmentCopy[]>> {
  const { data, error } = await untyped(db)
    .from("run_segment_instances")
    .select(
      "id, run_of_show_id, library_version, run:run_of_show!inner(name, show_date, deleted_at)",
    )
    .eq("segment_library_id", segmentId)
    .is("deleted_at", null)
    .is("run.deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as unknown as {
        id: string;
        run_of_show_id: string;
        library_version: number;
        run: { name: string; show_date: string } | null;
      }[]
    )
      .map((r) => ({
        instanceId: r.id,
        runOfShowId: r.run_of_show_id,
        runName: r.run?.name ?? "",
        showDate: r.run?.show_date ?? "",
        libraryVersion: r.library_version,
      }))
      .sort((a, b) => a.showDate.localeCompare(b.showDate) || a.runName.localeCompare(b.runName)),
  );
}
