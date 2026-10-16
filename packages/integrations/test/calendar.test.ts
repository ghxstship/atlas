import { describe, expect, it } from "vitest";
import {
  calendarConnector,
  calendarConnectors,
  googleCalendarProvider,
  microsoftCalendarProvider,
  supabaseCalendarSource,
  utc,
  type CalendarItem,
  type CalendarSource,
  type CalendarTarget,
} from "../src/connectors/calendar/index.ts";
import { StoreError } from "../src/framework/db.ts";
import type { ExternalId } from "../src/framework/store.ts";
import { bodyOf, contextFor, memoryStore, okData, recordingDb, scriptedHttp } from "./doubles.ts";

const target = (overrides: Partial<CalendarTarget> = {}): CalendarTarget => ({
  id: "t-1",
  projectId: "prj",
  kind: "Meeting",
  externalCalendarId: "team@group.calendar.google.com",
  direction: "Two Way",
  conflictPolicy: "Latest Wins",
  ...overrides,
});

const meeting = (overrides: Partial<CalendarItem> = {}): CalendarItem => ({
  entity: "Record",
  localId: "rec-1",
  title: "Production Meeting",
  startsAt: "2027-06-01T14:00:00+00:00",
  endsAt: "2027-06-01T15:00:00+00:00",
  timeZone: "America/New_York",
  location: "Pier Office",
  conferencingUri: "https://meet.example.com/abc",
  canceled: false,
  updatedAt: "2027-05-30T10:00:00Z",
  ...overrides,
});

function calendarSource(items: CalendarItem[], targets: CalendarTarget[] = [target()]) {
  const applied: unknown[][] = [];
  const source: CalendarSource = {
    targets: async () => targets,
    items: async () => items,
    applyChange: async (...args) => {
      applied.push(args);
      return true;
    },
  };
  return { source, applied };
}

const run = { scope: "Calendar Sync" as const, direction: "Two Way" as const };

describe("calendar sync with Google Calendar", () => {
  it("creates events for new items and records version and hash", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://www.googleapis.com/calendar/v3/calendars/",
        respond: () => ({ json: { items: [], nextSyncToken: "sync-1" } }),
      },
      {
        match: "POST https://www.googleapis.com/calendar/v3/calendars/",
        respond: () => ({ json: { id: "g-1", etag: '"e1"' } }),
      },
    ]);
    const { store, externalIds } = memoryStore();
    const { source } = calendarSource([meeting(), meeting({ localId: "rec-2", canceled: true })]);
    const outcome = await calendarConnector(googleCalendarProvider, source).sync(
      contextFor("google_calendar", { http, store, run }),
    );
    expect(requests[0]?.url).toContain("timeMin=2027-06-30T12%3A00%3A00.000Z");
    expect(bodyOf(requests[1])).toEqual({
      summary: "Production Meeting",
      location: "Pier Office",
      description: "https://meet.example.com/abc",
      start: { dateTime: "2027-06-01T14:00:00.000Z", timeZone: "America/New_York" },
      end: { dateTime: "2027-06-01T15:00:00.000Z", timeZone: "America/New_York" },
      extendedProperties: { private: { xos_local_id: "rec-1" } },
    });
    expect(externalIds).toHaveLength(1);
    expect(externalIds[0]).toMatchObject({
      entity: "Record",
      localId: "rec-1",
      externalId: "g-1",
      externalVersion: '"e1"',
    });
    expect(outcome.counts).toEqual({ read: 2, written: 1, skipped: 1, failed: 0 });
    expect(JSON.parse(outcome.cursorAfter ?? "{}")).toEqual({ "t-1": "sync-1" });
  });

  it("skips unchanged items, updates changed ones and removes canceled ones", async () => {
    const first = memoryStore();
    const { source } = calendarSource([meeting()]);
    const setup = scriptedHttp([
      {
        match: "POST https://www.googleapis.com",
        respond: () => ({ json: { id: "g-1", etag: "e1" } }),
      },
    ]);
    await calendarConnector(googleCalendarProvider, source).sync(
      contextFor("google_calendar", {
        http: setup.http,
        store: first.store,
        run: { ...run, direction: "Outbound" },
      }),
    );
    const pair = first.externalIds[0] as ExternalId;

    const unchanged = scriptedHttp([]);
    const quiet = await calendarConnector(googleCalendarProvider, source).sync(
      contextFor("google_calendar", {
        http: unchanged.http,
        store: memoryStore([pair]).store,
        run: { ...run, direction: "Outbound" },
      }),
    );
    expect(unchanged.requests).toHaveLength(0);
    expect(quiet.counts.skipped).toBe(1);

    const moved = calendarSource([meeting({ title: "Production Meeting Two" })]);
    const update = scriptedHttp([
      {
        match:
          "PUT https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events/g-1",
        respond: () => ({ json: { id: "g-1", etag: "e2" } }),
      },
    ]);
    const updatedStore = memoryStore([pair]);
    await calendarConnector(googleCalendarProvider, moved.source).sync(
      contextFor("google_calendar", {
        http: update.http,
        store: updatedStore.store,
        run: { ...run, direction: "Outbound" },
      }),
    );
    expect(updatedStore.externalIds[0]?.externalVersion).toBe("e2");

    const canceled = calendarSource([meeting({ canceled: true })]);
    const remove = scriptedHttp([
      { match: "DELETE https://www.googleapis.com", respond: () => ({ status: 410 }) },
    ]);
    const removedStore = memoryStore([pair]);
    const removal = await calendarConnector(googleCalendarProvider, canceled.source).sync(
      contextFor("google_calendar", {
        http: remove.http,
        store: removedStore.store,
        run: { ...run, direction: "Outbound" },
      }),
    );
    expect(remove.requests[0]?.method).toBe("DELETE");
    expect(removal.counts.written).toBe(1);
    const again = await calendarConnector(googleCalendarProvider, canceled.source).sync(
      contextFor("google_calendar", {
        http: remove.http,
        store: removedStore.store,
        run: { ...run, direction: "Outbound" },
      }),
    );
    expect(again.counts.skipped).toBe(1);
  });

  it("places an item again when the provider event was deleted", async () => {
    const { http, requests } = scriptedHttp([
      { match: "PUT https://www.googleapis.com", respond: () => ({ status: 404 }) },
      {
        match: "POST https://www.googleapis.com",
        respond: () => ({ json: { id: "g-9", etag: "e9" } }),
      },
    ]);
    const { store, externalIds } = memoryStore([
      {
        entity: "Record",
        localId: "rec-1",
        externalId: "g-1",
        externalVersion: "e1",
        contentHash: "0".repeat(64),
      },
    ]);
    const { source } = calendarSource([meeting()]);
    await calendarConnector(googleCalendarProvider, source).sync(
      contextFor("google_calendar", { http, store, run: { ...run, direction: "Outbound" } }),
    );
    expect(requests.map((r) => r.method)).toEqual(["PUT", "POST"]);
    expect(externalIds[0]?.externalId).toBe("g-9");
    const failing = scriptedHttp([
      { match: "POST https://www.googleapis.com", respond: () => ({ status: 404 }) },
    ]);
    await expect(
      calendarConnector(googleCalendarProvider, source).sync(
        contextFor("google_calendar", {
          http: failing.http,
          store: memoryStore().store,
          run: { ...run, direction: "Outbound" },
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_not_found" });
    const deleteFails = scriptedHttp([
      { match: "DELETE https://www.googleapis.com", respond: () => ({ status: 500 }) },
    ]);
    const canceled = calendarSource([meeting({ canceled: true })]);
    await expect(
      calendarConnector(googleCalendarProvider, canceled.source).sync(
        contextFor("google_calendar", {
          http: deleteFails.http,
          store,
          run: { ...run, direction: "Outbound" },
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("applies provider time changes under the conflict policy", async () => {
    const synced = memoryStore();
    const base = calendarSource([meeting()]);
    const setup = scriptedHttp([
      {
        match: "POST https://www.googleapis.com",
        respond: () => ({ json: { id: "g-1", etag: "e1" } }),
      },
    ]);
    await calendarConnector(googleCalendarProvider, base.source).sync(
      contextFor("google_calendar", {
        http: setup.http,
        store: synced.store,
        run: { ...run, direction: "Outbound" },
      }),
    );
    const pair = synced.externalIds[0] as ExternalId;
    const feed = (events: unknown[]) =>
      scriptedHttp([
        {
          match: "GET https://www.googleapis.com",
          respond: (r) =>
            r.url.includes("pageToken=p2")
              ? { json: { items: events.slice(1), nextSyncToken: "sync-2" } }
              : { json: { items: events.slice(0, 1), nextPageToken: "p2" } },
        },
      ]);
    const movedEvent = {
      id: "g-1",
      etag: "e2",
      updated: "2027-05-31T09:00:00Z",
      start: { dateTime: "2027-06-01T16:00:00Z" },
      end: { dateTime: "2027-06-01T17:00:00Z" },
    };
    const noise = {
      id: "someone-else",
      etag: "x",
      start: { dateTime: "2027-06-01T16:00:00Z" },
      end: { dateTime: "2027-06-01T17:00:00Z" },
    };

    // Only the provider changed: applied.
    const a = calendarSource([meeting()]);
    const aStore = memoryStore([pair]);
    const aOut = await calendarConnector(googleCalendarProvider, a.source).sync(
      contextFor("google_calendar", {
        http: feed([noise, movedEvent]).http,
        store: aStore.store,
        run: { ...run, direction: "Inbound" },
        cursor: '{"t-1":"sync-1"}',
      }),
    );
    expect(a.applied).toEqual([
      ["conn-1", "Record", "rec-1", "2027-06-01T16:00:00.000Z", "2027-06-01T17:00:00.000Z", "e2"],
    ]);
    expect(aStore.externalIds[0]?.externalVersion).toBe("e2");
    expect(aOut).toEqual({
      counts: { read: 1, written: 1, skipped: 0, failed: 0 },
      cursorAfter: '{"t-1":"sync-2"}',
    });

    // Both changed, XOS edited later: Latest Wins keeps XOS, XOS Wins keeps XOS, Provider Wins applies.
    const edited = meeting({ title: "Renamed", updatedAt: "2027-06-01T00:00:00Z" });
    for (const [policy, expected] of [
      ["Latest Wins", 0],
      ["XOS Wins", 0],
      ["Provider Wins", 1],
    ] as const) {
      const s = calendarSource([edited], [target({ conflictPolicy: policy })]);
      await calendarConnector(googleCalendarProvider, s.source).sync(
        contextFor("google_calendar", {
          http: feed([movedEvent]).http,
          store: memoryStore([pair]).store,
          run: { ...run, direction: "Inbound" },
        }),
      );
      expect(s.applied).toHaveLength(expected);
    }

    // Our own write echoing back, a removal and an all-day event are skipped.
    const echo = { ...movedEvent, etag: "e1" };
    const removed = { id: "g-1", status: "cancelled", etag: "e5" };
    for (const event of [
      echo,
      removed,
      { id: "g-1", etag: "e6", start: { date: "2027-06-01" }, end: { date: "2027-06-02" } },
    ]) {
      const s = calendarSource([meeting()]);
      const out = await calendarConnector(googleCalendarProvider, s.source).sync(
        contextFor("google_calendar", {
          http: feed([event]).http,
          store: memoryStore([pair]).store,
          run: { ...run, direction: "Inbound" },
        }),
      );
      expect(s.applied).toHaveLength(0);
      expect(out.counts.skipped).toBe(1);
    }
    const same = calendarSource([meeting()]);
    const sameOut = await calendarConnector(googleCalendarProvider, same.source).sync(
      contextFor("google_calendar", {
        http: feed([
          {
            ...movedEvent,
            start: { dateTime: "2027-06-01T14:00:00Z" },
            end: { dateTime: "2027-06-01T15:00:00Z" },
          },
        ]).http,
        store: memoryStore([pair]).store,
        run: { ...run, direction: "Inbound" },
      }),
    );
    expect(sameOut.counts.skipped).toBe(1);
  });

  it("records a refused change and stops on other failures", async () => {
    const pair: ExternalId = {
      entity: "Record",
      localId: "rec-1",
      externalId: "g-1",
      externalVersion: "e1",
      contentHash: null,
    };
    const feed = scriptedHttp([
      {
        match: "GET https://www.googleapis.com",
        respond: () => ({
          json: {
            items: [
              {
                id: "g-1",
                etag: "e2",
                start: { dateTime: "2027-06-01T16:00:00Z" },
                end: { dateTime: "2027-06-01T17:00:00Z" },
              },
            ],
            nextSyncToken: "s",
          },
        }),
      },
    ]);
    const refusing: CalendarSource = {
      targets: async () => [target({ direction: "Inbound" })],
      items: async () => [meeting()],
      applyChange: () =>
        Promise.reject(
          new StoreError({ kind: "refusal", rule: "calendar_window_invalid", message: "No." }),
        ),
    };
    const { store, itemErrors } = memoryStore([pair]);
    const out = await calendarConnector(googleCalendarProvider, refusing).sync(
      contextFor("google_calendar", { http: feed.http, store, run }),
    );
    expect(itemErrors[0]).toMatchObject({
      code: "calendar_window_invalid",
      ref: { entity: "Record", localId: "rec-1", externalId: "g-1" },
    });
    expect(out.counts.failed).toBe(1);
    const broken: CalendarSource = {
      ...refusing,
      applyChange: () => Promise.reject(new Error("db down")),
    };
    await expect(
      calendarConnector(googleCalendarProvider, broken).sync(
        contextFor("google_calendar", { http: feed.http, store, run }),
      ),
    ).rejects.toThrow("db down");
  });

  it("restarts the feed when the sync token expired", async () => {
    let calls = 0;
    const { http } = scriptedHttp([
      {
        match: "GET https://www.googleapis.com",
        respond: (r) => {
          calls += 1;
          return r.url.includes("syncToken=old")
            ? { status: 410 }
            : { json: { items: [], nextSyncToken: "fresh" } };
        },
      },
    ]);
    const { source } = calendarSource([], [target({ direction: "Inbound" })]);
    const out = await calendarConnector(googleCalendarProvider, source).sync(
      contextFor("google_calendar", {
        http,
        store: memoryStore().store,
        run,
        cursor: '{"t-1":"old"}',
      }),
    );
    expect(calls).toBe(2);
    expect(out.cursorAfter).toBe('{"t-1":"fresh"}');
    const denied = scriptedHttp([
      { match: "GET https://www.googleapis.com", respond: () => ({ status: 403 }) },
    ]);
    await expect(
      calendarConnector(googleCalendarProvider, source).sync(
        contextFor("google_calendar", { http: denied.http, store: memoryStore().store, run }),
      ),
    ).rejects.toMatchObject({ connectionError: true });
  });

  it("treats a foreign cursor as a fresh start and honors target direction", async () => {
    const { http, requests } = scriptedHttp([
      { match: "GET https://www.googleapis.com", respond: () => ({ json: { items: [] } }) },
    ]);
    const { source } = calendarSource(
      [],
      [target({ direction: "Outbound" }), target({ id: "t-2", direction: "Inbound" })],
    );
    const out = await calendarConnector(googleCalendarProvider, source).sync(
      contextFor("google_calendar", { http, store: memoryStore().store, run, cursor: "not json" }),
    );
    expect(requests).toHaveLength(1);
    expect(out.cursorAfter).toBe("{}");
    const scalar = await calendarConnector(googleCalendarProvider, source).sync(
      contextFor("google_calendar", { http, store: memoryStore().store, run, cursor: "42" }),
    );
    expect(scalar.cursorAfter).toBe("{}");
    await expect(
      calendarConnector(
        googleCalendarProvider,
        calendarSource([meeting({ startsAt: "soon" })]).source,
      ).sync(
        contextFor("google_calendar", {
          http,
          store: memoryStore().store,
          run: { ...run, direction: "Outbound" },
        }),
      ),
    ).rejects.toMatchObject({ code: "instant_malformed" });
    await expect(
      calendarConnector(googleCalendarProvider, calendarSource([meeting()]).source).sync(
        contextFor("google_calendar", {
          http,
          store: memoryStore().store,
          run: { ...run, direction: "Outbound" },
          credential: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "credential_required" });
  });
});

describe("calendar sync with Microsoft 365", () => {
  it("writes events in UTC and follows the delta feed", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://graph.microsoft.com/v1.0/me/calendars/AAMk/events",
        respond: () => ({ json: { id: "m-1", changeKey: "ck1" } }),
      },
      {
        match: "PATCH https://graph.microsoft.com/v1.0/me/events/m-1",
        respond: () => ({ json: { id: "m-1", changeKey: "ck2" } }),
      },
      {
        match: "GET https://graph.microsoft.com/v1.0/me/calendars/AAMk/calendarView/delta",
        respond: () => ({
          json: {
            value: [
              {
                id: "m-1",
                changeKey: "ck3",
                lastModifiedDateTime: "2027-06-02T00:00:00Z",
                start: { dateTime: "2027-06-01T18:00:00.0000000", timeZone: "UTC" },
                end: { dateTime: "2027-06-01T19:00:00.0000000", timeZone: "UTC" },
              },
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/next",
          },
        }),
      },
      {
        match: "GET https://graph.microsoft.com/v1.0/next",
        respond: () => ({
          json: {
            value: [{ id: "m-2", "@removed": { reason: "deleted" } }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?token=d1",
          },
        }),
      },
    ]);
    const { store, externalIds } = memoryStore();
    const items = [meeting({ location: null, conferencingUri: null, timeZone: null })];
    const s = calendarSource(items, [target({ externalCalendarId: "AAMk" })]);
    await calendarConnector(microsoftCalendarProvider, s.source).sync(
      contextFor("microsoft_365", { http, store, run: { ...run, direction: "Outbound" } }),
    );
    expect(bodyOf(requests[0])).toEqual({
      subject: "Production Meeting",
      body: { contentType: "text", content: "" },
      start: { dateTime: "2027-06-01T14:00:00.000", timeZone: "UTC" },
      end: { dateTime: "2027-06-01T15:00:00.000", timeZone: "UTC" },
      transactionId: "rec-1",
    });
    const changed = calendarSource(
      [meeting({ title: "Moved", location: "Dock", timeZone: "America/New_York" })],
      [target({ externalCalendarId: "AAMk" })],
    );
    const out = await calendarConnector(microsoftCalendarProvider, changed.source).sync(
      contextFor("microsoft_365", { http, store, run }),
    );
    expect(requests.find((r) => r.method === "GET")?.headers?.["prefer"]).toContain(
      'outlook.timezone="UTC"',
    );
    expect(changed.applied[0]?.slice(3, 5)).toEqual([
      "2027-06-01T18:00:00.000Z",
      "2027-06-01T19:00:00.000Z",
    ]);
    expect(bodyOf(requests.find((r) => r.method === "PATCH"))).toMatchObject({
      location: { displayName: "Dock" },
      originalStartTimeZone: "America/New_York",
    });
    expect(JSON.parse(out.cursorAfter ?? "{}")).toEqual({
      "t-1": "https://graph.microsoft.com/v1.0/delta?token=d1",
    });
    expect(externalIds[0]?.externalVersion).toBe("ck2");
  });

  it("refuses foreign links and non-UTC times, and tolerates removed events", async () => {
    const { source } = calendarSource(
      [],
      [target({ direction: "Inbound", externalCalendarId: "AAMk" })],
    );
    const store = memoryStore().store;
    await expect(
      calendarConnector(microsoftCalendarProvider, source).sync(
        contextFor("microsoft_365", {
          http: scriptedHttp([]).http,
          store,
          run,
          cursor: '{"t-1":"https://evil.example.com/delta"}',
        }),
      ),
    ).rejects.toMatchObject({ code: "cursor_malformed" });
    const hop = scriptedHttp([
      {
        match: "GET https://graph.microsoft.com",
        respond: () => ({
          json: { value: [], "@odata.nextLink": "https://evil.example.com/next" },
        }),
      },
    ]);
    await expect(
      calendarConnector(microsoftCalendarProvider, source).sync(
        contextFor("microsoft_365", { http: hop.http, store, run }),
      ),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
    const local = scriptedHttp([
      {
        match: "GET https://graph.microsoft.com",
        respond: () => ({
          json: {
            value: [
              {
                id: "m",
                start: { dateTime: "2027-06-01T18:00:00", timeZone: "Pacific Standard Time" },
              },
            ],
          },
        }),
      },
    ]);
    await expect(
      calendarConnector(microsoftCalendarProvider, source).sync(
        contextFor("microsoft_365", { http: local.http, store, run }),
      ),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
    const offset = scriptedHttp([
      {
        match: "GET https://graph.microsoft.com",
        respond: () => ({
          json: {
            value: [{ id: "m", start: { dateTime: "2027-06-01T18:00:00Z", timeZone: "UTC" } }],
          },
        }),
      },
    ]);
    const out = await calendarConnector(microsoftCalendarProvider, source).sync(
      contextFor("microsoft_365", { http: offset.http, store, run }),
    );
    expect(out.cursorAfter).toBe("{}");
    const del = scriptedHttp([
      { match: "DELETE https://graph.microsoft.com", respond: () => ({ status: 404 }) },
    ]);
    const pair: ExternalId = {
      entity: "Record",
      localId: "rec-1",
      externalId: "m-1",
      externalVersion: null,
      contentHash: null,
    };
    const canceled = calendarSource(
      [meeting({ canceled: true })],
      [target({ direction: "Outbound" })],
    );
    await calendarConnector(microsoftCalendarProvider, canceled.source).sync(
      contextFor("microsoft_365", { http: del.http, store: memoryStore([pair]).store, run }),
    );
    expect(del.requests[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/events/m-1");
    const delFails = scriptedHttp([
      { match: "DELETE https://graph.microsoft.com", respond: () => ({ status: 401 }) },
    ]);
    await expect(
      calendarConnector(microsoftCalendarProvider, canceled.source).sync(
        contextFor("microsoft_365", { http: delFails.http, store: memoryStore([pair]).store, run }),
      ),
    ).rejects.toMatchObject({ code: "credential_refused" });
    await expect(
      calendarConnector(microsoftCalendarProvider, canceled.source).sync(
        contextFor("microsoft_365", {
          http: delFails.http,
          store: memoryStore([pair]).store,
          run,
          credential: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "credential_required" });
  });
});

describe("calendar source", () => {
  it("reads targets and items and applies changes", async () => {
    const { db, calls } = recordingDb({
      "from:integration_calendar_targets": [
        okData([
          {
            id: "t",
            project_id: null,
            sync_kind: "Shift",
            external_calendar_id: "c",
            direction: "Two Way",
            conflict_policy: "XOS Wins",
          },
        ]),
      ],
      "from:integration_calendar_items": [
        okData([
          {
            entity: "Shift",
            local_id: "s",
            title: "T",
            starts_at: "a",
            ends_at: "b",
            time_zone: null,
            location_text: null,
            conferencing_uri: null,
            canceled: false,
            updated_at: "u",
          },
        ]),
      ],
      "rpc:apply_calendar_change": [okData(true)],
    });
    const s = supabaseCalendarSource(db);
    expect(await s.targets("conn")).toEqual([
      {
        id: "t",
        projectId: null,
        kind: "Shift",
        externalCalendarId: "c",
        direction: "Two Way",
        conflictPolicy: "XOS Wins",
      },
    ]);
    expect((await s.items("t"))[0]).toMatchObject({
      entity: "Shift",
      localId: "s",
      location: null,
    });
    expect(await s.applyChange("conn", "Shift", "s", "a", "b", "v")).toBe(true);
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      {
        p_connection_id: "conn",
        p_entity: "Shift",
        p_local_id: "s",
        p_starts_at: "a",
        p_ends_at: "b",
        p_external_version: "v",
      },
    ]);
    expect(calendarConnectors(s).map((c) => c.provider)).toEqual([
      "google_calendar",
      "microsoft_365",
    ]);
    expect(utc("2027-06-01T10:00:00-04:00")).toBe("2027-06-01T14:00:00.000Z");
  });
});
