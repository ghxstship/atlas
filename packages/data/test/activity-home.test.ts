import { describe, expect, it } from "vitest";
import { listActivity, listAuditEvents } from "../src/activity";
import {
  listBlockedRecords,
  listMyOverdueRecords,
  listMyRecordsBetween,
  listRecentRecords,
  summarizeReadiness,
} from "../src/home";
import type { CriterionStatus, GateCriterion, Phase, ProjectSummary } from "../src/projects";
import { errorResponse, fakeClient, okResponse } from "./fake-client";

const FEED_ROW = {
  id: "a1",
  occurred_at: "2026-10-14T10:00:00Z",
  event_type: "project.state_changed",
  subject_table: "projects",
  subject_id: "p1",
  project_id: "p1",
  project_key: "NWL",
  project_name: "Northwind Summer Series",
  actor_person_id: "x",
  actor_name: "Ada",
  record_key: null,
  record_title: null,
  data: { from_state: "Proposed", to_state: "Active" },
};

describe("activity", () => {
  it("reads the feed through the RPC and pages by time", async () => {
    const { db, calls } = fakeClient({
      "rpc:activity_feed": [
        okResponse([FEED_ROW, { ...FEED_ROW, id: "a2", project_id: null, data: null }]),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
    });
    const page = await listActivity(db, { orgId: "o1", projectId: "p1", limit: 2 });
    expect(page.ok && page.data.next).toBe("2026-10-14T10:00:00Z");
    expect(page.ok && page.data.entries[0]).toMatchObject({
      type: "project.state_changed",
      actor: "Ada",
      project: { key: "NWL" },
    });
    expect(page.ok && page.data.entries[1]).toMatchObject({ project: null, data: {} });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_project_id: "p1", p_before: null, p_limit: 2 }],
    ]);
    expect(await listActivity(db, { orgId: "o1", before: "2026-10-01" })).toEqual({
      ok: true,
      data: { entries: [], next: null },
    });
    expect(await listActivity(db, { orgId: "o1" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("reads the audit ledger", async () => {
    const row = {
      id: "e1",
      created_at: "2026-10-14T10:00:00Z",
      actor_kind: "Person",
      action: "projects.update",
      subject_table: "projects",
      subject_id: "p1",
      diff: null,
      redacted_at: null,
      actor: { full_name: "Ada" },
    };
    const { db, calls } = fakeClient({
      "from:audit_events": [
        okResponse([row]),
        okResponse([{ ...row, actor: null, redacted_at: "2026-10-14" }]),
        errorResponse("XX000", "x"),
      ],
    });
    const page = await listAuditEvents(db, { orgId: "o1", limit: 1 });
    expect(page).toEqual({
      ok: true,
      data: {
        entries: [
          {
            id: "e1",
            at: "2026-10-14T10:00:00Z",
            actorKind: "Person",
            actor: "Ada",
            action: "projects.update",
            subjectTable: "projects",
            subjectId: "p1",
            diff: {},
            redacted: false,
          },
        ],
        next: "2026-10-14T10:00:00Z",
      },
    });
    const older = await listAuditEvents(db, { orgId: "o1", before: "2026-10-14T10:00:00Z" });
    expect(older.ok && older.data.entries[0]).toMatchObject({ actor: null, redacted: true });
    expect(older.ok && older.data.next).toBe(null);
    expect(calls[1]?.steps).toContainEqual(["lt", ["created_at", "2026-10-14T10:00:00Z"]]);
    expect((await listAuditEvents(db, { orgId: "o1" })).ok).toBe(false);
  });
});

const RECORD = {
  id: "r1",
  record_display_key: "NWL-12",
  title: "Hang Lighting Truss",
  record_kind: "Task",
  record_state: "Blocked",
  due_at: "2026-10-14T18:00:00Z",
  starts_at: null,
  ends_at: null,
  blocker_text: "Truss delivery late",
  updated_at: "2026-10-14T09:00:00Z",
  project: { project_key: "NWL" },
};

describe("home records", () => {
  it("reads today, overdue, blocked and recent records", async () => {
    const { db, calls } = fakeClient({
      "from:records": [
        okResponse([RECORD]),
        errorResponse("XX000", "x"),
        okResponse([{ ...RECORD, project: null }]),
        errorResponse("XX000", "x"),
        okResponse([RECORD]),
        errorResponse("XX000", "x"),
        okResponse([RECORD]),
        errorResponse("XX000", "x"),
      ],
    });
    const window = {
      orgId: "o1",
      personId: "x",
      from: new Date("2026-10-14T00:00:00Z"),
      to: new Date("2026-10-15T00:00:00Z"),
    };
    expect(await listMyRecordsBetween(db, window)).toEqual({
      ok: true,
      data: [
        {
          id: "r1",
          key: "NWL-12",
          title: "Hang Lighting Truss",
          kind: "Task",
          state: "Blocked",
          dueAt: "2026-10-14T18:00:00Z",
          startsAt: null,
          endsAt: null,
          blocker: "Truss delivery late",
          projectKey: "NWL",
          updatedAt: "2026-10-14T09:00:00Z",
        },
      ],
    });
    expect(calls[0]?.steps).toContainEqual([
      "or",
      ["owner_party_id.eq.x,accountable_party_id.eq.x"],
    ]);
    expect((await listMyRecordsBetween(db, window)).ok).toBe(false);
    const overdue = await listMyOverdueRecords(db, { orgId: "o1", personId: "x", now: window.to });
    expect(overdue.ok && overdue.data[0]?.projectKey).toBe(null);
    expect(
      (await listMyOverdueRecords(db, { orgId: "o1", personId: "x", now: window.to })).ok,
    ).toBe(false);
    expect((await listBlockedRecords(db, "o1")).ok).toBe(true);
    expect((await listBlockedRecords(db, "o1")).ok).toBe(false);
    expect((await listRecentRecords(db, { orgId: "o1", personId: "x" })).ok).toBe(true);
    expect((await listRecentRecords(db, { orgId: "o1", personId: "x", limit: 5 })).ok).toBe(false);
  });
});

describe("gate readiness", () => {
  const project = (id: string, phaseCode: string) =>
    ({ id, key: id.toUpperCase(), name: id, phaseCode }) as unknown as ProjectSummary;
  const phases: Phase[] = [
    { code: "SCP", gate: 1, name: "Scope", actCode: "PLAN", definition: "", gateExit: "" },
    { code: "ENG", gate: 2, name: "Engage", actCode: "PLAN", definition: "", gateExit: "" },
  ];
  const criteria: GateCriterion[] = [
    { id: "G1.A", gate: 1, ordinal: 1, statement: "a", blocking: true },
    { id: "G1.B", gate: 1, ordinal: 2, statement: "b", blocking: true },
    { id: "G1.C", gate: 1, ordinal: 3, statement: "c", blocking: false },
    { id: "G2.A", gate: 2, ordinal: 4, statement: "d", blocking: true },
  ];
  const status = (
    projectId: string,
    criterionId: string,
    gate: number,
    evidenceCount: number,
    gatePassed = false,
  ): CriterionStatus => ({
    projectId,
    criterionId,
    gate,
    blocking: true,
    evidenceCount,
    bestRank: evidenceCount > 0 ? 4 : null,
    gatePassed,
  });

  it("counts met criteria of the current gate and names the unmet blocking ones", () => {
    const [scope] = summarizeReadiness([project("p1", "SCP")], phases, criteria, [
      status("p1", "G1.A", 1, 1),
      status("p1", "G1.B", 1, 0),
      status("p1", "G1.C", 1, 2),
    ]);
    expect(scope).toMatchObject({
      blockingTotal: 2,
      blockingMet: 1,
      advisoryTotal: 1,
      advisoryMet: 1,
      closed: false,
    });
    expect(scope?.unmet.map((c) => c.id)).toEqual(["G1.B"]);
  });

  it("treats a project past its last gate as closed and an unknown phase as no gate", () => {
    const [closed, unknown] = summarizeReadiness(
      [project("p2", "ENG"), project("p3", "ZZZ")],
      phases,
      criteria,
      [status("p2", "G2.A", 2, 0, true)],
    );
    expect(closed).toMatchObject({ closed: true, unmet: [] });
    expect(unknown).toMatchObject({ phase: null, blockingTotal: 0, closed: false });
  });
});
