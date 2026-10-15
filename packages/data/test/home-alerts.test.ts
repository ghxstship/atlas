import { describe, expect, it } from "vitest";
import type { GateReadiness, HomeRecord } from "../src/home";
import type { ProjectSummary } from "../src/projects";
import { buildAlerts } from "../src/home";

const project = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: "p1",
  key: "NWS",
  name: "Northwind Summer Series",
  description: null,
  currency: "USD",
  projectState: "Active",
  productionState: "Active",
  phaseCode: "ENG",
  jurisdictionId: "US-FL-MIAMI-DADE",
  regionCode: null,
  tierCode: null,
  timeZone: "America/New_York",
  startsOn: null,
  endsOn: null,
  venueId: null,
  venueName: null,
  workspaceId: null,
  archivedAt: null,
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

const readiness = (p: ProjectSummary, unmet: number, gate = 2): GateReadiness => ({
  project: p,
  phase: { code: p.phaseCode, gate, name: "", actCode: "PLAN", definition: "", gateExit: "" },
  blockingTotal: 2,
  blockingMet: 2 - unmet,
  advisoryTotal: 0,
  advisoryMet: 0,
  unmet: Array.from({ length: unmet }, (_, i) => ({
    id: `G${gate}.X${i}`,
    gate,
    ordinal: i,
    statement: "s",
    blocking: true,
  })),
  closed: false,
});

const record = (over: Partial<HomeRecord>): HomeRecord => ({
  id: "r1",
  key: "NWS-12",
  title: "Hang Lighting Truss",
  kind: "Task",
  state: "Blocked",
  dueAt: null,
  startsAt: null,
  endsAt: null,
  blocker: "Truss delivery late",
  projectKey: "NWS",
  updatedAt: "2026-10-10T00:00:00Z",
  ...over,
});

describe("home alerts", () => {
  it("raises nothing for a healthy project", () => {
    expect(
      buildAlerts({
        readiness: [readiness(project({}), 0)],
        blocked: [],
        overdue: [],
        today: "2026-10-14",
      }),
    ).toEqual([]);
  });

  it("raises gate gaps only within 30 days of the first production day", () => {
    const soon = project({ id: "a", key: "AAA", startsOn: "2026-11-01" });
    const later = project({ id: "b", key: "BBB", startsOn: "2027-03-12" });
    const past = project({ id: "c", key: "CCC", startsOn: "2026-10-01" });
    const alerts = buildAlerts({
      readiness: [readiness(soon, 1), readiness(later, 1), readiness(past, 1)],
      blocked: [],
      overdue: [],
      today: "2026-10-14",
    });
    expect(alerts.map((a) => a.id)).toEqual(["gg:a"]);
    expect(alerts[0]).toMatchObject({ tab: "gates", values: { count: 1, gate: 2 } });
  });

  it("raises blocked projects and records first, then watches", () => {
    const alerts = buildAlerts({
      readiness: [
        readiness(project({ id: "b", projectState: "Blocked" }), 0),
        readiness(project({ id: "j", key: "NJR", jurisdictionId: null }), 0),
        readiness(project({ id: "s", key: "SCP", jurisdictionId: null, phaseCode: "SCP" }), 0, 1),
      ],
      blocked: [record({})],
      overdue: [record({ id: "o", state: "Active", dueAt: "2026-10-12T17:00:00Z" })],
      today: "2026-10-14",
    });
    expect(alerts.map((a) => `${a.severity}:${a.kind}`)).toEqual([
      "high:blockedRecord",
      "high:blockedProject",
      "medium:overdue",
      "medium:noJurisdiction",
    ]);
  });
});
