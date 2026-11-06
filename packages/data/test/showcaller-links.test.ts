import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  consoleCalls,
  consoleCue,
  createShowcallerLink,
  displayCue,
  fieldsBody,
  listShowcallerLinks,
  openShowcallerLink,
  parseShowcallerRefusal,
  readShowcallerRun,
  regenerateShowcallerLink,
  revokeShowcallerLink,
  SHOWCALLER_GRANT,
  SHOWCALLER_TOKEN,
  showcallerAsksForCode,
  showcallerLinkGone,
  showcallerLinkState,
  showcallerPath,
  showcallerWrite,
  signOutShowcallerDevices,
} from "../src/showcaller-links.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

const TOKEN = `xscl_${"ab".repeat(32)}`;
const GRANT = `xcgr_${"cd".repeat(32)}`;

/** The fake client with `schema("api_public").rpc(...)` queued under `rpc:api_public.<fn>`. */
function withPublic(queues: Record<string, Response[]>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    schema: (name: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn: `${name}.${fn}`, args });
        const next = queues[`rpc:${name}.${fn}`]?.shift();
        if (!next) throw new Error(`no queued response for rpc:${name}.${fn}`);
        return next;
      },
    }),
  } as unknown as XosClient;
  return { db, calls };
}

const RUN = {
  status: "ok",
  meta: {
    project_name: "Northwind Summer Series",
    time_zone: "America/New_York",
    brand_name: "Northwind Live",
    caller_name: "Sam Okafor",
    expires_at: "2027-06-07T04:00:00Z",
    grant_expires_at: "2027-06-06T23:00:00Z",
    name: "Opening Night",
    show_date: "2027-06-05",
    stage: "Main Stage",
    curfew_at: null,
  },
  channel: `xcall:xcch_${"e".repeat(64)}`,
  server_now: "2027-06-05T23:00:00Z",
  cues: [
    {
      id: "c1",
      position: 1,
      label: "House to Half",
      segment: "Act I",
      segment_color: "cat-2",
      planned_at: "2027-06-05T23:00:00Z",
      start_tbc: false,
      duration_seconds: 120,
      called_at: null,
      called_via_link: true,
      set_time: true,
      standby_at: "2027-06-05T22:59:00Z",
      description: null,
      script: "Ladies and gentlemen",
      updated_at: "2027-06-05T22:59:00Z",
      calls: [
        { kind: "Lighting", instruction: "LX 1" },
        { kind: "Audio", instruction: "Walk-in out" },
        { kind: "Pyro", instruction: "never" },
      ],
      fields: [
        {
          key: "camera",
          label: "Camera",
          data_type: "Choice",
          choice_label: "Wide",
          color_key: "cat-3",
        },
        { key: "count", label: "Count", data_type: "Number", value_number: 3, value_boolean: true },
      ],
    },
  ],
};

describe("shapes", () => {
  it("knows the token, grant and path", () => {
    expect(SHOWCALLER_TOKEN.test(TOKEN)).toBe(true);
    expect(SHOWCALLER_TOKEN.test(`xshv_${"ab".repeat(32)}`)).toBe(false);
    expect(SHOWCALLER_GRANT.test(GRANT)).toBe(true);
    expect(SHOWCALLER_GRANT.test(`xlgr_${"cd".repeat(32)}`)).toBe(false);
    expect(showcallerPath(TOKEN)).toBe(`/share/showcaller/${TOKEN}`);
  });

  it("parses refusals and says which ask for the code and which end the portal", () => {
    expect(parseShowcallerRefusal("showcaller_link_scope")).toBe("showcaller_link_scope");
    expect(parseShowcallerRefusal("cue_already_called")).toBe("cue_already_called");
    expect(parseShowcallerRefusal("live_link_invalid")).toBe("showcaller_link_invalid");
    expect(showcallerAsksForCode("showcaller_link_grant")).toBe(true);
    expect(showcallerAsksForCode("showcaller_link_access_code")).toBe(true);
    expect(showcallerAsksForCode("showcaller_link_expired")).toBe(false);
    expect(showcallerLinkGone("showcaller_link_invalid")).toBe(true);
    expect(showcallerLinkGone("showcaller_link_owner_access")).toBe(true);
    expect(showcallerLinkGone("showcaller_link_rate_limited")).toBe(false);
  });

  it("computes a link's state as the database does", () => {
    const now = new Date("2027-06-05T00:00:00Z");
    const base = { revokedAt: null, expiresAt: "2027-06-06T00:00:00Z", failedAttempts: 0 };
    expect(showcallerLinkState(base, now)).toBe("Active");
    expect(showcallerLinkState({ ...base, failedAttempts: 5 }, now)).toBe("Locked");
    expect(showcallerLinkState({ ...base, expiresAt: "2027-06-04T00:00:00Z" }, now)).toBe(
      "Expired",
    );
    expect(showcallerLinkState({ ...base, revokedAt: "t" }, now)).toBe("Revoked");
  });

  it("sends only the fields given, in the database's names", () => {
    expect(fieldsBody({ label: "Encore", durationSeconds: 300 })).toEqual({
      label: "Encore",
      duration_seconds: 300,
    });
    expect(
      fieldsBody({
        segment: null,
        description: "x",
        script: "y",
        plannedAt: "t",
        startTbc: true,
      }),
    ).toEqual({ segment: null, description: "x", script: "y", planned_at: "t", start_tbc: true });
  });
});

describe("managing links", () => {
  it("lists links with state and devices", async () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      run_of_show_id: "r1",
      caller_name: "Sam",
      note: null,
      token_hint: "abcd",
      expires_at: "2099-01-01T00:00:00Z",
      failed_attempts: 0,
      open_count: 1,
      last_opened_at: null,
      rotated_at: null,
      revoked_at: null,
      created_by: "p1",
      created_at: "t",
      ...over,
    });
    const { db } = fakeClient({
      "from:showcaller_links": [
        okResponse([row("l1"), row("l2", { revoked_at: "t" }), row("l3")]),
        errorResponse("42501", "denied"),
      ],
      "rpc:showcaller_link_devices": [okResponse(3), errorResponse("42501", "not yours")],
    });
    const list = await listShowcallerLinks(db, "r1");
    expect(list.ok && list.data.map((l) => [l.state, l.devices])).toEqual([
      ["Active", 3],
      ["Revoked", 0],
      ["Active", null],
    ]);
    expect((await listShowcallerLinks(db, "r1")).ok).toBe(false);
  });

  it("creates, regenerates, revokes and signs devices out", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_showcaller_link": [
        okResponse([
          { showcaller_link_id: "l1", token: TOKEN, access_code: "042424", expires_at: "t" },
        ]),
        okResponse([{ showcaller_link_id: "l1", token: null, access_code: null, expires_at: "t" }]),
        errorResponse("XR001", "showcaller_link_capability: no"),
      ],
      "rpc:regenerate_showcaller_link": [
        okResponse([{ token: TOKEN, access_code: "000111", expires_at: "t" }]),
        okResponse([]),
        errorResponse("XR001", "showcaller_link_revoked: no"),
      ],
      "rpc:revoke_showcaller_link": [okResponse("t"), errorResponse("42501", "not found")],
      "rpc:sign_out_showcaller_devices": [okResponse(2), errorResponse("42501", "not found")],
    });
    const input = { runOfShowId: "r1", callerName: "Sam", expiresAt: null, note: null };
    expect(await createShowcallerLink(db, input)).toEqual({
      ok: true,
      data: { id: "l1", token: TOKEN, accessCode: "042424", expiresAt: "t" },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({ p_run_of_show_id: "r1", p_caller_name: "Sam" });
    expect((await createShowcallerLink(db, { ...input, expiresAt: "e", note: "n" })).ok).toBe(
      false,
    );
    expect(calls[1]?.steps[0]?.[1][0]).toMatchObject({ p_expires_at: "e", p_note: "n" });
    expect((await createShowcallerLink(db, input)).ok).toBe(false);
    expect((await regenerateShowcallerLink(db, "l1")).ok).toBe(true);
    expect((await regenerateShowcallerLink(db, "l1")).ok).toBe(false);
    expect((await regenerateShowcallerLink(db, "l1")).ok).toBe(false);
    expect(await revokeShowcallerLink(db, "l1")).toEqual({ ok: true, data: "t" });
    expect((await revokeShowcallerLink(db, "l1")).ok).toBe(false);
    expect(await signOutShowcallerDevices(db, "l1")).toEqual({ ok: true, data: 2 });
    expect((await signOutShowcallerDevices(db, "l1")).ok).toBe(false);
  });
});

describe("the portal", () => {
  it("opens with the code, refusing a malformed token without a call", async () => {
    const { db, calls } = withPublic({
      "rpc:api_public.open_showcaller_link": [
        okResponse({ status: "ok", grant: GRANT, grant_expires_at: "t" }),
        okResponse({ status: "refused", reason: "showcaller_link_devices" }),
        okResponse({ status: "ok" }),
        errorResponse("25006", "read only"),
      ],
    });
    expect(
      await openShowcallerLink(db, { token: "xscr_x", accessCode: "1", clientAddress: null }),
    ).toEqual({
      ok: true,
      data: { refused: true, reason: "showcaller_link_invalid" },
    });
    expect(calls).toHaveLength(0);
    const input = { token: TOKEN, accessCode: "042424", clientAddress: "198.51.100.7" };
    expect(await openShowcallerLink(db, input)).toEqual({
      ok: true,
      data: { refused: false, grant: GRANT, grantExpiresAt: "t" },
    });
    expect(calls[0]).toEqual({
      fn: "api_public.open_showcaller_link",
      args: { p_token: TOKEN, p_access_code: "042424", p_client_address: "198.51.100.7" },
    });
    expect(await openShowcallerLink(db, input)).toEqual({
      ok: true,
      data: { refused: true, reason: "showcaller_link_devices" },
    });
    expect(await openShowcallerLink(db, input)).toEqual({
      ok: true,
      data: { refused: true, reason: "showcaller_link_invalid" },
    });
    expect((await openShowcallerLink(db, input)).ok).toBe(false);
  });

  it("reads the running order and maps every cue", async () => {
    const { db } = withPublic({
      "rpc:api_public.showcaller_run": [
        okResponse(RUN),
        okResponse({ status: "refused", reason: "showcaller_link_scope" }),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(
      await readShowcallerRun(db, { token: "nope", grant: GRANT, clientAddress: null }),
    ).toEqual({ ok: true, data: { refused: true, reason: "showcaller_link_invalid" } });
    expect(
      await readShowcallerRun(db, { token: TOKEN, grant: "nope", clientAddress: null }),
    ).toEqual({ ok: true, data: { refused: true, reason: "showcaller_link_grant" } });
    const read = await readShowcallerRun(db, { token: TOKEN, grant: GRANT, clientAddress: null });
    if (!read.ok || read.data.refused) throw new Error("expected a run");
    expect(read.data.meta).toMatchObject({ stage: "Main Stage", callerName: "Sam Okafor" });
    const cue = read.data.cues[0];
    expect(cue).toMatchObject({
      segmentColor: "cat-2",
      durationSeconds: 120,
      script: "Ladies and gentlemen",
      calledViaLink: true,
      setTime: true,
    });
    expect(cue?.calls.map((c) => c.kind)).toEqual(["Audio", "Lighting"]);
    expect(cue?.fields[0]).toMatchObject({ choiceLabel: "Wide", colorKey: "cat-3" });
    expect(cue?.fields[1]).toMatchObject({ number: 3, boolean: true, colorKey: null });
    expect(
      await readShowcallerRun(db, { token: TOKEN, grant: GRANT, clientAddress: null }),
    ).toEqual({ ok: true, data: { refused: true, reason: "showcaller_link_scope" } });
    expect(
      (await readShowcallerRun(db, { token: TOKEN, grant: GRANT, clientAddress: null })).ok,
    ).toBe(false);
    if (cue) {
      expect(consoleCue(cue, "r1")).toMatchObject({
        runOfShowId: "r1",
        calledByName: null,
        segment: "Act I",
      });
      expect(consoleCalls([cue]).map((c) => c.id)).toEqual(["c1:Audio", "c1:Lighting"]);
      expect(displayCue(cue)).toEqual({
        position: 1,
        label: "House to Half",
        segment: "Act I",
        plannedAt: "2027-06-05T23:00:00Z",
        durationSeconds: 120,
        calledAt: null,
      });
    }
  });

  it("sends each write to its RPC with the link's token and grant", async () => {
    const ok = () => okResponse({ status: "ok" });
    const { db, calls } = withPublic({
      "rpc:api_public.showcaller_call_cue": [
        ok(),
        okResponse({ status: "refused", reason: "cue_already_called" }),
      ],
      "rpc:api_public.showcaller_standby_cue": [ok()],
      "rpc:api_public.showcaller_shift_plan": [ok()],
      "rpc:api_public.showcaller_move_cue": [ok()],
      "rpc:api_public.showcaller_save_cue": [ok()],
      "rpc:api_public.showcaller_remove_cue": [ok()],
      "rpc:api_public.showcaller_save_cue_calls": [errorResponse("XX000", "boom")],
    });
    const base = { token: TOKEN, grant: GRANT, clientAddress: "198.51.100.7" };
    expect(await showcallerWrite(db, { ...base, write: { op: "call", cueId: "c1" } })).toEqual({
      ok: true,
      data: { refused: false },
    });
    expect(calls[0]?.args).toEqual({
      p_token: TOKEN,
      p_grant: GRANT,
      p_client_address: "198.51.100.7",
      p_cue_id: "c1",
    });
    expect(await showcallerWrite(db, { ...base, write: { op: "call", cueId: "c1" } })).toEqual({
      ok: true,
      data: { refused: true, reason: "cue_already_called" },
    });
    await showcallerWrite(db, { ...base, write: { op: "standby", cueId: null } });
    await showcallerWrite(db, { ...base, write: { op: "shift", seconds: 60 } });
    await showcallerWrite(db, { ...base, write: { op: "move", cueId: "c1", toPosition: 2 } });
    await showcallerWrite(db, {
      ...base,
      write: { op: "save", cueId: null, fields: { label: "Encore" }, expectedUpdatedAt: null },
    });
    await showcallerWrite(db, { ...base, write: { op: "remove", cueId: "c1" } });
    expect(calls.map((c) => c.fn)).toEqual([
      "api_public.showcaller_call_cue",
      "api_public.showcaller_call_cue",
      "api_public.showcaller_standby_cue",
      "api_public.showcaller_shift_plan",
      "api_public.showcaller_move_cue",
      "api_public.showcaller_save_cue",
      "api_public.showcaller_remove_cue",
    ]);
    expect(calls[5]?.args).toMatchObject({ p_cue_id: null, p_fields: { label: "Encore" } });
    expect(
      (
        await showcallerWrite(db, {
          ...base,
          write: { op: "calls", cueId: "c1", calls: { Audio: "Mic" } },
        })
      ).ok,
    ).toBe(false);
    expect(
      await showcallerWrite(db, { ...base, token: "nope", write: { op: "call", cueId: "c1" } }),
    ).toEqual({ ok: true, data: { refused: true, reason: "showcaller_link_invalid" } });
    expect(
      await showcallerWrite(db, { ...base, grant: "nope", write: { op: "call", cueId: "c1" } }),
    ).toEqual({ ok: true, data: { refused: true, reason: "showcaller_link_grant" } });
  });
});
