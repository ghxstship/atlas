import {
  MemoryStore,
  ONLINE,
  stampEvent,
  SyncEngine,
  type DeviceClock,
  type Mutation,
  type UploadOutcome,
} from "@xos/sync";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SupabaseUploader } from "../src/data/uploader";
import { access, type CompassIdentity, type EngagementSummary } from "../src/domain/access";
import {
  buildPunch,
  buildSupervisorPunchBatch,
  primaryTeamPunch,
  TEAM_PUNCH_TABLE,
  teamClockState,
  teamShifts,
  type TeamPunchBatch,
  type TeamShiftRow,
} from "../src/domain/clock";

/**
 * Clock in team (R12, G-126): one queued mutation per team punch with a punch id per worker, kept across going
 * offline and sent once on reconnect; who may open it; and the roster punch agency staff make on their own shift.
 */

const T0 = Date.UTC(2026, 9, 30, 13, 0, 0);
const clock: DeviceClock = { wallNow: () => T0, monotonicNow: () => 5_000, bootId: () => "boot-1" };
let counter = 0;
const ids = () => `id-${(counter += 1)}`;

const team = [
  { shiftId: "shift-a", name: "Staff One" },
  { shiftId: "shift-b", name: "Staff Two" },
];

describe("buildSupervisorPunchBatch", () => {
  it("makes one mutation with the batch id and a distinct punch id per worker", () => {
    counter = 0;
    const m = buildSupervisorPunchBatch(
      "In",
      "proj-1",
      team,
      stampEvent(clock, null),
      null,
      [],
      T0,
      ids,
    );
    expect(m.target).toBe("app.record_supervisor_punches");
    expect(m.table).toBe(TEAM_PUNCH_TABLE);
    expect(m.rowId).toBe("id-1");
    const punches = m.payload["p_punches"] as { punch_id: string; shift_id: string }[];
    expect(m.payload["p_batch_id"]).toBe("id-1");
    expect(punches.map((p) => p.shift_id)).toEqual(["shift-a", "shift-b"]);
    expect(new Set(punches.map((p) => p.punch_id)).size).toBe(2);
    expect(punches.map((p) => p.punch_id)).not.toContain("id-1");
    expect(m.payload).toMatchObject({
      p_project_id: "proj-1",
      p_punch_kind: "In",
      p_device_time: new Date(T0).toISOString(),
      monotonic_at: 5_000,
      boot_id: "boot-1",
    });
    expect(
      (m.optimistic as unknown as TeamPunchBatch).results.every((r) => r.outcome === "pending"),
    ).toBe(true);
  });

  it("punches each worker once, however often the selection names them, and at most 100", () => {
    const twice = buildSupervisorPunchBatch(
      "Out",
      "proj-1",
      [...team, team[0] as (typeof team)[number]],
      stampEvent(clock, null),
      null,
      [],
      T0,
    );
    expect((twice.payload["p_punches"] as unknown[]).length).toBe(2);
    expect(() =>
      buildSupervisorPunchBatch("In", "proj-1", [], stampEvent(clock, null), null, [], T0),
    ).toThrow();
    const many = Array.from({ length: 101 }, (_, i) => ({ shiftId: `s${i}`, name: `P${i}` }));
    expect(() =>
      buildSupervisorPunchBatch("In", "proj-1", many, stampEvent(clock, null), null, [], T0),
    ).toThrow();
  });

  it("survives going offline and is sent once, as queued, on reconnect", async () => {
    const store = new MemoryStore();
    const sent: Mutation[] = [];
    const engine = new SyncEngine({
      store,
      uploader: {
        upload: (mutation: Mutation): Promise<UploadOutcome> => {
          sent.push(mutation);
          return Promise.resolve({ kind: "applied", serverRow: null });
        },
      },
      schedule: () => () => undefined,
    });
    const m = buildSupervisorPunchBatch(
      "In",
      "proj-1",
      team,
      stampEvent(clock, null),
      null,
      [],
      T0,
    );
    await engine.outbox.enqueue(m);
    expect(sent).toHaveLength(0);
    expect(await engine.outbox.all()).toHaveLength(1);
    await engine.setNetwork(ONLINE);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload["p_punches"]).toEqual(m.payload["p_punches"]);
    expect(sent[0]?.payload["p_batch_id"]).toBe(m.payload["p_batch_id"]);
  });

  it("keeps the batch on the board once the server's answer replaces it", async () => {
    // The lead's device calls the RPC directly (no member org), and the store takes the answer as the row.
    const m = buildSupervisorPunchBatch(
      "In",
      "proj-1",
      team,
      { ...stampEvent(clock, null), deviceAt: new Date(T0).toISOString() },
      null,
      [],
      T0,
    );
    const punches = m.payload["p_punches"] as { punch_id: string; shift_id: string }[];
    const answer = {
      id: m.rowId,
      batch_id: m.rowId,
      project_id: "proj-1",
      punch_kind: "In",
      device_time: new Date(T0).toISOString(),
      results: [
        { ...punches[0], outcome: "applied", code: null },
        { ...punches[1], outcome: "refused", code: "punch_already_in" },
      ],
    };
    const client = {
      rpc: () => Promise.resolve({ data: answer, error: null, status: 200 }),
    } as unknown as SupabaseClient;
    const store = new MemoryStore();
    const engine = new SyncEngine({
      store,
      uploader: new SupabaseUploader({
        client,
        functionsUrl: "https://x.example.com",
        accessToken: () => Promise.resolve(null),
        orgId: () => null,
        deviceId: "device-1",
        clock,
      }),
      schedule: () => () => undefined,
    });
    await engine.outbox.enqueue(m);
    await engine.setNetwork(ONLINE);
    const rows = (await store.list(TEAM_PUNCH_TABLE)) as unknown as TeamPunchBatch[];
    const onBoard = rows.filter((b) => b.project_id === "proj-1");
    expect(onBoard).toHaveLength(1);
    expect(onBoard[0]?.punch_kind).toBe("In");
    expect(onBoard[0]?.results.map((r) => r.outcome)).toEqual(["applied", "refused"]);
    const board = [
      held("shift-a", { roster_entry_id: "re1" }),
      held("shift-b", { roster_entry_id: "re2" }),
    ];
    // Not yet downloaded: the applied punch shows In, the refused one changes nothing.
    const state = teamClockState(board, [], [], onBoard);
    expect(state.get("shift-a")).toBe("in");
    expect(state.get("shift-b")).toBe("out");
    expect(primaryTeamPunch(["shift-a", "shift-b"], state)).toBe("Out");
  });
});

/** A shift on the board that someone holds, today. */
function held(id: string, extra: Partial<TeamShiftRow> = {}): TeamShiftRow {
  return {
    id,
    project_id: "proj-1",
    starts_at: new Date(T0 - 3600_000).toISOString(),
    ends_at: new Date(T0 + 7 * 3600_000).toISOString(),
    shift_state: "Published",
    ...extra,
  };
}

describe("the team's clock state", () => {
  const batch = (
    id: string,
    kind: "In" | "Out",
    at: number,
    outcomes: Record<string, string>,
  ): TeamPunchBatch => ({
    id,
    punch_kind: kind,
    project_id: "proj-1",
    device_time: new Date(at).toISOString(),
    results: Object.entries(outcomes).map(([shift_id, outcome]) => ({
      punch_id: `${id}-${shift_id}`,
      shift_id,
      outcome: outcome as TeamPunchBatch["results"][number]["outcome"],
      code: outcome === "refused" ? "punch_already_in" : null,
    })),
  });

  const board = [
    held("shift-a", { membership_id: "m1" }),
    held("shift-b", { engagement_id: "e1" }),
    held("shift-c", { roster_entry_id: "re1" }),
  ];

  it("follows this device's punches until the download brings them back", () => {
    const state = teamClockState(
      board,
      [],
      [],
      [
        batch("b2", "Out", T0 + 60_000, { "shift-a": "applied" }),
        batch("b1", "In", T0, { "shift-a": "applied", "shift-b": "pending", "shift-c": "refused" }),
      ],
    );
    expect(state.get("shift-a")).toBe("out");
    expect(state.get("shift-b")).toBe("in");
    expect(state.get("shift-c")).toBe("out");
  });

  it("reads who is in from the synced time, whoever punched it", () => {
    // Staff Two clocked in on their own phone; nobody on this device punched anyone.
    const entries = [
      { project_id: "proj-1", roster_entry_id: "re1", clock_in: new Date(T0).toISOString() },
      {
        project_id: "proj-1",
        membership_id: "m1",
        clock_in: new Date(T0 - 7200_000).toISOString(),
        clock_out: new Date(T0 - 3600_000).toISOString(),
      },
      { project_id: "proj-2", engagement_id: "e1", clock_in: new Date(T0).toISOString() },
    ];
    const state = teamClockState(board, entries, [], []);
    expect(state.get("shift-c")).toBe("in");
    expect(state.get("shift-a")).toBe("out");
    expect(state.get("shift-b")).toBe("out");
    expect(primaryTeamPunch(["shift-c"], state)).toBe("Out");
  });

  it("lets the synced time win once a team punch is back from the server", () => {
    const b = batch("b1", "In", T0, { "shift-c": "applied" });
    const closed = [
      {
        project_id: "proj-1",
        shift_id: "shift-c",
        clock_in: new Date(T0).toISOString(),
        clock_out: new Date(T0 + 3600_000).toISOString(),
      },
    ];
    // The punch is downloaded, and the entry it opened has since been closed on another device.
    expect(teamClockState(board, closed, [{ id: "b1-shift-c" }], [b]).get("shift-c")).toBe("out");
    // A newer synced entry also wins over a punch the download never returned.
    expect(teamClockState(board, closed, [], [b]).get("shift-c")).toBe("out");
  });

  it("leads with Clock in while nobody selected is in, else Clock out", () => {
    const state = new Map<string, "in" | "out">([["shift-a", "in"]]);
    expect(primaryTeamPunch(["shift-b"], state)).toBe("In");
    expect(primaryTeamPunch(["shift-a", "shift-b"], state)).toBe("Out");
    expect(primaryTeamPunch([], state)).toBe("In");
  });

  it("lists today's held shifts of the project, never open shifts or agency slots", () => {
    const shift = (id: string, extra: Record<string, unknown>) => ({
      id,
      project_id: "proj-1",
      starts_at: new Date(T0 - 3600_000).toISOString(),
      ends_at: new Date(T0 + 7 * 3600_000).toISOString(),
      shift_state: "Published",
      ...extra,
    });
    const rows = [
      shift("member", { membership_id: "m1" }),
      shift("roster", { roster_entry_id: "re1", holder_name: "Staff One" }),
      shift("open", {}),
      shift("slot", { engagement_id: "eng", is_agency_slot: true }),
      shift("canceled", { membership_id: "m2", shift_state: "Canceled" }),
      shift("other", { membership_id: "m3", project_id: "proj-2" }),
      {
        ...shift("tomorrow", { membership_id: "m4" }),
        starts_at: new Date(T0 + 30 * 3600_000).toISOString(),
      },
    ];
    expect(teamShifts(rows, "proj-1", T0).map((s) => s.id)).toEqual(["member", "roster"]);
  });
});

describe("clock.team access", () => {
  const summary = (overrides: Partial<EngagementSummary>): EngagementSummary => ({
    id: "e1",
    orgId: "o1",
    orgName: "Demo Org",
    projectId: "proj-1",
    projectName: "Demo",
    roleType: "staff",
    state: "Active",
    via: "engagement",
    rosterEntryId: null,
    ...overrides,
  });
  const person = (
    audience: CompassIdentity["audience"],
    engagements: EngagementSummary[],
    capabilities: string[] = [],
  ) =>
    ({
      personId: "p",
      displayName: "Someone",
      audience,
      capabilities,
      membershipId: audience.startsWith("field") ? "m" : null,
      engagements,
    }) satisfies CompassIdentity;

  it("opens for a field supervisor with crew.shift.write, never for a field member", () => {
    expect(
      access(person("field-supervisor", [], ["crew.shift.write"]), "clock.team", "proj-1"),
    ).toEqual({
      allowed: true,
    });
    expect(access(person("field-supervisor", []), "clock.team", "proj-1")).toEqual({
      allowed: false,
      reason: "capability",
    });
    expect(access(person("field", [], ["crew.shift.write"]), "clock.team", "proj-1").allowed).toBe(
      false,
    );
  });

  it("opens for an agency lead, whose roster area is open, and not for a plain member", () => {
    const lead = person("staff", [summary({ areas: ["engagement", "operational", "roster"] })]);
    expect(access(lead, "clock.team", "proj-1")).toEqual({ allowed: true });
    const member = person("staff", [summary({ areas: ["engagement", "operational"] })]);
    expect(access(member, "clock.team", "proj-1")).toEqual({ allowed: false, reason: "role" });
    const closed = person("staff", [summary({ state: "Complete", areas: ["roster"] })]);
    expect(access(closed, "clock.team", "proj-1").allowed).toBe(false);
    const vendor = person("vendor", [summary({ roleType: "vendor", areas: ["roster"] })]);
    expect(access(vendor, "clock.team", "proj-1").allowed).toBe(false);
  });

  it("lets agency staff on a roster clock their own time, and no other roster member", () => {
    const agency = person("crew", [
      summary({ roleType: "crew", via: "roster", rosterEntryId: "re1", partyRoleType: "Staff" }),
    ]);
    expect(access(agency, "clock", "proj-1")).toEqual({ allowed: true });
    const vendorCrew = person("crew", [
      summary({ roleType: "crew", via: "roster", rosterEntryId: "re2", partyRoleType: "Vendor" }),
    ]);
    expect(access(vendorCrew, "clock", "proj-1")).toEqual({
      allowed: false,
      reason: "roster-member",
    });
  });
});

describe("the roster punch", () => {
  it("sends only the shift, with no membership and no engagement", () => {
    const m = buildPunch(
      "In",
      {
        projectId: "proj-1",
        shiftId: "shift-a",
        membershipId: null,
        engagementId: null,
        rosterEntryId: "re1",
        source: "Mobile",
      },
      stampEvent(clock, null),
      null,
      [],
      T0,
    );
    expect(m.payload).toMatchObject({
      p_shift_id: "shift-a",
      p_membership_id: null,
      p_engagement_id: null,
    });
    expect(m.optimistic).toMatchObject({ roster_entry_id: "re1", shift_id: "shift-a" });
  });

  it("needs the roster entry's shift, and exactly one worker", () => {
    const event = stampEvent(clock, null);
    expect(() =>
      buildPunch(
        "In",
        {
          projectId: "p",
          shiftId: null,
          membershipId: null,
          engagementId: null,
          rosterEntryId: "re1",
          source: "Mobile",
        },
        event,
        null,
        [],
        T0,
      ),
    ).toThrow("shift");
    expect(() =>
      buildPunch(
        "In",
        {
          projectId: "p",
          shiftId: "s",
          membershipId: null,
          engagementId: "e",
          rosterEntryId: "re1",
          source: "Mobile",
        },
        event,
        null,
        [],
        T0,
      ),
    ).toThrow("exactly one");
  });
});
