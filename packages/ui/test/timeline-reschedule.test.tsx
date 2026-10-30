import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Timeline, type TimelineLink, type TimelineProps } from "../src/index.ts";
import {
  criticalRows,
  planChange,
  pushSuccessors,
  sameMoves,
  sameRows,
  withMoves,
} from "../src/Charts/timeline-plan.ts";
import { expectAccessible } from "./a11y.ts";

const days = Array.from({ length: 14 }, (_, i) => ({
  dow: "M",
  date: i + 1,
  label: `June ${i + 1}`,
}));

/** Truss, then Rig, then Focus, each Finish to Start; Strike stands alone. */
const rows: TimelineProps["rows"] = [
  { key: "B-1", title: "Truss", state: "active", start: 0, end: 2 },
  { key: "B-2", title: "Rig", state: "ready", start: 3, end: 4, dependsOn: 0 },
  { key: "B-3", title: "Focus", state: "ready", start: 5, end: 5, dependsOn: 1 },
  { key: "B-4", title: "Strike", state: "proposed", start: 1, end: 2 },
];
const links: TimelineLink[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
];
const spans = rows.map((r) => ({ start: r.start, end: r.end }));

describe("timeline plan", () => {
  it("pushes successors through the chain by the days each dependency needs", () => {
    expect(pushSuccessors(spans, links, { row: 0, start: 1, end: 3 })).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 5 },
      { start: 6, end: 6 },
      { start: 1, end: 2 },
    ]);
  });

  it("pulls nothing earlier and keeps a gap broken before the change", () => {
    expect(pushSuccessors(spans, links, { row: 0, start: 0, end: 0 })?.[1]).toEqual({
      start: 3,
      end: 4,
    });
    // B-2 already starts a day inside B-1: moving B-1 a day pushes B-2 one day, not two.
    const broken = [
      { start: 0, end: 2 },
      { start: 2, end: 3 },
    ];
    expect(pushSuccessors(broken, [{ from: 0, to: 1 }], { row: 0, start: 1, end: 3 })?.[1]).toEqual(
      { start: 3, end: 4 },
    );
  });

  it("reads every dependency type and its lag", () => {
    const pair = [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ];
    const move = { row: 0, start: 2, end: 3 };
    const after = (link: TimelineLink) => pushSuccessors(pair, [link], move)?.[1];
    expect(after({ from: 0, to: 1, type: "Start to Start", lagDays: 1 })).toEqual({
      start: 3,
      end: 4,
    });
    expect(after({ from: 0, to: 1, type: "Start to Start", lagDays: 2 })).toEqual({
      start: 4,
      end: 5,
    });
    expect(after({ from: 0, to: 1, type: "Finish to Finish" })).toEqual({ start: 3, end: 4 });
    expect(after({ from: 0, to: 1, type: "Start to Finish", lagDays: 4 })).toEqual({
      start: 4,
      end: 5,
    });
  });

  it("returns null for a cycle and finds the critical path", () => {
    const loop: TimelineLink[] = [...links, { from: 2, to: 0 }];
    expect(pushSuccessors(spans, loop, { row: 1, start: 4, end: 5 })).toBeNull();
    expect(planChange(spans, loop, { row: 1, start: 4, end: 5 }, () => false)).toBeNull();
    expect(criticalRows(spans, links)).toEqual([0, 1, 2]);
    expect(criticalRows([], links)).toEqual([]);
    // With B-4 pushed past Focus, B-4 alone sets the last finish.
    const plan = withMoves(spans, links, { row: 3, start: 6, end: 9 }, [], () => false);
    expect(plan.criticalAfter).toEqual([3]);
    expect(plan.finishShift).toBe(4);
    expect(sameRows(plan.criticalBefore, plan.criticalAfter)).toBe(false);
    expect(sameRows([1, 2], [2, 1])).toBe(true);
  });

  it("reads a milestone as one instant, as the server reads a one-date record", () => {
    // Due the 12th, then due the 13th: moving the first two days pushes the second one day.
    const points = [
      { start: 11, end: 11, point: true },
      { start: 12, end: 12, point: true },
    ];
    expect(
      pushSuccessors(points, [{ from: 0, to: 1 }], { row: 0, start: 13, end: 13 })?.[1],
    ).toEqual({ start: 13, end: 13, point: true });
  });

  it("compares moves by row and day, in any order", () => {
    const a = { row: 1, start: 2, end: 3 };
    const b = { row: 2, start: 4, end: 4 };
    expect(sameMoves([a, b], [b, a])).toBe(true);
    expect(sameMoves([a], [a, b])).toBe(false);
    expect(sameMoves([a], [{ ...a, end: 4 }])).toBe(false);
  });

  it("names the locked rows a change would move", () => {
    const plan = planChange(spans, links, { row: 0, start: 2, end: 4 }, (i) => i === 2);
    expect(plan?.moves.map((m) => m.row)).toEqual([1, 2]);
    expect(plan?.locked).toEqual([2]);
  });
});

describe("Timeline rescheduling", () => {
  it("moves a bar by keyboard, previews the successors and applies on Enter", async () => {
    const onReschedule = vi.fn();
    const onPendingChange = vi.fn();
    const { container } = render(
      <Timeline
        label="Build schedule"
        days={days}
        rows={rows}
        links={links}
        onReschedule={onReschedule}
        onPendingChange={onPendingChange}
      />,
    );
    const bar = screen.getByRole("button", { name: "B-1 Truss, June 1 to June 3" });
    bar.focus();
    await userEvent.keyboard("{ArrowRight}");
    const preview = screen.getByRole("group", { name: "Reschedule preview" });
    expect(preview.textContent).toContain("B-1 moves to June 2 through June 4.");
    expect(preview.textContent).toContain("2 successors move: B-2 and B-3.");
    expect(preview.textContent).toContain("The critical path stays the same.");
    expect(preview.textContent).toContain("The last finish moves 1 day later.");
    expect(onPendingChange).toHaveBeenLastCalledWith({ row: 0, start: 1, end: 3 });
    // The live region reads the same line, and the bar's name follows the change.
    expect(container.querySelector("[aria-live]")?.textContent).toContain("2 successors move");
    expect(screen.getByRole("button", { name: "B-1 Truss, June 2 to June 4" })).toBe(bar);
    await expectAccessible(container);
    await userEvent.keyboard("{Enter}");
    expect(onReschedule).toHaveBeenCalledWith({ row: 0, start: 1, end: 3 });
    expect(screen.queryByRole("group", { name: "Reschedule preview" })).toBeNull();
    expect(container.querySelector("[aria-live]")?.textContent).toBe("B-1 rescheduled.");
    // The page hears of the cleared change from an effect, which may run after the paint.
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(null));
  });

  it("resizes with Shift, cancels with Escape and drops a change back to where it was", async () => {
    const onReschedule = vi.fn();
    const { container } = render(
      <Timeline
        label="Build schedule"
        days={days}
        rows={rows}
        links={links}
        onReschedule={onReschedule}
      />,
    );
    screen.getByRole("button", { name: /^B-4 Strike/ }).focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}");
    const preview = screen.getByRole("group", { name: "Reschedule preview" });
    expect(preview.textContent).toContain("B-4 moves to June 2 through June 7.");
    expect(preview.textContent).toContain("No other record moves.");
    expect(preview.textContent).toContain("The critical path changes.");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Reschedule preview" })).toBeNull();
    expect(container.querySelector("[aria-live]")?.textContent).toBe("Change canceled.");
    await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
    expect(screen.queryByRole("group", { name: "Reschedule preview" })).toBeNull();
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it("drags a bar and applies with a second interaction", async () => {
    const onReschedule = vi.fn(() => Promise.resolve(true));
    render(
      <Timeline
        label="Build schedule"
        days={days}
        rows={rows}
        links={links}
        dayWidth={32}
        onReschedule={onReschedule}
      />,
    );
    const bar = screen.getByRole("button", { name: /^B-2 Rig/ });
    fireEvent.pointerDown(bar, { clientX: 100 });
    fireEvent.pointerMove(bar, { clientX: 102 });
    expect(screen.queryByRole("group", { name: "Reschedule preview" })).toBeNull();
    fireEvent.pointerMove(bar, { clientX: 164 });
    fireEvent.pointerUp(bar, { clientX: 164 });
    const preview = screen.getByRole("group", { name: "Reschedule preview" });
    expect(preview.textContent).toContain("B-2 moves to June 6 through June 7.");
    expect(preview.textContent).toContain("1 successor moves: B-3.");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onReschedule).toHaveBeenCalledWith({ row: 1, start: 5, end: 6 });
  });

  it("resizes from either end by dragging its handle", () => {
    render(
      <Timeline
        label="Build schedule"
        days={days}
        rows={rows}
        links={links}
        onReschedule={vi.fn()}
      />,
    );
    const bar = screen.getByRole("button", { name: /^B-1 Truss/ });
    const [startHandle, endHandle] = Array.from(bar.querySelectorAll("span"));
    fireEvent.pointerDown(endHandle as Element, { clientX: 90 });
    fireEvent.pointerMove(endHandle as Element, { clientX: 154 });
    fireEvent.pointerUp(endHandle as Element);
    expect(screen.getByRole("group", { name: "Reschedule preview" }).textContent).toContain(
      "B-1 moves to June 1 through June 5.",
    );
    fireEvent.pointerDown(startHandle as Element, { clientX: 0 });
    fireEvent.pointerMove(startHandle as Element, { clientX: 32 });
    fireEvent.pointerUp(startHandle as Element);
    expect(screen.getByRole("group", { name: "Reschedule preview" }).textContent).toContain(
      "B-1 moves to June 2 through June 5.",
    );
  });

  it("keeps locked rows still and refuses a change that would push one", async () => {
    const locked = rows.map((r, i) => (i === 2 ? { ...r, locked: true } : r));
    const { container } = render(
      <Timeline
        label="Build schedule"
        days={days}
        rows={locked}
        links={links}
        onReschedule={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^B-3 Focus/ })).toBeNull();
    expect(container.querySelector("table")?.textContent).toContain("Focus (locked)");
    screen.getByRole("button", { name: /^B-2 Rig/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("group", { name: "Reschedule preview" }).textContent).toContain(
      "B-3 cannot move: locked.",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
  });

  it("shows the page's own preview and refusal while they match the pending change", async () => {
    const props = {
      label: "Build schedule",
      days,
      rows,
      links,
      onReschedule: vi.fn(() => Promise.resolve(false)),
    };
    const { rerender } = render(<Timeline {...props} />);
    screen.getByRole("button", { name: /^B-1 Truss/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    const change = { row: 0, start: 1, end: 3 };
    rerender(
      <Timeline
        {...props}
        preview={{
          change,
          moves: [{ row: 1, start: 5, end: 6 }],
          note: "1 more record outside this view moves.",
        }}
      />,
    );
    const shown = screen.getByRole("group", { name: "Reschedule preview" }).textContent;
    expect(shown).toContain("1 successor moves: B-2.");
    expect(shown).toContain("1 more record outside this view moves.");
    rerender(
      <Timeline {...props} preview={{ change, moves: [], refusal: "A record is locked." }} />,
    );
    expect(screen.getByRole("group", { name: "Reschedule preview" }).textContent).toContain(
      "A record is locked.",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
    rerender(<Timeline {...props} preview={{ change, moves: [] }} />);
    await act(async () => {
      screen.getByRole("button", { name: "Apply" }).click();
    });
    // The page kept the change pending (it resolved false), so the preview stays.
    expect(props.onReschedule).toHaveBeenCalledWith(change);
    expect(screen.getByRole("group", { name: "Reschedule preview" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Reschedule preview" })).toBeNull();
  });

  it("waits for the page's preview before applying, and applies on arrival when it agrees", async () => {
    const onReschedule = vi.fn(() => Promise.resolve(true));
    const props = { label: "Build schedule", days, rows, links, onReschedule, awaitPreview: true };
    const { rerender, container } = render(<Timeline {...props} />);
    screen.getByRole("button", { name: /^B-1 Truss/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    const shown = screen.getByRole("group", { name: "Reschedule preview" }).textContent;
    expect(shown).toContain("2 successors move: B-2 and B-3.");
    expect(shown).toContain("Checking every dependency before the change can be applied.");
    // Enter while the preview is on its way waits for it, and Apply shows that it is waiting.
    await userEvent.keyboard("{Enter}");
    expect(onReschedule).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply" }).getAttribute("aria-busy")).toBe("true");
    const change = { row: 0, start: 1, end: 3 };
    await act(async () => {
      rerender(
        <Timeline
          {...props}
          preview={{
            change,
            moves: [
              { row: 1, start: 4, end: 5 },
              { row: 2, start: 6, end: 6 },
            ],
          }}
        />,
      );
    });
    expect(onReschedule).toHaveBeenCalledWith(change);
    expect(container.querySelector("[aria-live]")?.textContent).toBe("B-1 rescheduled.");
  });

  it("shows the page's preview for a second look when it disagrees with the estimate", async () => {
    const onReschedule = vi.fn(() => Promise.resolve(true));
    const props = { label: "Build schedule", days, rows, links, onReschedule, awaitPreview: true };
    const { rerender } = render(<Timeline {...props} />);
    screen.getByRole("button", { name: /^B-1 Truss/ }).focus();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    const change = { row: 0, start: 1, end: 3 };
    await act(async () => {
      rerender(<Timeline {...props} preview={{ change, moves: [{ row: 1, start: 4, end: 5 }] }} />);
    });
    expect(onReschedule).not.toHaveBeenCalled();
    const shown = screen.getByRole("group", { name: "Reschedule preview" }).textContent;
    expect(shown).toContain("1 successor moves: B-2.");
    expect(shown).not.toContain("Checking");
    await userEvent.keyboard("{Enter}");
    expect(onReschedule).toHaveBeenCalledWith(change);
  });

  it("does not apply a waiting change that the page refuses or that changed meanwhile", async () => {
    const onReschedule = vi.fn(() => Promise.resolve(true));
    const props = { label: "Build schedule", days, rows, links, onReschedule, awaitPreview: true };
    const { rerender } = render(<Timeline {...props} />);
    screen.getByRole("button", { name: /^B-4 Strike/ }).focus();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    const first = { row: 3, start: 2, end: 3 };
    await act(async () => {
      rerender(<Timeline {...props} preview={{ change: first, moves: [], refusal: "No." }} />);
    });
    expect(onReschedule).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
    // Enter, then another day: the answer for the first change no longer matches, so nothing applies.
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    screen.getByRole("button", { name: /^B-4 Strike/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    await act(async () => {
      rerender(
        <Timeline {...props} preview={{ change: { row: 3, start: 3, end: 4 }, moves: [] }} />,
      );
    });
    expect(onReschedule).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Reschedule preview" }).textContent).toContain(
      "Checking",
    );
  });

  it("moves a milestone without resizing it, and says when the dependencies are circular", async () => {
    const withMilestone = rows.map((r, i) => (i === 2 ? { ...r, milestone: true } : r));
    render(
      <Timeline
        label="Build schedule"
        days={days}
        rows={withMilestone}
        links={[...links, { from: 2, to: 0 }]}
        onReschedule={vi.fn()}
      />,
    );
    screen.getByRole("button", { name: /^B-3 Focus/ }).focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const preview = screen.getByRole("group", { name: "Reschedule preview" });
    expect(preview.textContent).toContain("B-3 moves to June 7 through June 7.");
    expect(preview.textContent).toContain("The dependencies are circular");
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
  });
});
