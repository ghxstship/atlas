"use server";

import {
  moveProjectAnchor,
  setProjectAnchor,
  setRecordAnchorPinned,
  type AnchorItem,
} from "@xos/data/anchor";
import {
  applyDayTemplate,
  createDayTemplateFromDay,
  deleteDayTemplate,
  deleteDayTemplateItem,
  listDayItems,
  restoreDayTemplate,
  saveDayTemplate,
  saveDayTemplateItem,
  undoDayTemplateApplication,
  type ApplyItem,
  type DayItem,
} from "@xos/data/day-templates";
import {
  clashCountsByProject,
  loadClashes,
  loadTravelRequestClashes,
  type TravelRequestClash,
} from "@xos/data/schedule-clashes";
import {
  DAY_TYPES,
  deleteProjectDay,
  listProjectDays,
  restoreProjectDay,
  saveProjectDays,
  type DayType,
} from "@xos/data/schedule-days";
import { addDays } from "@xos/ui/quick-add";
import {
  listCueGridRows,
  saveCueGrid,
  saveDayGrid,
  type CueGridSource,
  type GridSave,
} from "@xos/data/schedule-grid";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { done, failed, invalid, type ActionResult } from "@/components/work/action-result";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Scheduling depth actions (B4, RRR-228; migrations 2930 to 2936, ADR 0143): day types, the day and cue grids, day
 * templates, anchor moves and the logged travel request check. Row level security and the RPCs decide every write;
 * a refusal comes back with its catalog sentence. Previews revalidate nothing, so the page stays as it was.
 */

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.iso.datetime({ offset: true }).nullable();
const refresh = (org: string) => revalidatePath(`/${org}`, "layout");

// Day types ----------------------------------------------------------------------------------------------------------

const segment = z.object({
  id: z.uuid().optional(),
  dayType: z.enum(DAY_TYPES as [string, ...string[]]),
  label: z.string().max(120).nullable(),
  venueId: z.uuid().nullable(),
  scopeNodeId: z.uuid().nullable(),
  locationText: z.string().max(300).nullable(),
  timeZone: z.string().max(64).nullable(),
  teamCode: z.string().max(16).nullable(),
});

/**
 * Saves a date's segments and moves the removed ones to Trash in one transaction (app.save_project_days): a refused
 * segment leaves the date as it was. An existing segment keeps its place in the day; a new one takes the first free one.
 */
export async function saveProjectDaysAction(
  org: string,
  input: { projectId: string; dayOn: string; segments: unknown[]; removedIds: string[] },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      projectId: z.uuid(),
      dayOn: day,
      segments: z
        .array(segment.extend({ sortOrder: z.number().int().min(1).max(4).optional() }))
        .max(4),
      removedIds: z.array(z.uuid()).max(4),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const saved = await saveProjectDays(ctx.viewer.db, {
    projectId: parsed.data.projectId,
    dayOn: parsed.data.dayOn,
    segments: parsed.data.segments.map((s) => ({ ...s, dayType: s.dayType as DayType })),
    removedIds: parsed.data.removedIds,
  });
  if (!saved.ok) return failed(saved.error);
  refresh(org);
  return done(null);
}

export async function deleteProjectDayAction(org: string, id: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return invalid();
  const result = await deleteProjectDay(ctx.viewer.db, id);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/** The delete toast's Undo: the day comes back from Trash. */
export async function restoreProjectDayAction(org: string, id: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return invalid();
  const result = await restoreProjectDay(ctx.viewer.db, id);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

// The grids ----------------------------------------------------------------------------------------------------------

const dayRow = z.object({
  id: z.uuid().optional(),
  expect: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])).optional(),
  title: z.string().max(200),
  recordKind: z.string().max(40).optional(),
  startsAt: instant,
  endsAt: instant,
  dueAt: instant,
  startTbc: z.boolean(),
  ownerPartyId: z.uuid().nullable(),
});

/** Previews (commit false) or saves a day grid. A preview writes nothing; a save writes every row or none. */
export async function saveDayGridAction(
  org: string,
  input: { projectId: string; day: string; rows: unknown[]; commit: boolean },
): Promise<ActionResult<GridSave>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      projectId: z.uuid(),
      day,
      rows: z.array(dayRow).min(1).max(200),
      commit: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await saveDayGrid(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit && result.data.refused === 0) refresh(org);
  return done(result.data);
}

const cueRow = z.object({
  id: z.uuid().optional(),
  expect: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  label: z.string().max(200),
  plannedAt: instant,
  durationMinutes: z.number().int().min(0).max(1440).nullable(),
  segment: z.string().max(200).nullable(),
  startTbc: z.boolean(),
});

export async function saveCueGridAction(
  org: string,
  input: { runOfShowId: string; rows: unknown[]; commit: boolean },
): Promise<ActionResult<GridSave>> {
  const ctx = await context(org);
  const parsed = z
    .object({ runOfShowId: z.uuid(), rows: z.array(cueRow).min(1).max(200), commit: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await saveCueGrid(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit && result.data.refused === 0) refresh(org);
  return done(result.data);
}

/** The cue grid's rows, read when it opens. */
export async function loadCueGridAction(
  org: string,
  runOfShowId: string,
): Promise<ActionResult<CueGridSource[]>> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(runOfShowId).success) return invalid();
  const result = await listCueGridRows(ctx.viewer.db, runOfShowId);
  if (!result.ok) return failed(result.error);
  return done(result.data);
}

// Day templates --------------------------------------------------------------------------------------------------------

export async function saveDayTemplateAction(
  org: string,
  input: { id?: string; name: string; description: string | null; dayType: string | null },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      id: z.uuid().optional(),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(2000).nullable(),
      dayType: z.enum(DAY_TYPES as [string, ...string[]]).nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await saveDayTemplate(ctx.viewer.db, {
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    orgId: ctx.org.id,
    name: parsed.data.name,
    description: parsed.data.description,
    dayType: parsed.data.dayType as (typeof DAY_TYPES)[number] | null,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

export async function deleteDayTemplateAction(org: string, id: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return invalid();
  const result = await deleteDayTemplate(ctx.viewer.db, id);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/** The delete toast's Undo: the template comes back from Trash. */
export async function restoreDayTemplateAction(org: string, id: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return invalid();
  const result = await restoreDayTemplate(ctx.viewer.db, id);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function saveDayTemplateItemAction(
  org: string,
  input: {
    id?: string;
    templateId: string;
    kind: "Record" | "Cue";
    sortOrder: number;
    name: string;
    recordKind: string | null;
    xyz: string | null;
    startMinute: number;
    durationMinutes: number | null;
    segment: string | null;
    startTbc: boolean;
  },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      id: z.uuid().optional(),
      templateId: z.uuid(),
      kind: z.enum(["Record", "Cue"]),
      sortOrder: z.number().int().min(1).max(500),
      name: z.string().trim().min(1).max(200),
      recordKind: z.string().max(40).nullable(),
      xyz: z.enum(["X", "Y", "Z"]).nullable(),
      startMinute: z.number().int().min(-1440).max(2879),
      durationMinutes: z.number().int().min(0).max(1440).nullable(),
      segment: z.string().max(200).nullable(),
      startTbc: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const { id, ...rest } = parsed.data;
  const result = await saveDayTemplateItem(ctx.viewer.db, {
    ...(id ? { id } : {}),
    ...rest,
    phaseCode: null,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

export async function deleteDayTemplateItemAction(org: string, id: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return invalid();
  const result = await deleteDayTemplateItem(ctx.viewer.db, id);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/** The dry run (commit false) or the application of a day template onto a project day. */
export async function applyDayTemplateAction(
  org: string,
  input: {
    templateId: string;
    projectId: string;
    day: string;
    runOfShowId: string | null;
    skipItemIds: string[];
    includeDuplicates: boolean;
    commit: boolean;
  },
): Promise<ActionResult<ApplyItem[]>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      templateId: z.uuid(),
      projectId: z.uuid(),
      day,
      runOfShowId: z.uuid().nullable(),
      skipItemIds: z.array(z.uuid()).max(500),
      includeDuplicates: z.boolean(),
      commit: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await applyDayTemplate(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit) refresh(org);
  return done(result.data);
}

/** What is already on a project day, for the dry run's side-by-side view. */
export async function listDayItemsAction(
  org: string,
  input: { projectId: string; day: string; timeZone: string },
): Promise<ActionResult<DayItem[]>> {
  const ctx = await context(org);
  const parsed = z
    .object({ projectId: z.uuid(), day, timeZone: z.string().min(1).max(64) })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await listDayItems(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  return done(result.data);
}

/** The Undo toast of an application: what it created goes to Trash. */
export async function undoDayTemplateApplicationAction(
  org: string,
  created: { kind: "Record" | "Cue"; createdId: string | null }[],
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .array(z.object({ kind: z.enum(["Record", "Cue"]), createdId: z.uuid().nullable() }))
    .max(500)
    .safeParse(created);
  if (!parsed.success) return invalid();
  const result = await undoDayTemplateApplication(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function createDayTemplateFromDayAction(
  org: string,
  input: { projectId: string; day: string; name: string; runOfShowId: string | null },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      projectId: z.uuid(),
      day,
      name: z.string().trim().min(1).max(200),
      runOfShowId: z.uuid().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await createDayTemplateFromDay(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

// The anchor ---------------------------------------------------------------------------------------------------------

/** Sets the first anchor day: a plain update that moves nothing. */
export async function setProjectAnchorAction(
  org: string,
  input: { projectId: string; anchorOn: string },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z.object({ projectId: z.uuid(), anchorOn: day }).safeParse(input);
  if (!parsed.success) return invalid();
  const result = await setProjectAnchor(ctx.viewer.db, parsed.data.projectId, parsed.data.anchorOn);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/** Previews (commit false) or moves the anchor and the plan with it. Preview and commit return the same rows. */
export async function moveProjectAnchorAction(
  org: string,
  input: { projectId: string; anchorOn: string; commit: boolean; reason: string | null },
): Promise<ActionResult<AnchorItem[]>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      projectId: z.uuid(),
      anchorOn: day,
      commit: z.boolean(),
      reason: z.string().max(500).nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await moveProjectAnchor(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit) refresh(org);
  return done(result.data);
}

export async function setRecordAnchorPinnedAction(
  org: string,
  input: { recordId: string; pinned: boolean },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z.object({ recordId: z.uuid(), pinned: z.boolean() }).safeParse(input);
  if (!parsed.success) return invalid();
  const result = await setRecordAnchorPinned(
    ctx.viewer.db,
    parsed.data.recordId,
    parsed.data.pinned,
  );
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

// Requested travel ---------------------------------------------------------------------------------------------------

/**
 * Checks a project's requested travel dates against calls. The database records each check in the access log of
 * every person compared, so this runs only when the person asks, and its answer is never cached or exported.
 */
export async function checkTravelRequestsAction(
  org: string,
  projectId: string,
): Promise<ActionResult<TravelRequestClash[]>> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(projectId).success) return invalid();
  const result = await loadTravelRequestClashes(ctx.viewer.db, projectId);
  if (!result.ok) return failed(result.error);
  return done(result.data);
}

// The portfolio timeline ------------------------------------------------------------------------------------------------

/**
 * What the portfolio timeline draws over its bars (B4, G-38, G-46): each project's Load In, Show and Load Out days,
 * and its clash count over the next 90 days. Asked for only while /projects shows its Timeline view, after the page
 * has painted, so the default view runs no added query.
 */
export async function portfolioOverlayAction(
  org: string,
  input: { projectIds: string[]; from: string },
): Promise<
  ActionResult<{
    days: { projectId: string; dayOn: string; dayType: DayType }[];
    clashes: Record<string, number>;
  }>
> {
  const ctx = await context(org);
  const parsed = z.object({ projectIds: z.array(z.uuid()).max(500), from: day }).safeParse(input);
  if (!parsed.success) return invalid();
  const db = ctx.viewer.db;
  const [days, clashes] = await Promise.all([
    listProjectDays(db, { orgId: ctx.org.id, projectIds: parsed.data.projectIds }),
    loadClashes(db, {
      orgId: ctx.org.id,
      from: parsed.data.from,
      to: addDays(parsed.data.from, 89),
    }),
  ]);
  if (!days.ok) return failed(days.error);
  if (!clashes.ok) return failed(clashes.error);
  const wanted = new Set<DayType>(["Load In", "Show", "Load Out"]);
  const inView = new Set(parsed.data.projectIds);
  return done({
    days: days.data
      .filter((d) => wanted.has(d.dayType))
      .map((d) => ({ projectId: d.projectId, dayOn: d.dayOn, dayType: d.dayType })),
    clashes: Object.fromEntries(
      [...clashCountsByProject(clashes.data.clashes)].filter(([id]) => inView.has(id)),
    ),
  });
}
