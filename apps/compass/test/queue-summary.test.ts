import { getMessages } from "@xos/i18n";
import { stampEvent, type DeviceClock, type Mutation, type MutationInput } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { buildPunch } from "../src/domain/clock";
import { buildReport } from "../src/domain/incidents";
import { buildKioskPunch } from "../src/domain/kiosk";
import {
  refusalReason,
  summarizeMutation,
  summarizeServerRow,
  type QueueSummary,
  type SummaryContext,
} from "../src/domain/queue-summary";
import { buildAccessScan, buildAssetScan, buildIntake } from "../src/domain/scan";
import { buildShiftAction } from "../src/domain/shifts";
import { buildCallCue } from "../src/domain/show";
import { WORKFORCE_SYNC_RPCS, workforceWrite } from "../src/workforce/writes";

const T0 = Date.UTC(2026, 9, 16, 2, 51, 30);
const PROJECT = "01920000-0000-7000-8000-000000001001";
const BOOT = "01a1478a-5b2c-4d6e-8f90-123456789abc";
const clock: DeviceClock = {
  wallNow: () => T0,
  monotonicNow: () => 1297914530.3655,
  bootId: () => BOOT,
};
const ctx: SummaryContext = {
  time: (iso) => new Date(iso).toISOString().slice(11, 16),
  day: (iso) => new Date(iso).toISOString().slice(0, 10),
  projectName: (id) => (id === PROJECT ? "Northwind Summer Series" : null),
  zoneName: (id) => (id === "zone-gate" ? "Main Gate" : null),
  punchAction: (kind) => `[${kind}]`,
  kind: (table) => `<${table}>`,
};
let n = 0;
const newId = () => `0199ffff-0000-7000-8000-${String(++n).padStart(12, "0")}`;

function queued(input: MutationInput): Mutation {
  return {
    id: newId(),
    seq: 1,
    op: input.op,
    target: input.target ?? input.table,
    table: input.table,
    rowId: input.rowId,
    payload: input.payload,
    base: (input.optimistic as Mutation["base"]) ?? null,
    policy: input.policy ?? "append",
    dependsOn: [],
    queuedAt: new Date(T0).toISOString(),
    attempts: 1,
    nextAttemptAt: T0,
    status: "conflict",
    lastError: null,
    serverRow: null,
  };
}

type Catalog = {
  compass: { queue: { summary: Record<string, string> } & Record<string, unknown> };
};
const en = (getMessages("en-US") as unknown as Catalog).compass;
const es = (getMessages("es-US") as unknown as Catalog).compass;

/** Every sentence has a catalog entry in both locales, and no value leaks a device field or an id. */
function readable(s: QueueSummary): string {
  expect(en.queue.summary[s.key], `en-US compass.queue.summary.${s.key}`).toBeTypeOf("string");
  expect(es.queue.summary[s.key], `es-US compass.queue.summary.${s.key}`).toBeTypeOf("string");
  const sentence = (en.queue.summary[s.key] ?? "").replace(/\{(\w+)\}/g, (_, k: string) => {
    expect(s.values[k], `value ${k} for ${s.key}`).toBeTypeOf("string");
    return s.values[k] ?? "";
  });
  expect(sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  expect(sentence).not.toMatch(/monotonic|boot|p_[a-z]|1297914530/);
  return sentence;
}

describe("offline queue summaries (SIM-002)", () => {
  it("reads a refused clock-in as an action, a wall time and the project, never device fields", () => {
    const input = buildPunch(
      "In",
      {
        projectId: PROJECT,
        shiftId: null,
        membershipId: "mem-1",
        engagementId: null,
        source: "Mobile",
      },
      stampEvent(clock, null),
      null,
      [],
      T0,
      newId,
    );
    const m = queued(input);
    expect(readable(summarizeMutation(m, ctx))).toBe("[In] at 02:51, Northwind Summer Series");
    expect(
      summarizeServerRow(
        "clock_punches",
        {
          id: "x",
          punch_kind: "Out",
          effective_at: new Date(T0).toISOString(),
          project_id: PROJECT,
        },
        ctx,
      ),
    ).toEqual({
      key: "punch",
      values: { action: "[Out]", time: "02:51", project: "Northwind Summer Series" },
    });
  });

  it("drops the project when the device does not know it", () => {
    const m = queued({
      op: "rpc",
      target: "app.record_punch",
      table: "clock_punches",
      rowId: "r",
      payload: {
        p_punch_kind: "Out",
        p_device_time: new Date(T0).toISOString(),
        p_project_id: "x",
      },
    });
    expect(readable(summarizeMutation(m, ctx))).toBe("[Out] at 02:51");
  });

  it("names the kiosk punch without its PIN", () => {
    const m = queued(
      buildKioskPunch(
        {
          deviceKey: "device-key",
          projectId: PROJECT,
          worker: {
            membershipId: "mem-1",
            name: "Demo Field Lead",
            clockedIn: false,
          } as never,
          pin: "4821",
          deviceAt: new Date(T0).toISOString(),
          monotonicAt: 1297914530.3655,
          bootId: BOOT,
          photoUri: null,
        },
        T0,
        newId,
      ),
    );
    const text = readable(summarizeMutation(m, ctx));
    expect(text).toBe("[In] at 02:51 on the kiosk");
    expect(text).not.toContain("4821");
  });

  it("describes shift accept and claim from the shift the device held", () => {
    const shift = {
      id: "s1",
      project_id: PROJECT,
      starts_at: "2026-10-16T10:00:00Z",
      ends_at: "2026-10-17T02:00:00Z",
      shift_state: "Published",
    };
    expect(readable(summarizeMutation(queued(buildShiftAction(shift, "accept", false)), ctx))).toBe(
      "Accept the shift on 2026-10-16, 10:00 to 02:00",
    );
    const claim = queued(buildShiftAction(shift, "claim", false, "mem-1"));
    expect(readable(summarizeMutation(claim, ctx))).toContain("Claim the open shift");
    expect(readable(summarizeMutation({ ...claim, base: null }, ctx))).toBe("Claim an open shift");
    expect(
      readable(summarizeServerRow("shifts", { ...shift, shift_state: "Accepted" } as never, ctx)),
    ).toBe("Shift on 2026-10-16 at 10:00, now Accepted");
  });

  it("describes an offline incident, its photo, its voice note and its party", () => {
    const writes = buildReport(
      {
        id: "inc-1",
        orgId: "org-1",
        projectId: PROJECT,
        title: "Guest slipped at the bar",
        severityId: "sev-1",
        zoneId: null,
        occurredAt: new Date(T0).toISOString(),
        fix: null,
        photos: [{ id: "ph-1", uri: "file:///photo.jpg", capturedAt: new Date(T0).toISOString() }],
        voiceNotes: [
          {
            id: "vn-1",
            uri: "file:///note.m4a",
            capturedAt: new Date(T0).toISOString(),
            durationMs: 14_000,
          },
        ],
        parties: [{ id: "pa-1", personId: null, description: "Bartender on shift" }],
      } as never,
      T0,
      newId,
    );
    const sentences = writes.map((w) => readable(summarizeMutation(queued(w), ctx)));
    expect(sentences).toEqual([
      'Report "Guest slipped at the bar" at 02:51',
      "Incident photo taken at 02:51",
      "Incident voice note (0:14) recorded at 02:51",
      "Person involved: Bartender on shift",
    ]);
    expect(sentences.join(" ")).not.toContain("file://");
    expect(
      readable(
        summarizeServerRow(
          "incidents",
          { id: "inc-1", title: "Guest slipped at the bar", incident_state: "Dispatched" },
          ctx,
        ),
      ),
    ).toBe("Guest slipped at the bar, now Dispatched");
  });

  it("describes scans, custody, cues and workforce writes", () => {
    const credential = { id: "cred-1" } as never;
    const scan = queued(
      buildAccessScan(
        credential,
        "zone-gate",
        { result: "Granted" } as never,
        new Date(T0).toISOString(),
        T0,
        newId,
      ),
    );
    expect(readable(summarizeMutation(scan, ctx))).toBe("Credential scan at Main Gate, 02:51");
    expect(
      readable(
        summarizeMutation({ ...scan, payload: { ...scan.payload, p_zone_id: "elsewhere" } }, ctx),
      ),
    ).toBe("Credential scan at 02:51");
    const intake = queued(
      buildIntake(
        "0123456789",
        "ean13" as never,
        {
          orgId: "org-1",
          projectId: PROJECT,
          mode: "receive",
          deviceAt: new Date(T0).toISOString(),
        } as never,
        T0,
        newId,
      ),
    );
    expect(readable(summarizeMutation(intake, ctx))).toContain("Unknown code 0123456789");
    const asset = {
      orgId: "org-1",
      code: "AUD-0042",
      unitId: "u1",
      custodianMembershipId: "mem-1",
      custodianEngagementId: null,
      venueId: null,
      projectId: PROJECT,
      note: null,
    };
    expect(
      readable(
        summarizeMutation(
          queued(buildAssetScan({ ...asset, action: "check-out" } as never, T0, newId)),
          ctx,
        ),
      ),
    ).toBe("Check out AUD-0042");
    expect(
      readable(
        summarizeMutation(
          queued(buildAssetScan({ ...asset, action: "check-in" } as never, T0, newId)),
          ctx,
        ),
      ),
    ).toBe("Return AUD-0042");
    const cue = {
      id: "c1",
      run_of_show_id: "r1",
      position: 1,
      label: "Doors",
      planned_at: null,
      duration: null,
      called_at: null,
    };
    expect(readable(summarizeMutation(queued(buildCallCue(cue, T0)), ctx))).toBe(
      "Call the cue Doors",
    );
    expect(
      readable(summarizeServerRow("cues", { ...cue, called_at: new Date(T0).toISOString() }, ctx)),
    ).toBe("Doors, called at 02:51");
    const chat = queued(
      workforceWrite(
        "send_chat_message",
        { p_conversation_id: "c", p_body: "On my way" },
        T0,
        newId,
      ),
    );
    expect(readable(summarizeMutation(chat, ctx))).toBe("Message: On my way");
    const vote = queued(workforceWrite("vote_in_poll", { p_poll_id: "p" }, T0, newId));
    expect(readable(summarizeMutation(vote, ctx))).toBe("<poll_votes>, saved at 02:51");
  });

  it("describes inspections, logistics and anything else with its kind, never its columns", () => {
    const start = queued({
      op: "insert",
      table: "inspections",
      rowId: "i1",
      payload: { id: "i1", inspected_at: new Date(T0).toISOString() },
    });
    expect(readable(summarizeMutation(start, ctx))).toBe("Inspection started at 02:51");
    expect(readable(summarizeMutation({ ...start, op: "update", payload: {} }, ctx))).toBe(
      "Sign off the inspection",
    );
    expect(
      readable(summarizeMutation({ ...start, table: "inspection_results", payload: {} }, ctx)),
    ).toBe("Inspection answer");
    const rpc = (target: string, payload: Record<string, unknown>, table = "gate_queue") =>
      readable(summarizeMutation(queued({ op: "rpc", target, table, rowId: "r", payload }), ctx));
    expect(rpc("app.record_gate_arrival", { p_vehicle_identifier: "FL ABC123" })).toBe(
      "Gate arrival for FL ABC123",
    );
    expect(rpc("app.release_vehicle", {})).toBe("Release the vehicle from the gate");
    expect(rpc("app.check_in_dock_slot", {}, "dock_slots")).toBe("Check in at the dock slot");
    expect(rpc("app.add_marshalling_entry", { p_entry: "Truck 4 staged" }, "marshalling_log")).toBe(
      "Marshalling log: Truck 4 staged",
    );
    expect(rpc("app.transition_fulfillment", { p_next: "Delivered" }, "fulfillments")).toBe(
      "Move the fulfillment to Delivered",
    );
    expect(rpc("app.transition_incident", { p_next: "Contained" }, "incidents")).toBe(
      "Move the incident to Contained",
    );
    expect(rpc("app.call_cue", {}, "cues")).toBe("Call a cue");
    expect(rpc("app.report_incident", {}, "incidents")).toBe("<incidents>, saved at 02:51");
    expect(rpc("app.unknown_rpc", { p_secret: "x" }, "things")).toBe("<things>, saved at 02:51");
    expect(readable(summarizeServerRow("things", { id: "x", p_secret: "y" }, ctx))).toBe(
      "The server holds a different version of this <things>.",
    );
  });
});

describe("refusal reasons in words (simulator defect: raw RLS text in the queue)", () => {
  it("shows a rule refusal's sentence without its rule code", () => {
    expect(
      refusalReason({
        code: "XR001",
        message: "time_entry_overlap: Time entries of one person cannot overlap.",
      }),
    ).toEqual({
      key: "refusedReason",
      values: { reason: "Time entries of one person cannot overlap." },
    });
  });
  it("turns a permission refusal into a plain sentence", () => {
    const r = refusalReason({
      code: "42501",
      message: 'new row violates row-level security policy for table "inspections"',
    });
    expect(r).toEqual({ key: "refusedPermission", values: {} });
    expect(en.queue).toHaveProperty("refusedPermission");
    expect(es.queue).toHaveProperty("refusedPermission");
  });
  it("never shows raw database wording", () => {
    expect(
      refusalReason({
        code: "23502",
        message: 'null value in column "org_id" violates not-null constraint',
      }).key,
    ).toBe("refusedTechnical");
    expect(refusalReason({ code: "400", message: "" }).key).toBe("refusedTechnical");
    expect(en.queue).toHaveProperty("refusedTechnical");
    expect(es.queue).toHaveProperty("refusedTechnical");
  });
});

describe("queue names (simulator defect: a form read form_submissions)", () => {
  it("names every workforce table a queued write can belong to, in each locale", () => {
    type Kinds = { compass: { queue: { kinds: Record<string, string> } } };
    const tables = WORKFORCE_SYNC_RPCS.map((rpc) => workforceWrite(rpc, {}, 0, () => "id").table);
    for (const locale of ["en-US", "es-US"] as const) {
      const kinds = (getMessages(locale) as unknown as Kinds).compass.queue.kinds;
      expect(tables.filter((t) => typeof kinds[t] !== "string")).toEqual([]);
    }
  });
  it("keeps native exception text out of refusals", () => {
    expect(
      refusalReason({
        code: "0",
        message:
          "fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)",
      }).key,
    ).toBe("refusedTechnical");
  });
});
