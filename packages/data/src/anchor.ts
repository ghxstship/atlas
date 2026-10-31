import type { XosClient } from "./client.ts";
import { fail, ok, rowRefusal, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Anchor offset scheduling (B4, G-44, migration 2934, ADR 0143 decision 4): a project's plan counts from its anchor
 * day (projects.anchor_on), and only app.move_project_anchor moves the plan with it. The first anchor is a plain
 * update (setProjectAnchor), which moves nothing, as a v1 PATCH /projects moves nothing.
 */

export type AnchorItemKind =
  | "Project"
  | "Record"
  | "Running Order"
  | "Cue"
  | "Project Day"
  | "Day Sheet"
  | "Call Sheet"
  | "Shift"
  | "Dock Slot";

export type AnchorStay =
  "pinned" | "complete" | "baseline_locked" | "undated" | "published" | "shift" | "booked";

export interface AnchorItem {
  readonly kind: AnchorItemKind;
  readonly id: string;
  readonly label: string;
  readonly moves: boolean;
  readonly staysBecause: AnchorStay | null;
  readonly oldAt: string | null;
  readonly newAt: string | null;
  readonly oldOn: string | null;
  readonly newOn: string | null;
  readonly shiftDays: number;
}

interface AnchorRow {
  item_kind: AnchorItemKind;
  item_id: string;
  label: string;
  moves: boolean;
  stays_because: AnchorStay | null;
  old_at: string | null;
  new_at: string | null;
  old_on: string | null;
  new_on: string | null;
  shift_days: number;
}

/** Previews (commit false) or moves a project's anchor and its plan. Preview and commit return the same rows. */
export async function moveProjectAnchor(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly anchorOn: string;
    readonly commit: boolean;
    readonly reason?: string | null;
  },
): Promise<Result<AnchorItem[]>> {
  const { data, error } = await untyped(db).rpc("move_project_anchor", {
    p_project_id: input.projectId,
    p_anchor_on: input.anchorOn,
    p_commit: input.commit,
    p_reason: input.reason?.trim() || null,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data as AnchorRow[]).map((r) => ({
      kind: r.item_kind,
      id: r.item_id,
      label: r.label,
      moves: r.moves,
      staysBecause: r.stays_because,
      oldAt: r.old_at,
      newAt: r.new_at,
      oldOn: r.old_on,
      newOn: r.new_on,
      shiftDays: r.shift_days,
    })),
  );
}

/**
 * Sets a project's first anchor day. A plain update that moves nothing (needs projects.project.write), and only while
 * the project has no anchor: a page opened before someone else set one refuses anchor_set, so a set anchor changes only
 * through moveProjectAnchor, which moves the plan with it.
 */
export async function setProjectAnchor(
  db: XosClient,
  projectId: string,
  anchorOn: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("projects")
    .update({ anchor_on: anchorOn })
    .eq("id", projectId)
    .is("anchor_on", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length > 0) return ok(null);
  // Nothing matched: either the anchor is already set, or the project is gone or unreadable.
  const read = await db.from("projects").select("id").eq("id", projectId).maybeSingle();
  if (read.error) return fail(toDataError(read.error));
  return read.data ? fail(rowRefusal("anchor_set")) : fail({ kind: "not-found" });
}

/** Pins a record to its dates, or frees it, when the anchor moves. */
export async function setRecordAnchorPinned(
  db: XosClient,
  recordId: string,
  pinned: boolean,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("records")
    .update({ anchor_pinned: pinned })
    .eq("id", recordId)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return fail({ kind: "not-found" });
  return ok(null);
}

/** The calendar date of an instant in a zone, as YYYY-MM-DD. */
export function localDate(at: string | Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof at === "string" ? new Date(at) : at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole days from one calendar date to another (YYYY-MM-DD). */
export function daysBetweenDates(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/**
 * A record's offset from the anchor in whole days, signed: -3 is three days before the anchor (D-3), 1 the day after
 * (D+1). The record's date is read on the project's wall clock.
 */
export function anchorOffset(recordDate: string | Date, anchorOn: string, zone: string): number {
  return daysBetweenDates(anchorOn, localDate(recordDate, zone));
}

/** D-3, D0, D+1. */
export function formatAnchorOffset(offset: number): string {
  if (offset === 0) return "D0";
  return offset < 0 ? `D−${-offset}` : `D+${offset}`;
}

/** The new anchor a shift of whole days lands on. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A project's anchor day, or null while none is set. */
export async function getProjectAnchor(
  db: XosClient,
  projectId: string,
): Promise<Result<string | null>> {
  const { data, error } = await db
    .from("projects")
    .select("anchor_on")
    .eq("id", projectId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(data.anchor_on);
}

/** Whether a record stays on its dates when its project's anchor moves. */
export async function getRecordAnchorPinned(
  db: XosClient,
  recordId: string,
): Promise<Result<boolean>> {
  const { data, error } = await db
    .from("records")
    .select("anchor_pinned")
    .eq("id", recordId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(data.anchor_pinned);
}
