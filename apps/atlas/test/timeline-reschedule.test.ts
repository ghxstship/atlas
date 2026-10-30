import type { RescheduleMove, TimelineModel } from "@xos/data/schedule";
import type { TimelinePreview } from "@xos/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewer, previewOf, shiftsOf } from "@/components/schedule/reschedule-preview";
import { timelineView } from "@/components/schedule/timeline-view";
import { toActionError } from "@/components/work/action-result";

/** A bar for a record; the timeline helpers read only the record's id, key, title and state. */
function bar(
  id: string,
  key: string,
  start: number,
  end: number,
  extra: Partial<TimelineModel["bars"][number]> = {},
): TimelineModel["bars"][number] {
  return {
    record: { id, key, title: `Task ${key}`, state: "In Progress" } as never,
    start,
    end,
    milestone: false,
    ...extra,
  };
}

const bars = [
  bar("rec-a", "T-1", 2, 3),
  bar("rec-b", "T-2", 4, 4, { dependsOn: 0, locked: true }),
  bar("rec-c", "T-3", 6, 8, { baselineStart: 5, baselineEnd: 7 }),
];

function move(recordId: string, isTarget: boolean, start: number, end: number): RescheduleMove {
  return {
    recordId,
    isTarget,
    shiftStartDays: start,
    shiftEndDays: end,
    shiftStartMinutes: 0,
    shiftEndMinutes: 0,
    startsAt: null,
    endsAt: null,
    dueAt: null,
    oldStartsAt: null,
    oldEndsAt: null,
    oldDueAt: null,
    baselineStartsAt: null,
    baselineEndsAt: null,
  };
}

const copy = {
  error: (key: string) => `error:${key}`,
  offView: (count: number) => `${count} off view`,
};

describe("timeline reschedule: the server's answer as the Timeline's preview", () => {
  it("names the record and the whole days a change moves its start and end", () => {
    expect(shiftsOf(bars, { row: 0, start: 4, end: 5 })).toEqual({
      recordId: "rec-a",
      startDays: 2,
      endDays: 2,
    });
    expect(shiftsOf(bars, { row: 2, start: 6, end: 10 })).toEqual({
      recordId: "rec-c",
      startDays: 0,
      endDays: 2,
    });
    expect(shiftsOf(bars, { row: 9, start: 0, end: 0 })).toBeNull();
  });

  it("maps every moved record onto its bar by record id and counts the ones the view leaves out", () => {
    const change = { row: 0, start: 4, end: 5 };
    const preview = previewOf(
      bars,
      change,
      {
        ok: true,
        data: [
          move("rec-a", true, 2, 2),
          move("rec-c", false, 1, 1),
          move("rec-b", false, 2, 2),
          move("rec-hidden", false, 3, 3),
          move("rec-hidden-2", false, 1, 1),
        ],
      },
      copy,
    );
    expect(preview).toEqual({
      change,
      moves: [
        { row: 2, start: 7, end: 9 },
        { row: 1, start: 6, end: 6 },
      ],
      note: "2 off view",
    });
  });

  it("leaves the note out when every moved record is drawn, and turns a refusal into its catalog sentence", () => {
    const change = { row: 1, start: 5, end: 5 };
    expect(previewOf(bars, change, { ok: true, data: [move("rec-b", true, 1, 1)] }, copy)).toEqual({
      change,
      moves: [],
    });
    expect(
      previewOf(bars, change, { ok: false, error: { key: "rules.reschedule_locked" } }, copy),
    ).toEqual({ change, moves: [], refusal: "error:rules.reschedule_locked" });
    // A locked record the view leaves out is named by the database's sentence after the catalog's.
    expect(
      previewOf(
        bars,
        change,
        {
          ok: false,
          error: { key: "rules.reschedule_locked", detail: "NWL-4 Load-In Window is locked." },
        },
        copy,
      ),
    ).toEqual({
      change,
      moves: [],
      refusal: "error:rules.reschedule_locked NWL-4 Load-In Window is locked.",
    });
  });

  it("names the locked record and gives a canceled record its own sentence", () => {
    const refusal = (rule: string, message: string) =>
      toActionError({ kind: "refusal", rule, message });
    expect(refusal("reschedule_locked", "NWL-4 Load-In Window is locked.")).toEqual({
      key: "rules.reschedule_locked",
      detail: "NWL-4 Load-In Window is locked.",
    });
    expect(refusal("reschedule_canceled", "A canceled record stays where it was.")).toEqual({
      key: "rules.reschedule_canceled",
    });
  });
});

describe("timeline reschedule: previews on the server", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(
    run: (change: { row: number; start: number; end: number }) => Promise<TimelinePreview>,
  ) {
    vi.useFakeTimers();
    const shown: TimelinePreview[] = [];
    const previewer = createPreviewer({
      delayMs: 250,
      run: vi.fn(run),
      show: (p) => shown.push(p),
      failure: (change) => ({ change, moves: [], refusal: "failed" }),
    });
    return { previewer, shown };
  }

  it("asks once the keys rest, for the newest change only", async () => {
    const run = vi.fn((change: { row: number; start: number; end: number }) =>
      Promise.resolve({ change, moves: [] }),
    );
    const { previewer, shown } = setup(run);
    previewer.request({ row: 0, start: 3, end: 4 });
    await vi.advanceTimersByTimeAsync(100);
    previewer.request({ row: 0, start: 4, end: 5 });
    await vi.advanceTimersByTimeAsync(249);
    expect(shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown).toEqual([{ change: { row: 0, start: 4, end: 5 }, moves: [] }]);
  });

  it("drops an answer that arrives after a newer change, a cancel or a refresh", async () => {
    const answers: ((p: TimelinePreview) => void)[] = [];
    const { previewer, shown } = setup(
      () => new Promise<TimelinePreview>((resolve) => answers.push(resolve)),
    );
    const first = { row: 0, start: 3, end: 4 };
    const second = { row: 0, start: 4, end: 5 };
    previewer.request(first);
    await vi.advanceTimersByTimeAsync(250);
    previewer.request(second);
    await vi.advanceTimersByTimeAsync(250);
    // The second answer lands first; the first, arriving late, is stale.
    answers[1]?.({ change: second, moves: [] });
    answers[0]?.({ change: first, moves: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([{ change: second, moves: [] }]);

    previewer.request(first);
    await vi.advanceTimersByTimeAsync(250);
    previewer.request(null);
    answers[2]?.({ change: first, moves: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toHaveLength(1);

    previewer.request(second);
    await vi.advanceTimersByTimeAsync(250);
    previewer.dispose();
    answers[3]?.({ change: second, moves: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown).toHaveLength(1);
  });

  it("shows a failure for a request that throws, so the Timeline never waits on it", async () => {
    const { previewer, shown } = setup(() => Promise.reject(new Error("offline")));
    previewer.request({ row: 2, start: 7, end: 9 });
    await vi.advanceTimersByTimeAsync(250);
    expect(shown).toEqual([{ change: { row: 2, start: 7, end: 9 }, moves: [], refusal: "failed" }]);
  });
});

describe("timeline reschedule: the Timeline's props", () => {
  const format = {
    dateTime: (date: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(date),
  } as never;

  it("names each day, carries locked rows and baselines, and turns lag hours into days", () => {
    const view = timelineView(
      {
        days: [
          { day: "2027-06-01", weekday: 2, date: 1, weekend: false },
          { day: "2027-06-05", weekday: 6, date: 5, weekend: true },
        ],
        bars,
        edges: [{ from: 0, to: 1, type: "Finish to Start", lagHours: 36 }],
        today: 1,
      },
      format,
    );
    expect(view.days).toEqual([
      { dow: "T", date: 1, weekend: false, label: "Tuesday, June 1" },
      { dow: "S", date: 5, weekend: true, label: "Saturday, June 5" },
    ]);
    expect(view.today).toBe(1);
    expect(view.dayWidth).toBe(32);
    expect(view.rows[1]).toMatchObject({ key: "T-2", dependsOn: 0, locked: true });
    expect(view.rows[2]).toMatchObject({ baselineStart: 5, baselineEnd: 7 });
    expect(view.rows[0]).not.toHaveProperty("locked");
    expect(view.links).toEqual([{ from: 0, to: 1, type: "Finish to Start", lagDays: 1.5 }]);
  });
});
