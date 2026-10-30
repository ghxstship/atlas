import type { XosClient } from "./client.ts";
import type { CueCallKind } from "./cue-calls.ts";
import { writeICalendar, type ICalEvent, type ICalEventStatus } from "./ical.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Calendar feeds (Section 4.6.5, migrations 0550 and 1410, ADR 0040).
 *
 * - Member and project feeds (Atlas, Personal settings, Calendar Feeds) belong to an org
 *   membership; a person feed (Gateway, Settings, Calendar Feeds) belongs to the person and covers
 *   every org they work with through an engagement.
 * - A token is shown once, when the feed is created or rotated; only its hash is stored. Rotating
 *   replaces the token in place and revoking ends the feed for good.
 * - `calendarFeedResponse` answers `/ical/{token}.ics` for both apps: it calls the
 *   `api_public.calendar_feed` token RPC as anon, with the client address the platform's proxy
 *   reported, and writes RFC 5545 through ./ical.ts.
 * - A feed has a name, saved content sources (cues included) and, on a project feed, an audience
 *   of people, one team or one department and a show department (B7, migrations 2960 to 2962,
 *   ADR 0146). Null sources serve the 4.0 set; the database refuses every bad configuration.
 */

/** A feed token: `xcal_` and 256 random bits in hex. */
export const FEED_TOKEN = /^xcal_[0-9a-f]{64}$/;

/** The token of a feed file name (`<token>.ics`), or null when the name is anything else. */
export function feedTokenFromFile(file: string): string | null {
  const match = /^(xcal_[0-9a-f]{64})\.ics$/.exec(file);
  return match ? (match[1] as string) : null;
}

/** The subscription URL of a feed on an app's origin. */
export function calendarFeedUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/ical/${token}.ics`;
}

/** The same URL with the webcal scheme, which opens the device's calendar app. */
export function webcalUrl(url: string): string {
  return url.replace(/^https?:/, "webcal:");
}

/** What a feed serves (app.calendar_feed_source). */
export const CALENDAR_FEED_SOURCES = [
  "Shifts",
  "Meetings",
  "Milestones",
  "Deadlines",
  "Cues",
] as const;
export type CalendarFeedSource = (typeof CALENDAR_FEED_SOURCES)[number];

/** The sources a feed without saved sources serves: the 4.0 set. */
export const DEFAULT_FEED_SOURCES: readonly CalendarFeedSource[] = [
  "Shifts",
  "Meetings",
  "Milestones",
  "Deadlines",
];

/** A project feed's audience: named people, one team or one canon department. */
export type FeedAudience =
  | { readonly kind: "people"; readonly personIds: readonly string[] }
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "department"; readonly departmentCode: string };

/** A feed's saved configuration. A member feed takes only a name and sources without Cues. */
export interface FeedConfiguration {
  /** Null uses the default name. */
  readonly name: string | null;
  /** Null serves the default set. */
  readonly sources: readonly CalendarFeedSource[] | null;
  readonly audience: FeedAudience | null;
  /** Only cues with this department's call, and its instruction. */
  readonly cueCallKind: CueCallKind | null;
}

export const EMPTY_FEED_CONFIGURATION: FeedConfiguration = {
  name: null,
  sources: null,
  audience: null,
  cueCallKind: null,
};

/** The refusal rules of the feed RPCs, each with its own copy in Atlas, Gateway and Compass. */
export const CALENDAR_FEED_RULES = [
  "calendar_feed_limit",
  "calendar_feed_name",
  "calendar_feed_filter_scope",
  "calendar_feed_audience",
  "calendar_feed_people_limit",
  "calendar_feed_sources",
] as const;

/** The most people a feed's audience may hold (2961). */
export const MAX_FEED_PEOPLE = 50;

export interface CalendarFeedSummary extends FeedConfiguration {
  readonly id: string;
  /** Null for the member's own schedule. */
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly projectKey: string | null;
  readonly tokenHint: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly lastAccessedAt: string | null;
}

const SOURCE_SET = new Set<string>(CALENDAR_FEED_SOURCES);

function sourcesOf(value: unknown): CalendarFeedSource[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter(
    (v): v is CalendarFeedSource => typeof v === "string" && SOURCE_SET.has(v),
  );
  return list.length > 0 ? list : null;
}

/** The RPC arguments of a configuration (2961): null where nothing is set. */
export function configurationArgs(config: FeedConfiguration): Record<string, unknown> {
  const audience = config.audience;
  const name = config.name?.trim() ?? "";
  return {
    p_name: name === "" ? null : name,
    p_sources: config.sources === null ? null : [...config.sources],
    p_person_ids: audience?.kind === "people" ? [...audience.personIds] : null,
    p_team_id: audience?.kind === "team" ? audience.teamId : null,
    p_department_code: audience?.kind === "department" ? audience.departmentCode : null,
    p_cue_call_kind: config.cueCallKind,
  };
}

export interface NewFeedToken {
  readonly id: string;
  /** Shown once; never stored. */
  readonly token: string;
}

function tokenRow(data: unknown): NewFeedToken | null {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  const id = row?.["calendar_feed_id"];
  const token = row?.["feed_token"];
  return typeof id === "string" && typeof token === "string" && FEED_TOKEN.test(token)
    ? { id, token }
    : null;
}

function rpcOf(db: XosClient) {
  return db as unknown as {
    rpc(
      f: string,
      a: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
  };
}

async function tokenCall(
  db: XosClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Result<NewFeedToken>> {
  const { data, error } = await rpcOf(db).rpc(fn, args);
  if (error) return fail(toDataError(error));
  const row = tokenRow(data);
  return row ? ok(row) : fail({ kind: "unexpected", message: `${fn} returned no token` });
}

// Member and project feeds (Atlas) -------------------------------------------------------------------

/** The signed-in member's live feeds in an org, newest first. */
export async function listMyCalendarFeeds(
  db: XosClient,
  orgId: string,
): Promise<Result<CalendarFeedSummary[]>> {
  const { data, error } = await db
    .from("calendar_feeds")
    .select(
      "id, project_id, token_hint, created_at, rotated_at, last_accessed_at, name, sources, team_id, department_code, cue_call_kind",
    )
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  const projectIds = [...new Set(data.flatMap((f) => (f.project_id ? [f.project_id] : [])))];
  const projects = new Map<string, { name: string; key: string }>();
  if (projectIds.length > 0) {
    const read = await db.from("projects").select("id, name, project_key").in("id", projectIds);
    if (read.error) return fail(toDataError(read.error));
    for (const p of read.data) projects.set(p.id, { name: p.name, key: p.project_key });
  }
  // A people audience is kept as memberships of the org (2960); read back as their people.
  const feedIds = data
    .filter((f) => f.project_id && !f.team_id && !f.department_code)
    .map((f) => f.id);
  const people = new Map<string, string[]>();
  if (feedIds.length > 0) {
    const read = await db
      .from("calendar_feed_members")
      .select("calendar_feed_id, membership:memberships!inner(person_id)")
      .in("calendar_feed_id", feedIds)
      .is("deleted_at", null);
    if (read.error) return fail(toDataError(read.error));
    for (const row of read.data as unknown as {
      calendar_feed_id: string;
      membership: { person_id: string } | null;
    }[]) {
      if (!row.membership) continue;
      people.set(row.calendar_feed_id, [
        ...(people.get(row.calendar_feed_id) ?? []),
        row.membership.person_id,
      ]);
    }
  }
  return ok(
    data.map((f) => ({
      id: f.id,
      name: f.name ?? null,
      sources: sourcesOf(f.sources),
      audience: f.team_id
        ? { kind: "team" as const, teamId: f.team_id }
        : f.department_code
          ? { kind: "department" as const, departmentCode: f.department_code }
          : people.has(f.id)
            ? { kind: "people" as const, personIds: people.get(f.id) ?? [] }
            : null,
      cueCallKind: (f.cue_call_kind as CueCallKind | null) ?? null,
      projectId: f.project_id,
      projectName: f.project_id ? (projects.get(f.project_id)?.name ?? null) : null,
      projectKey: f.project_id ? (projects.get(f.project_id)?.key ?? null) : null,
      tokenHint: f.token_hint,
      createdAt: f.created_at,
      rotatedAt: f.rotated_at,
      lastAccessedAt: f.last_accessed_at,
    })),
  );
}

/**
 * Creates a feed of the member's own schedule, or of one project they can read, with an optional
 * configuration saved in the same call. Without one it is a 4.0 feed.
 */
export function createCalendarFeed(
  db: XosClient,
  orgId: string,
  projectId: string | null,
  config?: FeedConfiguration,
): Promise<Result<NewFeedToken>> {
  return tokenCall(db, "create_calendar_feed", {
    p_org_id: orgId,
    ...(projectId === null ? {} : { p_project_id: projectId }),
    ...(config === undefined ? {} : configurationArgs(config)),
  });
}

/** Replaces the configuration of one of the member's live feeds; its link stays. */
export async function configureCalendarFeed(
  db: XosClient,
  id: string,
  config: FeedConfiguration,
): Promise<Result<void>> {
  const { error } = await rpcOf(db).rpc("configure_calendar_feed", {
    p_calendar_feed_id: id,
    ...configurationArgs(config),
  });
  return error ? fail(toDataError(error)) : ok(undefined);
}

/** Issues a new token for one of the member's feeds; the old link stops at once. */
export function rotateCalendarFeed(db: XosClient, id: string): Promise<Result<NewFeedToken>> {
  return tokenCall(db, "rotate_calendar_feed", { p_calendar_feed_id: id });
}

/** Revokes one of the member's feeds for good. */
export async function revokeCalendarFeed(db: XosClient, id: string): Promise<Result<void>> {
  const { data, error } = await db
    .from("calendar_feeds")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(undefined) : fail({ kind: "not-found" });
}

// Person feeds (Gateway) -------------------------------------------------------------------------------

/** The signed-in person's own live feeds, newest first. */
export async function listMyPersonCalendarFeeds(
  db: XosClient,
): Promise<Result<CalendarFeedSummary[]>> {
  const { data, error } = await db
    .from("person_calendar_feeds")
    .select("id, token_hint, created_at, rotated_at, last_accessed_at, name, sources")
    .is("revoked_at", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((f) => ({
      id: f.id,
      name: f.name ?? null,
      sources: sourcesOf(f.sources),
      audience: null,
      cueCallKind: null,
      projectId: null,
      projectName: null,
      projectKey: null,
      tokenHint: f.token_hint,
      createdAt: f.created_at,
      rotatedAt: f.rotated_at,
      lastAccessedAt: f.last_accessed_at,
    })),
  );
}

/** A person feed's configuration: a name and sources only. */
export type PersonFeedConfiguration = Pick<FeedConfiguration, "name" | "sources">;

function personArgs(config: PersonFeedConfiguration): Record<string, unknown> {
  const name = config.name?.trim() ?? "";
  return {
    p_name: name === "" ? null : name,
    p_sources: config.sources === null ? null : [...config.sources],
  };
}

export function createPersonCalendarFeed(
  db: XosClient,
  config?: PersonFeedConfiguration,
): Promise<Result<NewFeedToken>> {
  return tokenCall(
    db,
    "create_person_calendar_feed",
    config === undefined ? {} : personArgs(config),
  );
}

/** Replaces the name and sources of one of the person's own live feeds; its link stays. */
export async function configurePersonCalendarFeed(
  db: XosClient,
  id: string,
  config: PersonFeedConfiguration,
): Promise<Result<void>> {
  const { error } = await rpcOf(db).rpc("configure_person_calendar_feed", {
    p_calendar_feed_id: id,
    ...personArgs(config),
  });
  return error ? fail(toDataError(error)) : ok(undefined);
}

export function rotatePersonCalendarFeed(db: XosClient, id: string): Promise<Result<NewFeedToken>> {
  return tokenCall(db, "rotate_person_calendar_feed", { p_calendar_feed_id: id });
}

export async function revokePersonCalendarFeed(db: XosClient, id: string): Promise<Result<void>> {
  const { data, error } = await db
    .from("person_calendar_feeds")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(undefined) : fail({ kind: "not-found" });
}

// Serving ------------------------------------------------------------------------------------------------

export type FeedScope = "member" | "project" | "person";

export interface FeedMeta {
  readonly scope: FeedScope;
  readonly orgName: string | null;
  readonly orgSlug: string | null;
  readonly projectName: string | null;
  readonly projectKey: string | null;
  readonly timeZone: string;
  readonly locale: string;
  /** The name the owner gave the feed, or null for the default name. */
  readonly name: string | null;
}

export interface FeedEvent {
  readonly id: string;
  readonly kind: "shift" | "meeting" | "milestone" | "deadline" | "cue";
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly timeZone: string | null;
  readonly status: ICalEventStatus;
  readonly sequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly orgName: string | null;
  readonly projectName: string | null;
  readonly projectKey: string | null;
  readonly recordKey: string | null;
  readonly scopeNodeName: string | null;
  /** All-day dates on the place's calendar (the project's zone, A71), or null for a timed event. */
  readonly allDay: { readonly start: string; readonly end: string } | null;
  /** A cue's run of show; null for every other kind. */
  readonly runId: string | null;
  readonly runName: string | null;
  /** The filtered show department's call on a cue. */
  readonly callInstruction: string | null;
}

export type CalendarFeedDocument =
  | { readonly status: "ok"; readonly feed: FeedMeta; readonly events: readonly FeedEvent[] }
  | { readonly status: "not_found" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const KINDS = new Set(["shift", "meeting", "milestone", "deadline", "cue"]);
const STATUSES = new Set(["tentative", "confirmed", "cancelled"]);
const SCOPES = new Set(["member", "project", "person"]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The all-day dates of an event the database marked all day, when both are calendar dates. */
function allDayOf(e: Record<string, unknown>): FeedEvent["allDay"] {
  const start = str(e["start_date"]);
  const end = str(e["end_date"]);
  return e["all_day"] === true && start && end && DAY.test(start) && DAY.test(end)
    ? { start, end }
    : null;
}

/** Reads the token RPC's JSON document, refusing any shape it does not expect. */
export function parseCalendarFeedDocument(value: unknown): CalendarFeedDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Record<string, unknown>;
  if (doc["status"] === "not_found") return { status: "not_found" };
  if (doc["status"] === "rate_limited") {
    const retry = Number(doc["retry_after_seconds"]);
    return {
      status: "rate_limited",
      retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : 900,
    };
  }
  if (doc["status"] !== "ok") return null;
  const feed = doc["feed"] as Record<string, unknown> | null;
  const scope = str(feed?.["scope"]);
  if (!feed || scope === null || !SCOPES.has(scope) || !Array.isArray(doc["events"])) return null;
  const events: FeedEvent[] = [];
  for (const raw of doc["events"] as unknown[]) {
    const e = raw as Record<string, unknown>;
    const id = str(e["id"]);
    const kind = str(e["kind"]);
    const status = str(e["status"]);
    const startsAt = str(e["starts_at"]);
    const createdAt = str(e["created_at"]);
    const updatedAt = str(e["updated_at"]);
    if (!id || !kind || !KINDS.has(kind) || !status || !STATUSES.has(status)) continue;
    if (!startsAt || !createdAt || !updatedAt) continue;
    events.push({
      id,
      kind: kind as FeedEvent["kind"],
      title: str(e["title"]) ?? "",
      startsAt,
      endsAt: str(e["ends_at"]),
      timeZone: str(e["time_zone"]),
      status: status as ICalEventStatus,
      sequence: Number.isFinite(Number(e["sequence"])) ? Number(e["sequence"]) : 0,
      createdAt,
      updatedAt,
      orgName: str(e["org_name"]),
      projectName: str(e["project_name"]),
      projectKey: str(e["project_key"]),
      recordKey: str(e["record_key"]),
      scopeNodeName: str(e["scope_node_name"]),
      allDay: allDayOf(e),
      runId: str(e["run_id"]),
      runName: str(e["run_name"]),
      callInstruction: str(e["call_instruction"]),
    });
  }
  return {
    status: "ok",
    feed: {
      scope: scope as FeedScope,
      orgName: str(feed["org_name"]),
      orgSlug: str(feed["org_slug"]),
      projectName: str(feed["project_name"]),
      projectKey: str(feed["project_key"]),
      timeZone: str(feed["time_zone"]) ?? "UTC",
      locale: str(feed["locale"]) ?? "en-US",
      name: str(feed["name"]),
    },
    events,
  };
}

/** Calls the token RPC as anon. `clientAddress` is the address the platform's proxy reported. */
export async function fetchCalendarFeed(
  db: XosClient,
  token: string,
  clientAddress: string | null,
): Promise<Result<CalendarFeedDocument>> {
  const { data, error } = await (
    db as unknown as {
      schema(name: "api_public"): {
        rpc(
          f: string,
          a: Record<string, unknown>,
        ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
      };
    }
  )
    .schema("api_public")
    .rpc("calendar_feed", { p_token: token, p_client_address: clientAddress });
  if (error) return fail(toDataError(error));
  const parsed = parseCalendarFeedDocument(data);
  return parsed ? ok(parsed) : fail({ kind: "unexpected", message: "unreadable calendar feed" });
}

export interface FeedLinks {
  /** Atlas's public origin, for links to records and schedules. */
  readonly atlasOrigin?: string | null;
  /** Gateway's public origin, for a person feed's link to Upcoming. */
  readonly gatewayOrigin?: string | null;
}

function eventUrl(feed: FeedMeta, event: FeedEvent, links: FeedLinks): string | null {
  const atlas = links.atlasOrigin?.replace(/\/+$/, "");
  const gateway = links.gatewayOrigin?.replace(/\/+$/, "");
  if (feed.scope === "person") return gateway ? `${gateway}/work/upcoming` : null;
  if (!atlas || !feed.orgSlug) return null;
  if (event.kind === "cue" && event.runId && feed.scope === "project")
    return `${atlas}/${feed.orgSlug}/show/run-of-show?peek=${event.runId}`;
  if (event.recordKey) return `${atlas}/${feed.orgSlug}/r/${event.recordKey}`;
  if (feed.scope === "project" && feed.projectKey)
    return `${atlas}/${feed.orgSlug}/p/${feed.projectKey}/schedule`;
  return `${atlas}/${feed.orgSlug}/my-work`;
}

/** The iCalendar events of a feed document. */
export function feedEvents(feed: FeedMeta, events: readonly FeedEvent[], links: FeedLinks) {
  return events.map((e): ICalEvent => {
    const project = feed.scope === "project" ? null : e.projectName;
    const summary =
      e.kind === "shift"
        ? [e.title || e.projectName || "", project && e.title ? project : null]
            .filter((part): part is string => Boolean(part))
            .join(" · ")
        : e.kind === "cue"
          ? [e.runName ? `${e.runName} · ${e.title}` : e.title, project]
              .filter((part): part is string => Boolean(part))
              .join(" · ")
          : e.title;
    const description = [e.orgName, project, e.scopeNodeName, e.recordKey, e.callInstruction]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    return {
      id: e.id,
      summary,
      description: description === "" ? null : description,
      startsAt: new Date(e.startsAt),
      endsAt: e.endsAt === null ? null : new Date(e.endsAt),
      timeZone: e.timeZone ?? feed.timeZone,
      status: e.status,
      sequence: e.sequence,
      createdAt: new Date(e.createdAt),
      updatedAt: new Date(e.updatedAt),
      url: eventUrl(feed, e, links),
      transparent: e.kind === "milestone" || e.kind === "deadline",
      allDay: e.allDay,
    };
  });
}

/**
 * The calendar's display name: the name the owner gave the feed, else the default from the
 * `platform.calendarFeeds.feed` messages (member, project, person), in the feed owner's language.
 */
export function calendarFeedName(
  feed: FeedMeta,
  t: (key: FeedScope, values: Record<string, string>) => string,
): string {
  if (feed.name) return feed.name;
  const org = feed.orgName ?? "";
  if (feed.scope === "project") return t("project", { project: feed.projectName ?? "", org });
  if (feed.scope === "member") return t("member", { org });
  return t("person", {});
}

export interface CalendarFeedRequest {
  readonly db: XosClient;
  /** The route segment: `<token>.ics`. */
  readonly feedFile: string;
  /** The client address from clientAddress() (A69-003), or null when unknown. */
  readonly clientAddress: string | null;
  readonly links: FeedLinks;
  /** The calendar's display name, in the feed owner's language. */
  readonly calendarName: (feed: FeedMeta) => string;
  /** The request's If-None-Match header. */
  readonly ifNoneMatch?: string | null;
  /** Logs an unexpected failure; the token never reaches it. */
  readonly onError?: (message: string) => void;
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The answer to `GET /ical/{token}.ics`: 200 with the calendar, 304 when the client's copy is
 * current, 404 for a malformed, unknown, rotated-away or revoked token (never saying which), 429
 * with Retry-After past a limit, and 503 when the database cannot answer.
 */
export async function calendarFeedResponse(request: CalendarFeedRequest): Promise<Response> {
  const token = feedTokenFromFile(request.feedFile);
  if (token === null) return new Response(null, { status: 404, headers: BASE_HEADERS });
  const result = await fetchCalendarFeed(request.db, token, request.clientAddress);
  if (!result.ok) {
    request.onError?.(
      result.error.kind === "unexpected" || result.error.kind === "refusal"
        ? `calendar feed failed: ${result.error.message}`
        : `calendar feed failed: ${result.error.kind}`,
    );
    return new Response(null, {
      status: 503,
      headers: { ...BASE_HEADERS, "Retry-After": "300" },
    });
  }
  const doc = result.data;
  if (doc.status === "not_found") return new Response(null, { status: 404, headers: BASE_HEADERS });
  if (doc.status === "rate_limited") {
    return new Response(null, {
      status: 429,
      headers: { ...BASE_HEADERS, "Retry-After": String(doc.retryAfterSeconds) },
    });
  }
  const body = writeICalendar({
    name: request.calendarName(doc.feed),
    timeZone: doc.feed.timeZone,
    events: feedEvents(doc.feed, doc.events, request.links),
  });
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  const headers = { ...BASE_HEADERS, ETag: etag };
  if (request.ifNoneMatch?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="calendar.ics"',
    },
  });
}
