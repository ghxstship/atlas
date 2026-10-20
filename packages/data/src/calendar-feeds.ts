import type { XosClient } from "./client.ts";
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

export interface CalendarFeedSummary {
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

async function tokenCall(
  db: XosClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Result<NewFeedToken>> {
  const { data, error } = await (
    db as unknown as {
      rpc(
        f: string,
        a: Record<string, unknown>,
      ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
    }
  ).rpc(fn, args);
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
    .select("id, project_id, token_hint, created_at, rotated_at, last_accessed_at")
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
  return ok(
    data.map((f) => ({
      id: f.id,
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

/** Creates a feed of the member's own schedule, or of one project they can read. */
export function createCalendarFeed(
  db: XosClient,
  orgId: string,
  projectId: string | null,
): Promise<Result<NewFeedToken>> {
  return tokenCall(db, "create_calendar_feed", {
    p_org_id: orgId,
    ...(projectId === null ? {} : { p_project_id: projectId }),
  });
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
    .select("id, token_hint, created_at, rotated_at, last_accessed_at")
    .is("revoked_at", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((f) => ({
      id: f.id,
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

export function createPersonCalendarFeed(db: XosClient): Promise<Result<NewFeedToken>> {
  return tokenCall(db, "create_person_calendar_feed", {});
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
}

export interface FeedEvent {
  readonly id: string;
  readonly kind: "shift" | "meeting" | "milestone" | "deadline";
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
}

export type CalendarFeedDocument =
  | { readonly status: "ok"; readonly feed: FeedMeta; readonly events: readonly FeedEvent[] }
  | { readonly status: "not_found" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const KINDS = new Set(["shift", "meeting", "milestone", "deadline"]);
const STATUSES = new Set(["tentative", "confirmed", "cancelled"]);
const SCOPES = new Set(["member", "project", "person"]);

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
        : e.title;
    const description = [e.orgName, project, e.scopeNodeName, e.recordKey]
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
    };
  });
}

/**
 * The calendar's display name from the `platform.calendarFeeds.feed` messages (member, project,
 * person), in the feed owner's language.
 */
export function calendarFeedName(
  feed: FeedMeta,
  t: (key: FeedScope, values: Record<string, string>) => string,
): string {
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
