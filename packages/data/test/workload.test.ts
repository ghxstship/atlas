import { describe, expect, it } from "vitest";
import {
  isOver,
  loadWorkload,
  settingInteger,
  workloadGrid,
  workloadStep,
} from "../src/workload.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/** The workload view (B4, G-45, migration 2935): the day limit (scheduling.workload_day_hours), steps and the grid. */

describe("the day limit", () => {
  it("is over only past the limit", () => {
    expect(isOver(10, 10)).toBe(false);
    expect(isOver(10.5, 10)).toBe(true);
    expect(isOver(0, 4)).toBe(false);
  });

  it("tints cells in four steps up to the limit", () => {
    expect([0, 2, 5, 8, 10, 14].map((h) => workloadStep(h, 10))).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it("reads the org's limit, with 10 hours when unset", async () => {
    const { db } = fakeClient({
      "rpc:workload": [
        okResponse([
          {
            person_id: "p1",
            person_name: "Frank",
            day: "2027-06-05",
            shift_minutes: 420,
            task_hours: "2.50",
            unestimated_tasks: 0,
            total_hours: "9.50",
          },
        ]),
      ],
      "rpc:resolve_settings": [
        okResponse([
          {
            setting_key: "scheduling.workload_day_hours",
            value_text: null,
            value_boolean: null,
            value_integer: 8,
            source: "Organization",
            locked: false,
          },
        ]),
      ],
    });
    const loaded = await loadWorkload(db, { orgId: "o1", from: "2027-06-01", to: "2027-06-07" });
    expect(loaded.ok && loaded.data.limit).toBe(8);
    expect(loaded.ok && loaded.data.cells[0]).toMatchObject({ taskHours: 2.5, totalHours: 9.5 });
    expect(settingInteger(new Map(), "scheduling.workload_day_hours", 10)).toBe(10);
  });

  it("lays people out by name against every day of the range", () => {
    const grid = workloadGrid(
      {
        limit: 10,
        cells: [
          {
            personId: "b",
            personName: "Zoe",
            day: "2027-06-02",
            shiftMinutes: 60,
            taskHours: 0,
            unestimatedTasks: 0,
            totalHours: 1,
          },
          {
            personId: "a",
            personName: "Ana",
            day: "2027-06-01",
            shiftMinutes: 60,
            taskHours: 0,
            unestimatedTasks: 0,
            totalHours: 1,
          },
        ],
      },
      "2027-06-01",
      "2027-06-03",
    );
    expect(grid.people.map((p) => p.name)).toEqual(["Ana", "Zoe"]);
    expect(grid.days).toEqual(["2027-06-01", "2027-06-02", "2027-06-03"]);
  });
});
