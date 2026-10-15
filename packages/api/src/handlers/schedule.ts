/**
 * Schedule handlers (A08): baselines, actuals, working calendars, record dependencies and
 * recurrence rules. Reads run as the caller (invariant 2). Creating a baseline captures the plan
 * and locks it in one transaction (app.lock_baseline), so `captured_at` is the lock time and a
 * captured baseline never changes; deleting one is refused as schedule evidence.
 */
import type { XosClient } from "@xos/data";
import { lockBaseline } from "@xos/data/schedule";
import type { Components } from "../contract/operations.generated.ts";
import { notFound, preconditionFailed } from "../problem.ts";
import { requireOrg } from "../runtime/context.ts";
import { versionFromIfMatch } from "../runtime/etag.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import { listPage } from "../runtime/listing.ts";
import { selectColumns } from "../runtime/pagination.ts";
import { aliasedSource, problemFor } from "./projects.ts";

type Baseline = Components["ScheduleBaseline"];
type Actual = Components["ScheduleActual"];
type CalendarBody = Components["Calendar"];
type Dependency = Components["RecordDependency"];
type Recurrence = Components["RecordRecurrence"];
type Row = Record<string, unknown>;
type Table =
  | "schedule_baselines"
  | "schedule_actuals"
  | "calendars"
  | "record_dependencies"
  | "record_recurrences";

const BASE = ["id", "org_id", "created_at", "created_by", "updated_at", "updated_by"] as const;

const BASELINE_COLUMNS = [...BASE, "project_id", "name", "captured_at"] as const;
const BASELINE_ALIASES = { captured_at: "locked_at" } as const;
const ACTUAL_COLUMNS = [...BASE, "record_id", "actual_start_at", "actual_end_at"] as const;
const ACTUAL_ALIASES = {
  actual_start_at: "actual_starts_at",
  actual_end_at: "actual_ends_at",
} as const;
const CALENDAR_COLUMNS = [...BASE, "name", "time_zone", "project_id"] as const;
const DEPENDENCY_COLUMNS = [
  ...BASE,
  "predecessor_id",
  "successor_id",
  "dependency_type",
  "lag_minutes",
] as const;
const DEPENDENCY_ALIASES = {
  predecessor_id: "predecessor_record_id",
  successor_id: "successor_record_id",
} as const;
const RECURRENCE_COLUMNS = [...BASE, "record_id", "rrule", "time_zone", "until"] as const;

/** Dependency types as the contract codes them: Finish to Start is finish_to_start. */
export function dependencyCode(type: string): string {
  return type.toLowerCase().replace(/ /g, "_");
}

export function dependencyType(code: string): string {
  return code
    .split("_")
    .map((w) => (w === "to" ? "to" : `${w.charAt(0).toUpperCase()}${w.slice(1)}`))
    .join(" ");
}

/** Postgres interval text to whole minutes (lag), for example "-01:30:00" is -90. */
export function intervalMinutes(interval: unknown): number {
  const text = String(interval ?? "0");
  const match = /^(?:(-?\d+) days? ?)?(-)?(\d+):(\d{2}):(\d{2})/.exec(text);
  if (!match) return Number.parseInt(text, 10) || 0;
  const sign = match[2] === "-" ? -1 : 1;
  return Number(match[1] ?? 0) * 1440 + sign * (Number(match[3]) * 60 + Number(match[4]));
}

function aliasSelect(columns: readonly string[], aliases: Readonly<Record<string, string>>) {
  return columns.map((c) => (aliases[c] ? `${c}:${aliases[c]}` : c)).join(",");
}

function live(db: XosClient, table: Table) {
  return { select: (c: string) => db.from(table).select(c).is("deleted_at", null) };
}

async function readOne(
  db: XosClient,
  table: Table,
  id: string,
  select: string,
  label: string,
): Promise<Row> {
  const { data, error } = await db
    .from(table)
    .select(select)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No ${label} with id ${id} is visible to you.`);
  return data as unknown as Row;
}

async function guardedUpdate(
  db: XosClient,
  table: Table,
  id: string,
  patch: Row,
  ifMatch: string | undefined,
  label: string,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const version = versionFromIfMatch(ifMatch ?? "*");
  let update = db
    .from(table)
    .update(patch as never)
    .eq("id", id)
    .is("deleted_at", null);
  if (version !== null) update = update.eq("updated_at", version);
  const { data, error } = await update.select("id").maybeSingle();
  if (error !== null) throw error;
  if (data === null) {
    await readOne(db, table, id, "id", label);
    throw preconditionFailed();
  }
}

async function softDelete(db: XosClient, table: Table, id: string, label: string) {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No ${label} with id ${id} is visible to you.`);
  return noContent();
}

function defined(body: Row): Row {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

const dependencySelect = aliasSelect(
  DEPENDENCY_COLUMNS.filter((c) => c !== "lag_minutes"),
  DEPENDENCY_ALIASES,
);

function toDependency(row: Row): Dependency {
  const { lag, ...rest } = row;
  return {
    ...(rest as unknown as Dependency),
    dependency_type: dependencyCode(String(row["dependency_type"])),
    lag_minutes: intervalMinutes(lag),
  };
}

const recurrenceSelect = [...BASE, "record_id", "rrule", "time_zone", "until_at"].join(",");

function toRecurrence(row: Row): Recurrence {
  const { until_at: untilAt, ...rest } = row;
  return {
    ...(rest as unknown as Recurrence),
    until: typeof untilAt === "string" ? untilAt.slice(0, 10) : null,
  };
}

/** The last instant of a series' last day: the rule's `until` date read as end of day UTC. */
function untilInstant(until: string | null | undefined): string | null | undefined {
  if (until === undefined) return undefined;
  return until === null ? null : `${until}T23:59:59Z`;
}

export const handlers = defineHandlers("Schedule", {
  "scheduleBaselines.list": async ({ query }, { db }) =>
    ok(
      await listPage<Baseline>(
        aliasedSource(
          () => ({
            select: (c: string) =>
              db
                .from("schedule_baselines")
                .select(c)
                .is("deleted_at", null)
                .not("locked_at", "is", null),
          }),
          BASELINE_ALIASES,
        ),
        query,
        { columns: BASELINE_COLUMNS, key: "id", defaultOrder: ["captured_at"] },
      ),
    ),

  "scheduleBaselines.get": async ({ params, query }, { db }) =>
    ok(
      (await readOne(
        db,
        "schedule_baselines",
        params.id,
        aliasSelect(selectColumns(query.fields, BASELINE_COLUMNS, "id"), BASELINE_ALIASES),
        "baseline",
      )) as unknown as Baseline,
    ),

  "scheduleBaselines.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("schedule_baselines")
      .insert({ org_id: requireOrg(context).id, project_id: body.project_id, name: body.name })
      .select("id")
      .single();
    if (error !== null) throw error;
    const locked = await lockBaseline(context.db, data.id);
    if (!locked.ok) throw problemFor(locked.error);
    return created(
      (await readOne(
        context.db,
        "schedule_baselines",
        data.id,
        aliasSelect(BASELINE_COLUMNS, BASELINE_ALIASES),
        "baseline",
      )) as unknown as Baseline,
    );
  },

  "scheduleBaselines.delete": async ({ params }, { db }) =>
    softDelete(db, "schedule_baselines", params.id, "baseline"),

  "scheduleActuals.list": async ({ query }, { db }) =>
    ok(
      await listPage<Actual>(
        aliasedSource(() => live(db, "schedule_actuals"), ACTUAL_ALIASES),
        query,
        {
          columns: ACTUAL_COLUMNS,
          key: "id",
          defaultOrder: ["created_at"],
        },
      ),
    ),

  "scheduleActuals.get": async ({ params, query }, { db }) =>
    ok(
      (await readOne(
        db,
        "schedule_actuals",
        params.id,
        aliasSelect(selectColumns(query.fields, ACTUAL_COLUMNS, "id"), ACTUAL_ALIASES),
        "actual",
      )) as unknown as Actual,
    ),

  "scheduleActuals.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("schedule_actuals")
      .insert({
        org_id: requireOrg(context).id,
        record_id: body.record_id,
        actual_starts_at: body.actual_start_at ?? null,
        actual_ends_at: body.actual_end_at ?? null,
      })
      .select(aliasSelect(ACTUAL_COLUMNS, ACTUAL_ALIASES))
      .single();
    if (error !== null) throw error;
    return created(data as unknown as Actual);
  },

  "scheduleActuals.update": async ({ params, body, ifMatch }, { db }) => {
    await guardedUpdate(
      db,
      "schedule_actuals",
      params.id,
      defined({ actual_starts_at: body.actual_start_at, actual_ends_at: body.actual_end_at }),
      ifMatch,
      "actual",
    );
    return ok(
      (await readOne(
        db,
        "schedule_actuals",
        params.id,
        aliasSelect(ACTUAL_COLUMNS, ACTUAL_ALIASES),
        "actual",
      )) as unknown as Actual,
    );
  },

  "calendars.list": async ({ query }, { db }) =>
    ok(
      await listPage<CalendarBody>(live(db, "calendars"), query, {
        columns: CALENDAR_COLUMNS,
        key: "id",
        defaultOrder: ["created_at"],
      }),
    ),

  "calendars.get": async ({ params, query }, { db }) =>
    ok(
      (await readOne(
        db,
        "calendars",
        params.id,
        selectColumns(query.fields, CALENDAR_COLUMNS, "id").join(","),
        "calendar",
      )) as unknown as CalendarBody,
    ),

  "calendars.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("calendars")
      .insert({
        org_id: requireOrg(context).id,
        project_id: body.project_id as string,
        name: body.name,
        time_zone: body.time_zone,
      })
      .select(CALENDAR_COLUMNS.join(","))
      .single();
    if (error !== null) throw error;
    return created(data as unknown as CalendarBody);
  },

  "calendars.update": async ({ params, body, ifMatch }, { db }) => {
    await guardedUpdate(db, "calendars", params.id, defined(body as Row), ifMatch, "calendar");
    return ok(
      (await readOne(
        db,
        "calendars",
        params.id,
        CALENDAR_COLUMNS.join(","),
        "calendar",
      )) as unknown as CalendarBody,
    );
  },

  "calendars.delete": async ({ params }, { db }) =>
    softDelete(db, "calendars", params.id, "calendar"),

  "recordDependencies.list": async ({ query }, { db }) => {
    const page = await listPage<Row>(
      aliasedSource(
        () => ({
          select: (c: string) =>
            db.from("record_dependencies").select(`${c},lag`).is("deleted_at", null),
        }),
        DEPENDENCY_ALIASES,
      ),
      { ...query, fields: DEPENDENCY_COLUMNS.filter((c) => c !== "lag_minutes").join(",") },
      {
        columns: DEPENDENCY_COLUMNS.filter((c) => c !== "lag_minutes"),
        key: "id",
        defaultOrder: ["created_at"],
      },
    );
    const wanted = selectColumns(query.fields, DEPENDENCY_COLUMNS, "id");
    const data = page.data.map((row) => {
      const full = toDependency(row) as unknown as Row;
      return Object.fromEntries(wanted.map((c) => [c, full[c] ?? null]));
    });
    return ok({
      data,
      next_cursor: page.next_cursor,
    } as unknown as Components["RecordDependencyPage"]);
  },

  "recordDependencies.get": async ({ params }, { db }) =>
    ok(
      toDependency(
        await readOne(
          db,
          "record_dependencies",
          params.id,
          `${dependencySelect},lag`,
          "dependency",
        ),
      ),
    ),

  "recordDependencies.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("record_dependencies")
      .insert({
        org_id: requireOrg(context).id,
        predecessor_record_id: body.predecessor_id,
        successor_record_id: body.successor_id,
        dependency_type: dependencyType(body.dependency_type) as never,
        lag: `${body.lag_minutes} minutes`,
      })
      .select(`${dependencySelect},lag`)
      .single();
    if (error !== null) throw error;
    return created(toDependency(data as unknown as Row));
  },

  "recordDependencies.delete": async ({ params }, { db }) =>
    softDelete(db, "record_dependencies", params.id, "dependency"),

  "recordRecurrences.list": async ({ query }, { db }) => {
    const filter = { ...(query.filter ?? {}) };
    const until = filter["until"];
    delete filter["until"];
    const page = await listPage<Row>(
      aliasedSource(
        () => ({
          select: (c: string) => {
            let b = db.from("record_recurrences").select(`${c},until_at`).is("deleted_at", null);
            if (until?.is_null === "true") b = b.is("until_at", null);
            return b;
          },
        }),
        {},
      ),
      { ...query, filter, fields: RECURRENCE_COLUMNS.filter((c) => c !== "until").join(",") },
      {
        columns: RECURRENCE_COLUMNS.filter((c) => c !== "until"),
        key: "id",
        defaultOrder: ["created_at"],
      },
    );
    const wanted = selectColumns(query.fields, RECURRENCE_COLUMNS, "id");
    const data = page.data.map((row) => {
      const full = toRecurrence(row) as unknown as Row;
      return Object.fromEntries(wanted.map((c) => [c, full[c] ?? null]));
    });
    return ok({
      data,
      next_cursor: page.next_cursor,
    } as unknown as Components["RecordRecurrencePage"]);
  },

  "recordRecurrences.get": async ({ params }, { db }) =>
    ok(
      toRecurrence(
        await readOne(db, "record_recurrences", params.id, recurrenceSelect, "recurrence"),
      ),
    ),

  "recordRecurrences.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("record_recurrences")
      .insert({
        org_id: requireOrg(context).id,
        record_id: body.record_id,
        rrule: body.rrule,
        time_zone: body.time_zone,
        until_at: untilInstant(body.until) ?? null,
      })
      .select(recurrenceSelect)
      .single();
    if (error !== null) throw error;
    return created(toRecurrence(data as unknown as Row));
  },

  "recordRecurrences.update": async ({ params, body, ifMatch }, { db }) => {
    await guardedUpdate(
      db,
      "record_recurrences",
      params.id,
      defined({ rrule: body.rrule, time_zone: body.time_zone, until_at: untilInstant(body.until) }),
      ifMatch,
      "recurrence",
    );
    return ok(
      toRecurrence(
        await readOne(db, "record_recurrences", params.id, recurrenceSelect, "recurrence"),
      ),
    );
  },

  "recordRecurrences.delete": async ({ params }, { db }) =>
    softDelete(db, "record_recurrences", params.id, "recurrence"),
});
