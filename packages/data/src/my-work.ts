import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * My Work repository (Section 4.5.4): the open records the signed-in person owns, is accountable
 * for or is assigned to, across every project they may read, grouped by when they are due. Reads go
 * through row level security (invariant 2), so a record of a project the person can no longer read
 * never appears, even if an assignment row still names them.
 */

/** Why a record is on the person's list. */
export type MyWorkRole = "owner" | "accountable" | "assigned";

/** When a record is due, relative to the person's day in their time zone. */
export type DueState = "overdue" | "today" | "upcoming" | "undated";

export const DUE_STATES: readonly DueState[] = ["overdue", "today", "upcoming", "undated"];

export interface MyWorkRecord {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly state: string;
  readonly dueAt: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly projectKey: string;
  readonly projectName: string;
  readonly updatedAt: string;
  readonly roles: readonly MyWorkRole[];
  /** The record's owner, for its hover card; null when nobody owns it. */
  readonly ownerId: string | null;
}

/** Record states that close a record; a closed record is never due or overdue. */
const CLOSED_STATES = "(Complete,Canceled,Deferred)";

const COLUMNS =
  "id, record_number, record_kind, record_state, title, due_at, starts_at, ends_at, updated_at, owner_party_id, accountable_party_id, project:projects!records_project_id_fkey!inner(project_key, name)";

interface Row {
  id: string;
  record_number: number;
  record_kind: string;
  record_state: string;
  title: string;
  due_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
  owner_party_id: string | null;
  accountable_party_id: string | null;
  project: { project_key: string; name: string } | null;
}

/**
 * The person's open records: owned, accountable or assigned through their membership, archived
 * ones left out (A124). At most `limit` records (500 by default), soonest due first.
 */
export async function listMyWork(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly personId: string;
    readonly membershipId: string | null;
    readonly limit?: number;
  },
): Promise<Result<MyWorkRecord[]>> {
  let assigned: string[] = [];
  if (input.membershipId) {
    const { data, error } = await db
      .from("record_assignments")
      .select("record_id")
      .eq("org_id", input.orgId)
      .eq("membership_id", input.membershipId)
      .is("deleted_at", null)
      .limit(1000);
    if (error) return fail(toDataError(error));
    assigned = [...new Set((data ?? []).map((a) => a.record_id))];
  }
  const parties = [
    `owner_party_id.eq.${input.personId}`,
    `accountable_party_id.eq.${input.personId}`,
    ...(assigned.length > 0 ? [`id.in.(${assigned.join(",")})`] : []),
  ];
  const { data, error } = await db
    .from("records")
    .select(COLUMNS)
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .is("archived_at", null)
    .not("record_state", "in", CLOSED_STATES)
    .or(parties.join(","))
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("record_number")
    .limit(input.limit ?? 500);
  if (error) return fail(toDataError(error));
  const mine = new Set(assigned);
  return ok(
    (data as unknown as Row[]).map((r) => {
      const projectKey = r.project?.project_key ?? "";
      const roles: MyWorkRole[] = [];
      if (r.owner_party_id === input.personId) roles.push("owner");
      if (r.accountable_party_id === input.personId) roles.push("accountable");
      if (mine.has(r.id)) roles.push("assigned");
      return {
        id: r.id,
        key: `${projectKey}-${r.record_number}`,
        title: r.title,
        kind: r.record_kind,
        state: r.record_state,
        dueAt: r.due_at,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        projectKey,
        projectName: r.project?.name ?? "",
        updatedAt: r.updated_at,
        roles,
        ownerId: r.owner_party_id,
      };
    }),
  );
}

/** Milliseconds a time zone is ahead of UTC at an instant. */
function zoneOffset(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant the calendar day containing `at` starts in a time zone. */
function startOfZonedDay(at: Date, timeZone: string): Date {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const guess = new Date(`${day}T00:00:00Z`);
  const first = new Date(guess.getTime() - zoneOffset(guess, timeZone));
  // Across a daylight saving change the offset at midnight can differ from the guess's.
  return new Date(guess.getTime() - zoneOffset(first, timeZone));
}

/** The person's today in their time zone, as [start, end). */
export function dayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  const start = startOfZonedDay(now, timeZone);
  const end = startOfZonedDay(new Date(start.getTime() + 36 * 3_600_000), timeZone);
  return { start, end };
}

/**
 * When a record is due: its due time, else the end of its window. Past due is overdue; due before
 * the person's day ends, or under way by then with no due time, is today; later is upcoming; no date is undated.
 */
export function dueState(
  record: Pick<MyWorkRecord, "dueAt" | "startsAt" | "endsAt">,
  now: Date,
  day: { start: Date; end: Date },
): DueState {
  const due = record.dueAt ?? record.endsAt;
  const at = now.toISOString();
  const end = day.end.toISOString();
  if (due !== null && due < at) return "overdue";
  if (due !== null && due < end) return "today";
  if (record.startsAt !== null && record.startsAt < end) return "today";
  if (due !== null || record.startsAt !== null) return "upcoming";
  return "undated";
}

/** Records grouped by due state in the order overdue, today, upcoming, undated; empty groups kept. */
export function groupByDueState(
  records: readonly MyWorkRecord[],
  now: Date,
  timeZone: string,
): { state: DueState; records: MyWorkRecord[] }[] {
  const day = dayBounds(now, timeZone);
  const groups = new Map<DueState, MyWorkRecord[]>(DUE_STATES.map((s) => [s, []]));
  for (const r of records) groups.get(dueState(r, now, day))?.push(r);
  return DUE_STATES.map((state) => ({ state, records: groups.get(state) ?? [] }));
}
