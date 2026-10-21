import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  calendarFeedName,
  calendarFeedResponse,
  calendarFeedUrl,
  createCalendarFeed,
  createPersonCalendarFeed,
  feedEvents,
  feedTokenFromFile,
  listMyCalendarFeeds,
  listMyPersonCalendarFeeds,
  parseCalendarFeedDocument,
  revokeCalendarFeed,
  revokePersonCalendarFeed,
  rotateCalendarFeed,
  rotatePersonCalendarFeed,
  webcalUrl,
  type FeedMeta,
} from "../src/calendar-feeds.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** Builds a feed token at run time, so no realistic secret sits in the source. */
const token = (digit: string) => `xcal_${digit.repeat(64)}`;

const EVENT = {
  id: "0192a000-0000-7000-8000-00000000000a",
  kind: "shift",
  title: "Stagehand",
  starts_at: "2027-06-01T12:00:00+00:00",
  ends_at: "2027-06-01T20:00:00+00:00",
  time_zone: "America/New_York",
  status: "confirmed",
  sequence: 3,
  created_at: "2026-10-01T12:00:00+00:00",
  updated_at: "2026-10-01T12:00:03+00:00",
  org_name: null,
  project_name: "Northwind Summer Series",
  project_key: "NWL",
  record_key: null,
  scope_node_name: "Main Stage",
};

const MILESTONE = {
  ...EVENT,
  id: "0192a000-0000-7000-8000-00000000000b",
  kind: "milestone",
  title: "Stage rigging signed off",
  ends_at: null,
  status: "cancelled",
  record_key: "NWL-12",
  scope_node_name: null,
};

const FEED = {
  scope: "member",
  org_name: "Northwind Live",
  org_slug: "northwind",
  project_name: null,
  project_key: null,
  time_zone: "America/New_York",
  locale: "en-US",
};

/** A client whose api_public.calendar_feed answers one queued result and records its arguments. */
function publicClient(answer: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown>[] = [];
  const db = {
    schema(name: string) {
      expect(name).toBe("api_public");
      return {
        rpc(fn: string, args: Record<string, unknown>) {
          expect(fn).toBe("calendar_feed");
          calls.push(args);
          return Promise.resolve(answer);
        },
      };
    },
  } as unknown as XosClient;
  return { db, calls };
}

const request = (db: XosClient, file: string, extra: Record<string, unknown> = {}) =>
  calendarFeedResponse({
    db,
    feedFile: file,
    clientAddress: "198.51.100.7",
    links: { atlasOrigin: "https://atlas.example.test/", gatewayOrigin: null },
    calendarName: (feed: FeedMeta) => `My schedule at ${feed.orgName ?? ""}`,
    ...extra,
  });

describe("feed tokens and links", () => {
  it("reads only <token>.ics", () => {
    expect(feedTokenFromFile(`${token("a")}.ics`)).toBe(token("a"));
    expect(feedTokenFromFile(token("a"))).toBeNull();
    expect(feedTokenFromFile(`${token("a")}.ical`)).toBeNull();
    expect(feedTokenFromFile(`${token("A")}.ics`)).toBeNull();
    expect(feedTokenFromFile("xcal_short.ics")).toBeNull();
  });

  it("builds https and webcal subscription links", () => {
    const url = calendarFeedUrl("https://atlas.example.test/", token("b"));
    expect(url).toBe(`https://atlas.example.test/ical/${token("b")}.ics`);
    expect(webcalUrl(url)).toBe(`webcal://atlas.example.test/ical/${token("b")}.ics`);
  });
});

describe("calendarFeedResponse", () => {
  it("serves a live feed as a calendar, passing the relayed client address", async () => {
    const { db, calls } = publicClient({
      data: { status: "ok", feed: FEED, events: [EVENT, MILESTONE] },
      error: null,
    });
    const response = await request(db, `${token("c")}.ics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(calls).toEqual([{ p_token: token("c"), p_client_address: "198.51.100.7" }]);
    const body = await response.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("X-WR-CALNAME:My schedule at Northwind Live");
    expect(body).toContain("SUMMARY:Stagehand · Northwind Summer Series");
    expect(body).toContain("STATUS:CANCELLED");
    expect(body).toContain("URL:https://atlas.example.test/northwind/r/NWL-12");
    expect(body).toContain("DTSTART;TZID=America/New_York:20270601T080000");
    expect(body).not.toContain(token("c"));
  });

  it("answers 304 when the calendar has not changed", async () => {
    const answer = { data: { status: "ok", feed: FEED, events: [EVENT] }, error: null };
    const first = await request(publicClient(answer).db, `${token("c")}.ics`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await request(publicClient(answer).db, `${token("c")}.ics`, {
      ifNoneMatch: `W/${etag}`,
    });
    expect(again.status).toBe(304);
  });

  it("answers 404 for a malformed token without asking the database", async () => {
    const { db, calls } = publicClient({ data: null, error: null });
    expect((await request(db, "../etc/passwd")).status).toBe(404);
    expect((await request(db, `${token("d")}`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("answers 404 for an unknown, rotated or revoked token", async () => {
    const { db } = publicClient({ data: { status: "not_found" }, error: null });
    const response = await request(db, `${token("e")}.ics`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("answers 429 with Retry-After past a limit", async () => {
    const { db } = publicClient({
      data: { status: "rate_limited", retry_after_seconds: 900 },
      error: null,
    });
    const response = await request(db, `${token("f")}.ics`);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
  });

  it("answers 503 when the database cannot answer, and logs no token", async () => {
    const logged: string[] = [];
    const failing = publicClient({ data: null, error: { code: "PGRST000", message: "down" } });
    const response = await request(failing.db, `${token("1")}.ics`, {
      onError: (m: string) => logged.push(m),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("300");
    const unreadable = publicClient({ data: { status: "ok" }, error: null });
    expect(
      (
        await request(unreadable.db, `${token("2")}.ics`, {
          onError: (m: string) => logged.push(m),
        })
      ).status,
    ).toBe(503);
    const denied = publicClient({ data: null, error: { code: "42501", message: "no" } });
    expect(
      (await request(denied.db, `${token("3")}.ics`, { onError: (m: string) => logged.push(m) }))
        .status,
    ).toBe(503);
    expect(logged).toHaveLength(3);
    expect(logged.join(" ")).not.toContain("xcal_");
  });
});

describe("feed documents", () => {
  it("keeps the database's all-day dates and writes them as DATE values", async () => {
    const allDay = {
      ...MILESTONE,
      id: "0192a000-0000-7000-8000-00000000000c",
      starts_at: "2027-06-01T04:00:00+00:00",
      status: "confirmed",
      all_day: true,
      start_date: "2027-06-01",
      end_date: "2027-06-02",
    };
    const parsed = parseCalendarFeedDocument({ status: "ok", feed: FEED, events: [allDay, EVENT] });
    if (parsed?.status !== "ok") throw new Error("parse");
    expect(parsed.events.map((e) => e.allDay)).toEqual([
      { start: "2027-06-01", end: "2027-06-02" },
      null,
    ]);
    const odd = parseCalendarFeedDocument({
      status: "ok",
      feed: FEED,
      events: [{ ...allDay, end_date: "June 2" }],
    });
    expect(odd?.status === "ok" && odd.events[0]?.allDay).toBeNull();
    const { db } = publicClient({
      data: { status: "ok", feed: FEED, events: [allDay] },
      error: null,
    });
    const body = await (await request(db, `${token("9")}.ics`)).text();
    expect(body).toContain("DTSTART;VALUE=DATE:20270601\r\nDTEND;VALUE=DATE:20270602");
  });

  it("refuses shapes it does not expect and skips unreadable events", () => {
    expect(parseCalendarFeedDocument(null)).toBeNull();
    expect(parseCalendarFeedDocument({ status: "maybe" })).toBeNull();
    expect(
      parseCalendarFeedDocument({ status: "ok", feed: { scope: "team" }, events: [] }),
    ).toBeNull();
    expect(parseCalendarFeedDocument({ status: "rate_limited" })).toEqual({
      status: "rate_limited",
      retryAfterSeconds: 900,
    });
    const doc = parseCalendarFeedDocument({
      status: "ok",
      feed: { scope: "person" },
      events: [
        EVENT,
        { ...EVENT, kind: "party" },
        { ...EVENT, status: "maybe" },
        { ...EVENT, starts_at: null },
      ],
    });
    expect(doc?.status === "ok" && doc.events.length).toBe(1);
    expect(doc?.status === "ok" && doc.feed.timeZone).toBe("UTC");
  });

  it("links each scope where its owner works", () => {
    const parsed = parseCalendarFeedDocument({ status: "ok", feed: FEED, events: [EVENT] });
    if (parsed?.status !== "ok") throw new Error("parse");
    const links = {
      atlasOrigin: "https://atlas.example.test",
      gatewayOrigin: "https://gateway.example.test",
    };
    const shift = parsed.events[0];
    if (!shift) throw new Error("event");
    expect(feedEvents(parsed.feed, [shift], links)[0]?.url).toBe(
      "https://atlas.example.test/northwind/my-work",
    );
    const project = {
      ...parsed.feed,
      scope: "project" as const,
      projectKey: "NWL",
      projectName: "Northwind Summer Series",
    };
    const inProject = feedEvents(project, [shift], links)[0];
    expect(inProject?.url).toBe("https://atlas.example.test/northwind/p/NWL/schedule");
    expect(inProject?.summary).toBe("Stagehand");
    const person = { ...parsed.feed, scope: "person" as const, orgSlug: null };
    expect(feedEvents(person, [{ ...shift, orgName: "Northwind Live" }], links)[0]).toMatchObject({
      url: "https://gateway.example.test/work/upcoming",
      description: "Northwind Live\nNorthwind Summer Series\nMain Stage",
    });
    expect(feedEvents(person, [shift], {})[0]?.url).toBeNull();
    expect(feedEvents(parsed.feed, [{ ...shift, title: "" }], {})[0]).toMatchObject({
      summary: "Northwind Summer Series",
      url: null,
    });
  });
});

describe("calendarFeedName", () => {
  const t = (key: string, values: Record<string, string>) => `${key}:${JSON.stringify(values)}`;
  const meta = (scope: FeedMeta["scope"]): FeedMeta => ({
    scope,
    orgName: "Northwind Live",
    orgSlug: "northwind",
    projectName: "Northwind Summer Series",
    projectKey: "NWL",
    timeZone: "UTC",
    locale: "en-US",
  });
  it("names each scope", () => {
    expect(calendarFeedName(meta("member"), t)).toBe('member:{"org":"Northwind Live"}');
    expect(calendarFeedName(meta("project"), t)).toBe(
      'project:{"project":"Northwind Summer Series","org":"Northwind Live"}',
    );
    expect(calendarFeedName(meta("person"), t)).toBe("person:{}");
  });
});

describe("feed repository", () => {
  it("lists the member's live feeds with their projects", async () => {
    const { db, calls } = fakeClient({
      "from:calendar_feeds": [
        okResponse([
          {
            id: "f1",
            project_id: "p1",
            token_hint: "a1b2",
            created_at: "2026-10-20T10:00:00Z",
            rotated_at: null,
            last_accessed_at: null,
          },
          {
            id: "f2",
            project_id: null,
            token_hint: "c3d4",
            created_at: "2026-10-19T10:00:00Z",
            rotated_at: "2026-10-20T09:00:00Z",
            last_accessed_at: "2026-10-20T09:30:00Z",
          },
        ]),
      ],
      "from:projects": [
        okResponse([{ id: "p1", name: "Northwind Summer Series", project_key: "NWL" }]),
      ],
    });
    const result = await listMyCalendarFeeds(db, "org-1");
    expect(result.ok && result.data.map((f) => [f.id, f.projectKey, f.tokenHint])).toEqual([
      ["f1", "NWL", "a1b2"],
      ["f2", null, "c3d4"],
    ]);
    expect(calls[0]?.steps).toContainEqual(["is", ["revoked_at", null]]);
  });

  it("creates, rotates and revokes member feeds", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_calendar_feed": [
        okResponse([{ calendar_feed_id: "f1", feed_token: token("4") }]),
        okResponse([{ calendar_feed_id: "f2", feed_token: token("5") }]),
        okResponse([]),
      ],
      "rpc:rotate_calendar_feed": [errorResponse("42501", "calendar feed not found")],
      "from:calendar_feeds": [okResponse([{ id: "f1" }]), okResponse([])],
    });
    expect(await createCalendarFeed(db, "org-1", null)).toEqual({
      ok: true,
      data: { id: "f1", token: token("4") },
    });
    await createCalendarFeed(db, "org-1", "p1");
    expect(calls[1]?.steps[0]).toEqual(["args", [{ p_org_id: "org-1", p_project_id: "p1" }]]);
    expect((await createCalendarFeed(db, "org-1", null)).ok).toBe(false);
    expect(await rotateCalendarFeed(db, "f9")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await revokeCalendarFeed(db, "f1")).toEqual({ ok: true, data: undefined });
    expect(await revokeCalendarFeed(db, "f1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("creates, lists, rotates and revokes person feeds", async () => {
    const { db } = fakeClient({
      "rpc:create_person_calendar_feed": [
        okResponse([{ calendar_feed_id: "g1", feed_token: token("6") }]),
      ],
      "rpc:rotate_person_calendar_feed": [
        okResponse([{ calendar_feed_id: "g1", feed_token: token("7") }]),
      ],
      "from:person_calendar_feeds": [
        okResponse([
          {
            id: "g1",
            token_hint: "7777",
            created_at: "2026-10-20T10:00:00Z",
            rotated_at: null,
            last_accessed_at: null,
          },
        ]),
        okResponse([{ id: "g1" }]),
        errorResponse("PGRST000", "down"),
      ],
    });
    expect((await createPersonCalendarFeed(db)).ok).toBe(true);
    expect(await rotatePersonCalendarFeed(db, "g1")).toEqual({
      ok: true,
      data: { id: "g1", token: token("7") },
    });
    const list = await listMyPersonCalendarFeeds(db);
    expect(list.ok && list.data[0]?.tokenHint).toBe("7777");
    expect((await revokePersonCalendarFeed(db, "g1")).ok).toBe(true);
    expect((await revokePersonCalendarFeed(db, "g1")).ok).toBe(false);
  });
});
