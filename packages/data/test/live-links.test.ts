import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  asksForCode,
  clockText,
  createDisplayLink,
  createViewLink,
  DISPLAY_TOKEN,
  displayFrame,
  isLiveViewCollection,
  listLiveLinks,
  LIVE_VIEW_TOKEN,
  liveLinkPath,
  liveLinkState,
  openLiveLink,
  parseRefusal,
  readDisplay,
  readLiveView,
  regenerateLiveLink,
  revokeLiveLink,
  type PublicCue,
} from "../src/live-links.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

const VIEW = `xshv_${"ab".repeat(32)}`;
const SCREEN = `xscr_${"cd".repeat(32)}`;
const GRANT = `xlgr_${"ef".repeat(32)}`;

/** The fake client with `schema("api_public").rpc(...)` queued under `rpc:api_public.<fn>`. */
function withPublic(queues: Record<string, Response[]>) {
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    schema: (name: string) => ({
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn: `${name}.${fn}`, args });
        const next = queues[`rpc:${name}.${fn}`]?.shift();
        if (!next) throw new Error(`no queued response for rpc:${name}.${fn}`);
        return next;
      },
    }),
  } as unknown as XosClient;
  return { db, calls };
}

const cue = (over: Partial<PublicCue> = {}): PublicCue => ({
  position: 1,
  label: "Cue",
  segment: null,
  plannedAt: null,
  durationSeconds: null,
  calledAt: null,
  ...over,
});

describe("token and refusal shapes", () => {
  it("knows the token formats and the public paths", () => {
    expect(LIVE_VIEW_TOKEN.test(VIEW)).toBe(true);
    expect(LIVE_VIEW_TOKEN.test(SCREEN)).toBe(false);
    expect(DISPLAY_TOKEN.test(SCREEN)).toBe(true);
    expect(DISPLAY_TOKEN.test(`xscr_${"AB".repeat(32)}`)).toBe(false);
    expect(liveLinkPath("View", VIEW)).toBe(`/share/view/${VIEW}`);
    expect(liveLinkPath("Display", SCREEN)).toBe(`/share/screen/${SCREEN}`);
    expect(isLiveViewCollection("project/schedule")).toBe(true);
    expect(isLiveViewCollection("work/all_records")).toBe(false);
    expect(isLiveViewCollection(null)).toBe(false);
  });

  it("parses refusals, reading anything unknown as invalid", () => {
    expect(parseRefusal("live_link_locked")).toBe("live_link_locked");
    expect(parseRefusal("something_else")).toBe("live_link_invalid");
    expect(parseRefusal(undefined)).toBe("live_link_invalid");
    expect(asksForCode("live_link_grant")).toBe(true);
    expect(asksForCode("live_link_access_code")).toBe(true);
    expect(asksForCode("live_link_expired")).toBe(false);
  });

  it("computes a link's state as the database does", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const base = { revokedAt: null, expiresAt: "2026-11-02T00:00:00Z", failedAttempts: 0 };
    expect(liveLinkState(base, now)).toBe("Active");
    expect(liveLinkState({ ...base, failedAttempts: 5 }, now)).toBe("Locked");
    expect(liveLinkState({ ...base, expiresAt: "2026-10-31T00:00:00Z" }, now)).toBe("Expired");
    expect(liveLinkState({ ...base, revokedAt: "2026-10-31T00:00:00Z" }, now)).toBe("Revoked");
  });
});

describe("managing links", () => {
  it("makes a view link and returns the token and code once", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_view_link": [
        okResponse([
          {
            live_link_id: "l1",
            token: VIEW,
            access_code: "042424",
            expires_at: "2026-11-27T00:00:00Z",
          },
        ]),
      ],
    });
    const result = await createViewLink(db, {
      savedViewId: "v1",
      projectId: "p1",
      expiresAt: "2026-11-27T00:00:00Z",
      note: null,
    });
    expect(result).toEqual({
      ok: true,
      data: { id: "l1", token: VIEW, accessCode: "042424", expiresAt: "2026-11-27T00:00:00Z" },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_saved_view_id: "v1",
      p_project_id: "p1",
      p_expires_at: "2026-11-27T00:00:00Z",
    });
  });

  it("reports a refusal by rule", async () => {
    const { db } = fakeClient({
      "rpc:create_view_link": [
        errorResponse("XR001", "live_link_view_unsupported: This view cannot be shared live."),
      ],
    });
    const result = await createViewLink(db, {
      savedViewId: "v1",
      projectId: "p1",
      expiresAt: "2026-11-27T00:00:00Z",
      note: "For the venue",
    });
    expect(result.ok ? null : result.error).toMatchObject({
      kind: "refusal",
      rule: "live_link_view_unsupported",
    });
  });

  it("makes a display link with the default expiry left to the database", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_display_link": [
        okResponse([
          {
            live_link_id: "l2",
            token: SCREEN,
            access_code: "000123",
            expires_at: "2026-11-02T04:00:00Z",
          },
        ]),
      ],
    });
    const result = await createDisplayLink(db, {
      runOfShowId: "r1",
      expiresAt: null,
      defaultMode: "Presenter Timer",
      note: null,
    });
    expect(result.ok && result.data.accessCode).toBe("000123");
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_run_of_show_id: "r1",
      p_default_mode: "Presenter Timer",
    });
  });

  it("lists links with their computed state, never the hashes", async () => {
    const row = {
      id: "l1",
      link_kind: "View",
      project_id: "p1",
      saved_view_id: "v1",
      run_of_show_id: null,
      default_mode: null,
      token_hint: "abab",
      note: "For the venue",
      expires_at: "2026-11-27T00:00:00Z",
      failed_attempts: 0,
      open_count: 3,
      last_opened_at: null,
      rotated_at: null,
      revoked_at: null,
      created_by: "p-dave",
      created_at: "2026-10-28T00:00:00Z",
    };
    const { db, calls } = fakeClient({
      "from:live_links": [okResponse([row])],
      "from:live_link_states": [okResponse([{ id: "l1", link_state: "Locked" }])],
    });
    const result = await listLiveLinks(db, { savedViewId: "v1" });
    expect(result.ok && result.data.map((l) => [l.id, l.state, l.openCount])).toEqual([
      ["l1", "Locked", 3],
    ]);
    const select = calls[0]?.steps.find(([m]) => m === "select")?.[1][0] as string;
    expect(select).not.toContain("token_hash");
    expect(select).not.toContain("access_code_hash");
  });

  it("regenerates and revokes", async () => {
    const { db } = fakeClient({
      "rpc:regenerate_live_link": [
        okResponse([{ token: VIEW, access_code: "999999", expires_at: "2026-11-27T00:00:00Z" }]),
      ],
      "rpc:revoke_live_link": [okResponse("2026-10-28T12:00:00Z")],
    });
    expect(await regenerateLiveLink(db, "l1")).toEqual({
      ok: true,
      data: { token: VIEW, accessCode: "999999", expiresAt: "2026-11-27T00:00:00Z" },
    });
    expect(await revokeLiveLink(db, "l1")).toEqual({ ok: true, data: "2026-10-28T12:00:00Z" });
  });
});

describe("the anonymous side", () => {
  it("refuses a token of the wrong shape without calling the database", async () => {
    const { db, calls } = withPublic({});
    expect(
      await openLiveLink(db, { kind: "View", token: SCREEN, accessCode: "1", clientAddress: null }),
    ).toEqual({
      ok: true,
      data: { refused: true, reason: "live_link_invalid" },
    });
    expect(await readLiveView(db, { token: VIEW, grant: "nope", clientAddress: null })).toEqual({
      ok: true,
      data: { refused: true, reason: "live_link_grant" },
    });
    expect(calls).toHaveLength(0);
  });

  it("opens with the code and relays the client address", async () => {
    const { db, calls } = withPublic({
      "rpc:api_public.open_live_link": [
        okResponse({
          status: "ok",
          grant: GRANT,
          grant_expires_at: "2026-11-04T00:00:00Z",
          kind: "View",
        }),
        okResponse({ status: "refused", reason: "live_link_access_code" }),
      ],
    });
    expect(
      await openLiveLink(db, {
        kind: "View",
        token: VIEW,
        accessCode: "042424",
        clientAddress: "203.0.113.9",
      }),
    ).toEqual({
      ok: true,
      data: { refused: false, grant: GRANT, grantExpiresAt: "2026-11-04T00:00:00Z", kind: "View" },
    });
    expect(calls[0]?.args).toEqual({
      p_token: VIEW,
      p_access_code: "042424",
      p_client_address: "203.0.113.9",
    });
    expect(
      await openLiveLink(db, {
        kind: "View",
        token: VIEW,
        accessCode: "000000",
        clientAddress: null,
      }),
    ).toEqual({ ok: true, data: { refused: true, reason: "live_link_access_code" } });
  });

  it("refuses a grant of the wrong kind", async () => {
    const { db } = withPublic({
      "rpc:api_public.open_live_link": [
        okResponse({
          status: "ok",
          grant: GRANT,
          grant_expires_at: "2026-11-04T00:00:00Z",
          kind: "Display",
        }),
      ],
    });
    expect(
      await openLiveLink(db, {
        kind: "View",
        token: VIEW,
        accessCode: "042424",
        clientAddress: null,
      }),
    ).toEqual({ ok: true, data: { refused: true, reason: "live_link_invalid" } });
  });

  it("reads a schedule view", async () => {
    const { db } = withPublic({
      "rpc:api_public.live_view": [
        okResponse({
          status: "ok",
          meta: {
            collection_key: "project/schedule",
            project_name: "Northwind Summer Series",
            time_zone: "America/New_York",
            brand_name: "Northwind Live",
            brand_suppress_powered_by: false,
            expires_at: "2026-11-27T00:00:00Z",
            view_name: "Milestones",
            view_type: "Calendar",
            group_by_field: null,
          },
          channel: `xlink:xlch_${"0".repeat(64)}`,
          server_now: "2026-10-28T12:00:00Z",
          rows: [
            {
              key: "NWL-4",
              title: "Doors open",
              kind: "Milestone",
              state: "Planned",
              starts_at: "2026-10-30T23:00:00Z",
            },
          ],
          truncated: false,
        }),
      ],
    });
    const result = await readLiveView(db, { token: VIEW, grant: GRANT, clientAddress: null });
    if (!result.ok || result.data.refused) throw new Error("expected a view");
    expect(result.data.meta).toMatchObject({
      viewName: "Milestones",
      viewType: "Calendar",
      timeZone: "America/New_York",
    });
    expect(result.data.data.collection).toBe("project/schedule");
    expect(result.data.data.rows[0]).toMatchObject({
      key: "NWL-4",
      title: "Doors open",
      startsAt: "2026-10-30T23:00:00Z",
    });
  });

  it("passes a refusal through", async () => {
    const { db } = withPublic({
      "rpc:api_public.live_display": [
        okResponse({ status: "refused", reason: "live_link_owner_access" }),
      ],
    });
    expect(await readDisplay(db, { token: SCREEN, grant: GRANT, clientAddress: null })).toEqual({
      ok: true,
      data: { refused: true, reason: "live_link_owner_access" },
    });
  });

  it("reads a display screen", async () => {
    const { db } = withPublic({
      "rpc:api_public.live_display": [
        okResponse({
          status: "ok",
          meta: {
            name: "Opening Night",
            show_date: "2026-11-01",
            default_mode: "Room Clock",
            time_zone: "UTC",
          },
          channel: null,
          server_now: "2026-10-28T12:00:00Z",
          cues: [
            {
              position: 1,
              label: "House to Half",
              segment: "Act I",
              planned_at: null,
              duration_seconds: 300,
              called_at: null,
            },
          ],
        }),
      ],
    });
    const result = await readDisplay(db, { token: SCREEN, grant: GRANT, clientAddress: null });
    if (!result.ok || result.data.refused) throw new Error("expected a display");
    expect(result.data.meta.defaultMode).toBe("Room Clock");
    expect(result.data.cues).toEqual([
      {
        position: 1,
        label: "House to Half",
        segment: "Act I",
        plannedAt: null,
        durationSeconds: 300,
        calledAt: null,
      },
    ]);
  });
});

describe("display frames", () => {
  const now = Date.parse("2026-11-01T20:10:00Z");

  it("shows now, next, the three after it and the time left", () => {
    const cues = [
      cue({ position: 1, label: "Doors", calledAt: "2026-11-01T19:30:00Z" }),
      cue({
        position: 2,
        label: "Opener",
        plannedAt: "2026-11-01T20:00:00Z",
        calledAt: "2026-11-01T20:05:00Z",
        durationSeconds: 1800,
      }),
      cue({ position: 3, label: "Changeover", plannedAt: "2026-11-01T20:35:00Z" }),
      cue({ position: 4, label: "Headliner" }),
      cue({ position: 5, label: "Encore" }),
      cue({ position: 6, label: "House lights" }),
      cue({ position: 7, label: "Curfew" }),
    ];
    const frame = displayFrame(cues, now);
    expect(frame.current?.label).toBe("Opener");
    expect(frame.next?.label).toBe("Changeover");
    expect(frame.upcoming.map((c) => c.label)).toEqual(["Headliner", "Encore", "House lights"]);
    expect(frame.elapsedSeconds).toBe(300);
    expect(frame.remainingSeconds).toBe(1500);
    expect(frame.overrun).toBe(false);
    expect(frame.latenessSeconds).toBe(300);
    expect(frame.timeToNextSeconds).toBe(1500);
  });

  it("flags an overrun until the next cue is called", () => {
    const cues = [
      cue({ position: 1, label: "Speech", calledAt: "2026-11-01T20:00:00Z", durationSeconds: 300 }),
      cue({ position: 2, label: "Video" }),
    ];
    const over = displayFrame(cues, now);
    expect(over.remainingSeconds).toBe(-300);
    expect(over.overrun).toBe(true);
    const called = displayFrame(
      [
        cues[0] as PublicCue,
        cue({
          position: 2,
          label: "Video",
          calledAt: "2026-11-01T20:09:30Z",
          durationSeconds: 600,
        }),
      ],
      now,
    );
    expect(called.overrun).toBe(false);
    expect(called.current?.label).toBe("Video");
    expect(called.complete).toBe(true);
  });

  it("counts up without a duration and starts before the first call", () => {
    const running = displayFrame([cue({ calledAt: "2026-11-01T20:00:00Z" })], now);
    expect(running.remainingSeconds).toBeNull();
    expect(running.elapsedSeconds).toBe(600);
    expect(running.overrun).toBe(false);
    expect(running.latenessSeconds).toBeNull();
    const before = displayFrame([cue({ plannedAt: "2026-11-01T20:15:00Z" })], now);
    expect(before.current).toBeNull();
    expect(before.next?.position).toBe(1);
    expect(before.timeToNextSeconds).toBe(300);
  });

  it("writes seconds as a clock", () => {
    expect(clockText(5)).toBe("0:05");
    expect(clockText(-125)).toBe("2:05");
    expect(clockText(3725)).toBe("1:02:05");
  });
});
