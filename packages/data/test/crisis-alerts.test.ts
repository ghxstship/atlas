import { describe, expect, it } from "vitest";
import {
  activeCrisisAlerts,
  type CrisisAlertNote,
  type CrisisAlertRow,
} from "../src/crisis-alerts.ts";
import { buildAlerts } from "../src/home.ts";

const A = "0193a000-0000-7000-8000-000000000001";
const B = "0193a000-0000-7000-8000-000000000002";
const NOW = new Date("2026-11-10T18:00:00Z");

const row = (over: Partial<CrisisAlertRow>): CrisisAlertRow => ({
  id: A,
  projectKey: "CAFX",
  emergencyCode: "RED",
  message: "Evacuate the north stage.",
  issuedAt: "2026-11-10T17:55:00Z",
  endedAt: null,
  deletedAt: null,
  ...over,
});

const note = (over: Partial<CrisisAlertNote>): CrisisAlertNote => ({
  kind: "crisis_alert.issued",
  subjectId: A,
  createdAt: "2026-11-10T17:55:01Z",
  args: { title: "Code Red", project: "Crawl Festival", message: "Evacuate the north stage." },
  ...over,
});

const labels = new Map([["RED", "Code Red"]]);

describe("activeCrisisAlerts (crawl 4.9: Home and the shell show an alert in force)", () => {
  it("shows an active alert row the person may read, with the code's label", () => {
    expect(activeCrisisAlerts({ rows: [row({})], notes: [], labels, now: NOW })).toEqual([
      {
        id: A,
        projectKey: "CAFX",
        projectName: null,
        title: "Code Red",
        message: "Evacuate the north stage.",
        issuedAt: "2026-11-10T17:55:00Z",
      },
    ]);
  });

  it("shows an alert the person was told of but may not read, until its all-clear reaches them", () => {
    const told = activeCrisisAlerts({ rows: [], notes: [note({})], labels, now: NOW });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      id: A,
      projectKey: null,
      projectName: "Crawl Festival",
      title: "Code Red",
    });
    expect(
      activeCrisisAlerts({
        rows: [],
        notes: [note({ kind: "crisis_alert.ended", createdAt: "2026-11-10T17:59:00Z" }), note({})],
        labels,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("lets a readable row decide: an ended alert is gone though no all-clear was sent to the person", () => {
    expect(
      activeCrisisAlerts({
        rows: [row({ endedAt: "2026-11-10T17:58:00Z" })],
        notes: [note({})],
        labels,
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      activeCrisisAlerts({
        rows: [row({ deletedAt: "2026-11-10T17:58:00Z" })],
        notes: [],
        labels,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("drops a notification older than a week, and lists newest first without duplicates", () => {
    expect(
      activeCrisisAlerts({
        rows: [],
        notes: [note({ createdAt: "2026-11-01T00:00:00Z" })],
        labels,
        now: NOW,
      }),
    ).toEqual([]);
    const both = activeCrisisAlerts({
      rows: [row({})],
      notes: [note({}), note({ subjectId: B, createdAt: "2026-11-10T17:57:00Z" })],
      labels,
      now: NOW,
    });
    expect(both.map((a) => a.id)).toEqual([B, A]);
    expect(both[1]?.projectName).toBe("Crawl Festival");
  });
});

describe("buildAlerts with crisis alerts", () => {
  it("puts a crisis alert in force first, as critical, opening the project's emergency codes", () => {
    const alerts = buildAlerts({
      readiness: [],
      blocked: [
        {
          id: "r1",
          key: "NWS-12",
          title: "Hang Lighting Truss",
          kind: "Task",
          state: "Blocked",
          dueAt: null,
          startsAt: null,
          endsAt: null,
          blocker: "Rigging",
          projectKey: "NWS",
          updatedAt: "2026-11-10T17:59:00Z",
        },
      ],
      overdue: [],
      today: "2026-11-10",
      crisis: activeCrisisAlerts({ rows: [row({})], notes: [], labels, now: NOW }),
    });
    expect(alerts.map((a) => a.kind)).toEqual(["crisisAlert", "blockedRecord"]);
    expect(alerts[0]).toMatchObject({
      id: `ca:${A}`,
      severity: "critical",
      projectKey: "CAFX",
      tab: "emergencyCodes",
      values: { title: "Code Red", project: "CAFX", message: "Evacuate the north stage." },
    });
  });
});
