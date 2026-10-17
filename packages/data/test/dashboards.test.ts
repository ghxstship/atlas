import { describe, expect, it } from "vitest";
import {
  addTile,
  createDashboard,
  createSchedule,
  listDashboards,
  listSchedules,
  nextSlot,
  setSchedulePaused,
} from "../src/dashboards.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("dashboards and report schedules (A38-004)", () => {
  it("finds the next free slot of the 12-column grid", () => {
    expect(nextSlot([], 6)).toEqual({ gridColumn: 1, gridRow: 1 });
    const half = { gridColumn: 1, gridRow: 1, columnSpan: 6, rowSpan: 1 };
    expect(nextSlot([half], 6)).toEqual({ gridColumn: 7, gridRow: 1 });
    expect(nextSlot([half, { ...half, gridColumn: 7 }], 6)).toEqual({ gridColumn: 1, gridRow: 2 });
    expect(nextSlot([half], 12)).toEqual({ gridColumn: 1, gridRow: 2 });
    expect(nextSlot([{ ...half, rowSpan: 2 }], 7)).toEqual({ gridColumn: 1, gridRow: 3 });
  });

  it("lists dashboards with their live tile counts and keeps them per member", async () => {
    const { db, calls } = fakeClient({
      "from:dashboards": [
        okResponse([
          {
            id: "d1",
            name: "Show Week",
            team_id: null,
            membership_id: "m1",
            tiles: [
              { id: "t1", deleted_at: null },
              { id: "t2", deleted_at: "2026-10-01" },
            ],
          },
        ]),
        okResponse({ id: "d2" }),
      ],
    });
    const list = await listDashboards(db, { orgId: "o1", membershipId: "m1" });
    expect(list.ok && list.data[0]).toEqual({
      id: "d1",
      name: "Show Week",
      teamId: null,
      mine: true,
      tileCount: 1,
    });
    const created = await createDashboard(db, { orgId: "o1", membershipId: "m1", name: " Ops " });
    expect(created).toEqual({ ok: true, data: { id: "d2" } });
    expect(calls[1]?.steps.find((s) => s[0] === "insert")?.[1]).toEqual([
      { org_id: "o1", name: "Ops", membership_id: "m1" },
    ]);
  });

  it("places a tile after the existing ones", async () => {
    const { db, calls } = fakeClient({
      "from:dashboard_tiles": [
        okResponse([
          {
            id: "t1",
            dashboard_id: "d1",
            report_definition_id: "r1",
            grid_column: 1,
            grid_row: 1,
            column_span: 6,
            row_span: 1,
            report: { name: "Spend" },
          },
        ]),
        okResponse({ id: "t2" }),
      ],
    });
    const tile = await addTile(db, {
      orgId: "o1",
      dashboardId: "d1",
      reportDefinitionId: "r2",
      columnSpan: 6,
    });
    expect(tile).toEqual({ ok: true, data: { id: "t2" } });
    expect(calls[1]?.steps.find((s) => s[0] === "insert")?.[1]).toEqual([
      {
        org_id: "o1",
        dashboard_id: "d1",
        report_definition_id: "r2",
        grid_column: 7,
        grid_row: 1,
        column_span: 6,
        row_span: 1,
      },
    ]);
  });

  it("schedules a report with recipients and reads it back", async () => {
    const { db } = fakeClient({
      "from:report_schedules": [
        okResponse({ id: "s1" }),
        okResponse([
          {
            id: "s1",
            report_definition_id: "r1",
            cadence: "Weekly",
            local_hour: 8,
            weekday: 1,
            month_day: null,
            time_zone: "America/New_York",
            export_format: "PDF",
            next_run_at: "2026-10-19T12:00:00Z",
            paused_at: null,
            recipients: [
              { id: "x1", membership_id: "m1", deleted_at: null },
              { id: "x2", membership_id: "m2", deleted_at: "2026-10-01" },
            ],
          },
        ]),
        errorResponse("42501", "permission denied"),
      ],
      "from:report_schedule_recipients": [okResponse({ id: "x1" })],
    });
    const created = await createSchedule(db, {
      orgId: "o1",
      reportDefinitionId: "r1",
      cadence: "Weekly",
      localHour: 8,
      weekday: 1,
      monthDay: 15,
      timeZone: "America/New_York",
      format: "PDF",
      recipientMembershipIds: ["m1"],
    });
    expect(created).toEqual({ ok: true, data: { id: "s1" } });
    const list = await listSchedules(db, "r1");
    expect(list.ok && list.data[0]?.recipients).toEqual([{ id: "x1", membershipId: "m1" }]);
    expect((await setSchedulePaused(db, "s1", true)).ok).toBe(false);
  });
});
