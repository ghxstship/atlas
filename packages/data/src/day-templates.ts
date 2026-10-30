import type { XosClient } from "./client.ts";
import type { DayType } from "./schedule-days.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Day templates (B4, G-42, migrations 2932 and 2933, ADR 0143 decisions 2 and 3): a day's records and cues saved
 * with times relative to local midnight, and laid onto another day through a dry run that shows the day's existing
 * items beside the template's, duplicates unticked and overlaps counted. They live in tables of their own because v1
 * freezes Template.template_kind and TemplateItem.item_kind; GET /templates never returns one.
 */

export interface DayTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly dayType: DayType | null;
  readonly itemCount: number;
  readonly updatedAt: string;
}

export type DayTemplateItemKind = "Record" | "Cue";

export interface DayTemplateItem {
  readonly id: string;
  readonly templateId: string;
  readonly kind: DayTemplateItemKind;
  readonly sortOrder: number;
  readonly name: string;
  readonly recordKind: string | null;
  readonly xyz: string | null;
  readonly phaseCode: string | null;
  /** Minutes from the day's local midnight, -1440 to 2879. */
  readonly startMinute: number;
  /** 0 to 1440; null on a record means it is due at its start. */
  readonly durationMinutes: number | null;
  readonly segment: string | null;
  readonly startTbc: boolean;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  day_type: DayType | null;
  updated_at: string;
  items: { count: number }[] | null;
}

/** The org's live day templates, by name. */
export async function listDayTemplates(
  db: XosClient,
  orgId: string,
): Promise<Result<DayTemplate[]>> {
  const { data, error } = await untyped(db)
    .from("day_templates")
    .select("id, name, description, day_type, updated_at, items:day_template_items(count)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("items.deleted_at", null)
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    (data as TemplateRow[]).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      dayType: t.day_type,
      itemCount: t.items?.[0]?.count ?? 0,
      updatedAt: t.updated_at,
    })),
  );
}

interface ItemRow {
  id: string;
  day_template_id: string;
  item_kind: DayTemplateItemKind;
  sort_order: number;
  name: string;
  record_kind: string | null;
  xyz: string | null;
  phase_code: string | null;
  start_minute: number;
  duration_minutes: number | null;
  segment: string | null;
  start_tbc: boolean;
}

const ITEM_COLUMNS =
  "id, day_template_id, item_kind, sort_order, name, record_kind, xyz, phase_code, start_minute, duration_minutes, segment, start_tbc";

function toItem(r: ItemRow): DayTemplateItem {
  return {
    id: r.id,
    templateId: r.day_template_id,
    kind: r.item_kind,
    sortOrder: r.sort_order,
    name: r.name,
    recordKind: r.record_kind,
    xyz: r.xyz,
    phaseCode: r.phase_code,
    startMinute: r.start_minute,
    durationMinutes: r.duration_minutes,
    segment: r.segment,
    startTbc: r.start_tbc,
  };
}

/** A template's live items, in start order. */
export async function listDayTemplateItems(
  db: XosClient,
  templateId: string,
): Promise<Result<DayTemplateItem[]>> {
  const { data, error } = await untyped(db)
    .from("day_template_items")
    .select(ITEM_COLUMNS)
    .eq("day_template_id", templateId)
    .is("deleted_at", null)
    .order("start_minute", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok((data as ItemRow[]).map(toItem));
}

/** Adds a template, or renames and redescribes one. */
export async function saveDayTemplate(
  db: XosClient,
  input: {
    readonly id?: string;
    readonly orgId: string;
    readonly name: string;
    readonly description?: string | null;
    readonly dayType?: DayType | null;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    name: input.name.trim(),
    description: input.description?.trim() ? input.description.trim() : null,
    day_type: input.dayType ?? null,
  };
  const table = untyped(db).from("day_templates");
  const { data, error } = input.id
    ? await table.update(row).eq("id", input.id).select("id").single()
    : await table
        .insert({ ...row, org_id: input.orgId })
        .select("id")
        .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

/** Moves a template, or one item, to Trash (ADR 0110). */
export async function deleteDayTemplate(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "day_templates", id);
}

export async function deleteDayTemplateItem(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "day_template_items", id);
}

async function softDelete(db: XosClient, table: string, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  if ((data as unknown[]).length === 0) return fail({ kind: "not-found" });
  return ok(null);
}

/** Adds or changes an item. A Record item's name must pass its kind's title grammar (day_template_title). */
export async function saveDayTemplateItem(
  db: XosClient,
  input: Omit<DayTemplateItem, "id" | "templateId"> & {
    readonly id?: string;
    readonly templateId: string;
  },
): Promise<Result<{ id: string }>> {
  const row = {
    item_kind: input.kind,
    sort_order: input.sortOrder,
    name: input.name.trim(),
    record_kind: input.kind === "Record" ? input.recordKind : null,
    xyz: input.kind === "Record" ? input.xyz : null,
    phase_code: input.kind === "Record" ? input.phaseCode : null,
    start_minute: input.startMinute,
    duration_minutes: input.durationMinutes,
    segment: input.kind === "Cue" ? input.segment?.trim() || null : null,
    start_tbc: input.startTbc,
  };
  const table = untyped(db).from("day_template_items");
  const { data, error } = input.id
    ? await table.update(row).eq("id", input.id).select("id").single()
    : await table
        .insert({ ...row, day_template_id: input.templateId })
        .select("id")
        .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

export type ApplyAction =
  "create" | "skip_duplicate" | "skip_chosen" | "skip_no_running_order" | "refused";

export interface ApplyItem {
  readonly itemId: string;
  readonly kind: DayTemplateItemKind;
  readonly name: string;
  readonly action: ApplyAction;
  readonly rule: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
  readonly overlaps: number;
  readonly duplicateOf: string | null;
  readonly createdId: string | null;
}

interface ApplyRow {
  item_id: string;
  item_kind: DayTemplateItemKind;
  name: string;
  action: ApplyAction;
  refusal_code: string | null;
  starts_at: string | null;
  ends_at: string | null;
  due_at: string | null;
  overlaps: number;
  duplicate_of: string | null;
  created_id: string | null;
}

/** When an applied item happens: its start, else its due time. */
export function applyItemAt(item: Pick<ApplyItem, "startsAt" | "dueAt">): string | null {
  return item.startsAt ?? item.dueAt;
}

/** The dry run (commit false) or the application of a day template. Preview and commit return the same rows. */
export async function applyDayTemplate(
  db: XosClient,
  input: {
    readonly templateId: string;
    readonly projectId: string;
    readonly day: string;
    readonly runOfShowId?: string | null;
    readonly scopeNodeId?: string | null;
    readonly skipItemIds?: readonly string[];
    readonly includeDuplicates?: boolean;
    readonly commit: boolean;
  },
): Promise<Result<ApplyItem[]>> {
  const { data, error } = await untyped(db).rpc("apply_day_template", {
    p_day_template_id: input.templateId,
    p_project_id: input.projectId,
    p_day: input.day,
    p_run_of_show_id: input.runOfShowId ?? null,
    p_scope_node_id: input.scopeNodeId ?? null,
    p_skip_item_ids: [...(input.skipItemIds ?? [])],
    p_include_duplicates: input.includeDuplicates ?? false,
    p_commit: input.commit,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data as ApplyRow[]).map((r) => ({
      itemId: r.item_id,
      kind: r.item_kind,
      name: r.name,
      action: r.action,
      rule: r.refusal_code,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      dueAt: r.due_at,
      overlaps: r.overlaps,
      duplicateOf: r.duplicate_of,
      createdId: r.created_id,
    })),
  );
}

/** Saves a project day's records and cues as a new day template. */
export async function createDayTemplateFromDay(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly day: string;
    readonly name: string;
    readonly description?: string | null;
    readonly runOfShowId?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db).rpc("create_day_template_from_day", {
    p_project_id: input.projectId,
    p_day: input.day,
    p_name: input.name.trim(),
    p_description: input.description?.trim() || null,
    p_run_of_show_id: input.runOfShowId ?? null,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data as string });
}

/** Undoes an application: the records and cues it created go to Trash. */
export async function undoDayTemplateApplication(
  db: XosClient,
  created: readonly Pick<ApplyItem, "kind" | "createdId">[],
): Promise<Result<null>> {
  const ids = (kind: DayTemplateItemKind) =>
    created.filter((c) => c.kind === kind && c.createdId).map((c) => c.createdId as string);
  const now = new Date().toISOString();
  for (const [table, list] of [
    ["records", ids("Record")],
    ["cues", ids("Cue")],
  ] as const) {
    if (list.length === 0) continue;
    const { error } = await untyped(db).from(table).update({ deleted_at: now }).in("id", list);
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/** Minutes as the wall-clock time they stand for: 1455 is 00:15 the next day (+1), -30 is 23:30 the day before (-1). */
export function minuteClock(minute: number): { readonly time: string; readonly dayOffset: number } {
  const dayOffset = Math.floor(minute / 1440);
  const within = minute - dayOffset * 1440;
  const hh = String(Math.floor(within / 60)).padStart(2, "0");
  const mm = String(within % 60).padStart(2, "0");
  return { time: `${hh}:${mm}`, dayOffset };
}

/** An item already on a project day, shown beside a template's proposed items in the dry run. */
export interface DayItem {
  readonly kind: DayTemplateItemKind;
  readonly id: string;
  readonly label: string;
  readonly at: string | null;
  readonly endsAt: string | null;
}

interface DayRecordRow {
  id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  due_at: string | null;
}

interface DayCueRow {
  id: string;
  label: string;
  planned_at: string | null;
  duration: string | null;
  run: { show_date: string } | null;
}

/**
 * The live, non-Canceled records whose start (or due time) falls on a project day in its zone, and the cues of that
 * day's running orders, in time order. Reads as the caller.
 */
export async function listDayItems(
  db: XosClient,
  input: { readonly projectId: string; readonly day: string; readonly timeZone: string },
): Promise<Result<DayItem[]>> {
  // A day in any zone lies within a day either side of its UTC date; the zone then keeps the right ones.
  const from = new Date(Date.parse(`${input.day}T00:00:00Z`) - 86_400_000).toISOString();
  const to = new Date(Date.parse(`${input.day}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const [records, cues] = await Promise.all([
    untyped(db)
      .from("records")
      .select("id, title, starts_at, ends_at, due_at")
      .eq("project_id", input.projectId)
      .is("deleted_at", null)
      .neq("record_state", "Canceled")
      .or(`and(starts_at.gte.${from},starts_at.lt.${to}),and(starts_at.is.null,due_at.gte.${from},due_at.lt.${to})`)
      .limit(500),
    untyped(db)
      .from("cues")
      .select("id, label, planned_at, duration, run:run_of_show!inner(show_date)")
      .eq("project_id", input.projectId)
      .eq("run.show_date", input.day)
      .is("deleted_at", null)
      .limit(500),
  ]);
  if (records.error) return fail(toDataError(records.error));
  if (cues.error) return fail(toDataError(cues.error));
  const local = (at: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(at),
    );
  const items: DayItem[] = [
    ...(records.data as DayRecordRow[])
      .filter((r) => {
        const at = r.starts_at ?? r.due_at;
        return at !== null && local(at) === input.day;
      })
      .map((r) => ({ kind: "Record" as const, id: r.id, label: r.title, at: r.starts_at ?? r.due_at, endsAt: r.ends_at })),
    ...(cues.data as unknown as DayCueRow[]).map((c) => ({
      kind: "Cue" as const,
      id: c.id,
      label: c.label,
      at: c.planned_at,
      endsAt: null,
    })),
  ];
  return ok(items.sort((a, b) => (a.at ?? "￿").localeCompare(b.at ?? "￿")));
}
