import type { BudgetLine, BudgetLineInput } from "@xos/data/finance";
import { describe, expect, it } from "vitest";
import {
  catchUpLine,
  lineSaveOutcome,
  LineSaves,
  linesAfterSave,
  mergeLines,
  savedVersion,
  typedLine,
  type LineSaveResult,
} from "@/lib/finance/live-lines";

/**
 * P4 (RRR-218, gap G-216, Section 11.7): how the live budget grid reconciles its lines. A line with
 * an open cell or a save in flight keeps what the person typed, a refresh that carries an older
 * version cannot revert it, saves of one line chain on each other's versions, and a line someone
 * else removes while it is held, or while its save is in flight, leaves the grid with a status
 * instead of silently.
 */

const T0 = "2026-10-30T10:00:00.000Z";
const T1 = "2026-10-30T10:00:05.000Z";
const T2 = "2026-10-30T10:00:09.000Z";

function line(id: string, over: Partial<BudgetLine> = {}): BudgetLine {
  return {
    id,
    budgetId: "b1",
    lineNumber: 1,
    description: `Line ${id}`,
    lineType: "Labor",
    urid: "4000.01.01",
    costCenterId: null,
    gradeCode: null,
    elementId: null,
    quantity: 1,
    unitBasis: null,
    unitPriceMinor: 10_000,
    xyz: "X",
    xyzBasis: "Category",
    extendedMinor: 10_000,
    accountCode: "4000",
    actualMinor: 0,
    drawnInMinor: 0,
    drawnOutMinor: 0,
    committedMinor: 0,
    committedWithheld: false,
    poLineCount: 0,
    otherCurrencyPoLineCount: 0,
    updatedAt: T0,
    ...over,
  };
}

function inputOf(l: BudgetLine, over: Partial<BudgetLineInput> = {}): BudgetLineInput {
  return {
    description: l.description,
    lineType: l.lineType,
    urid: l.urid,
    costCenterId: l.costCenterId,
    gradeCode: l.gradeCode,
    elementId: l.elementId,
    quantity: l.quantity,
    unitBasis: l.unitBasis,
    unitPriceMinor: l.unitPriceMinor,
    xyz: l.xyz,
    xyzBasis: l.xyzBasis,
    ...over,
  };
}

const none = new Set<string>();

/** A fake updateBudgetLineAction whose answers the test releases one at a time, in order. */
function fakeUpdateAction() {
  const calls: { id: string; expectedUpdatedAt: string }[] = [];
  const answers: ((r: LineSaveResult) => void)[] = [];
  const action = (id: string, expectedUpdatedAt: string) => {
    calls.push({ id, expectedUpdatedAt });
    return new Promise<LineSaveResult>((resolve) => answers.push(resolve));
  };
  const answer = async (result: LineSaveResult) => {
    for (let i = 0; i < 10 && answers.length === 0; i++) await Promise.resolve();
    answers.shift()?.(result);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { calls, action, answer };
}

describe("mergeLines", () => {
  it("takes the page's version of a line nobody here holds", () => {
    const mine = [line("a"), line("b")];
    const page = [line("a", { description: "Renamed", updatedAt: T1 }), line("b")];
    const merged = mergeLines(mine, page, none);
    expect(merged.lines.map((l) => l.description)).toEqual(["Renamed", "Line b"]);
    expect(merged.removedRows).toEqual([]);
  });

  it("keeps a held line as typed, even when the page carries a newer version", () => {
    const typed = line("a", { description: "Typed here" });
    const page = [line("a", { description: "Saved elsewhere", updatedAt: T1 })];
    const merged = mergeLines([typed], page, new Set(["a"]));
    expect(merged.lines[0]).toBe(typed);
  });

  it("keeps a line whose page version is older than the one held (a stale refresh)", () => {
    const saved = line("a", { description: "Saved here", updatedAt: T2 });
    const stale = line("a", { description: "Before the save", updatedAt: T1 });
    expect(mergeLines([saved], [stale], none).lines[0]).toBe(saved);
  });

  it("adds lines added elsewhere in the page's order, and drops lines removed elsewhere", () => {
    const mine = [line("a"), line("b"), line("c")];
    const page = [line("a"), line("d"), line("c")];
    const merged = mergeLines(mine, page, none);
    expect(merged.lines.map((l) => l.id)).toEqual(["a", "d", "c"]);
    // Nobody here held line b, so nothing was lost.
    expect(merged.removedRows).toEqual([]);
  });

  it("reports, by grid row, a held line someone else removed", () => {
    const mine = [line("a"), line("b"), line("c")];
    const merged = mergeLines(mine, [line("a"), line("c")], new Set(["b"]));
    expect(merged.lines.map((l) => l.id)).toEqual(["a", "c"]);
    expect(merged.removedRows).toEqual([2]);
  });

  it("does not report a held line this tab deleted itself", () => {
    const merged = mergeLines([line("a"), line("b")], [line("a")], new Set(["b"]), new Set(["b"]));
    expect(merged.removedRows).toEqual([]);
  });
});

describe("catchUpLine", () => {
  it("brings a line whose cell closed up to the page's version", () => {
    const page = [line("a", { description: "Saved elsewhere", updatedAt: T1 })];
    expect(catchUpLine([line("a")], page, "a")[0]?.description).toBe("Saved elsewhere");
  });

  it("keeps the line when the page is older or no longer has it", () => {
    const mine = [line("a", { description: "Saved here", updatedAt: T2 })];
    expect(catchUpLine(mine, [line("a", { updatedAt: T1 })], "a")).toBe(mine);
    expect(catchUpLine(mine, [], "a")).toBe(mine);
  });
});

describe("a save's outcome", () => {
  const previous = line("a");
  const typed = typedLine([previous, line("b")], "a", inputOf(previous, { quantity: 3 }));

  it("shows the typed values at once, with their extended amount", () => {
    expect(typed[0]?.quantity).toBe(3);
    expect(typed[0]?.extendedMinor).toBe(30_000);
    expect(typed[1]).toEqual(line("b"));
  });

  it("drops a line deleted elsewhere (not-found) and keeps no version", () => {
    const outcome = lineSaveOutcome({ error: { kind: "not-found" } });
    expect(outcome).toEqual({ kind: "removed" });
    expect(linesAfterSave(typed, previous, outcome).map((l) => l.id)).toEqual(["b"]);
    expect(savedVersion(outcome)).toBeNull();
  });

  it("leaves the typed values showing on a conflict, for the dialog to decide", () => {
    const theirs = line("a", { description: "Saved elsewhere", updatedAt: T1 });
    const outcome = lineSaveOutcome({ conflict: theirs });
    expect(outcome).toEqual({ kind: "conflict", theirs });
    expect(linesAfterSave(typed, previous, outcome)).toBe(typed);
    expect(savedVersion(outcome)).toBeNull();
  });

  it("puts the line back on any other refusal", () => {
    const outcome = lineSaveOutcome({ error: { kind: "forbidden" } });
    expect(outcome).toEqual({ kind: "refused" });
    expect(linesAfterSave(typed, previous, outcome)[0]).toBe(previous);
  });

  it("takes the saved line's version and keeps the figures the save does not return", () => {
    const saved = line("a", { quantity: 3, updatedAt: T1, committedMinor: null, actualMinor: 0 });
    const held = typedLine([line("a", { committedMinor: 4_200, actualMinor: 900 })], "a", {
      ...inputOf(previous),
      quantity: 3,
    });
    const outcome = lineSaveOutcome({ line: saved });
    const after = linesAfterSave(held, previous, outcome)[0];
    expect(after?.updatedAt).toBe(T1);
    expect(after?.committedMinor).toBe(4_200);
    expect(after?.actualMinor).toBe(900);
    expect(savedVersion(outcome)).toBe(T1);
  });
});

describe("LineSaves", () => {
  it("chains a second save of a line on the version the first returns", async () => {
    const saves = new LineSaves();
    const fake = fakeUpdateAction();
    const send = (version: string) =>
      fake.action("a", version).then((r) => savedVersion(lineSaveOutcome(r)));
    const first = saves.run("a", T0, send);
    const second = saves.run("a", T0, send);
    expect(saves.has("a")).toBe(true);
    await fake.answer({ line: line("a", { updatedAt: T1 }) });
    await fake.answer({ line: line("a", { updatedAt: T2 }) });
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(fake.calls).toEqual([
      { id: "a", expectedUpdatedAt: T0 },
      { id: "a", expectedUpdatedAt: T1 },
    ]);
    expect(saves.has("a")).toBe(false);
  });

  it("saves the next edit against its own version when the first returns none", async () => {
    const saves = new LineSaves();
    const fake = fakeUpdateAction();
    const send = (version: string) =>
      fake.action("a", version).then((r) => savedVersion(lineSaveOutcome(r)));
    void saves.run("a", T0, send);
    const second = saves.run("a", T1, send);
    await fake.answer({ conflict: line("a", { updatedAt: T2 }) });
    await fake.answer({ line: line("a", { updatedAt: T2 }) });
    expect(await second).toBe(true);
    expect(fake.calls.map((c) => c.expectedUpdatedAt)).toEqual([T0, T1]);
  });

  it("keeps saves of different lines apart", async () => {
    const saves = new LineSaves();
    const fake = fakeUpdateAction();
    const a = saves.run("a", T0, (v) => fake.action("a", v).then(() => null));
    const b = saves.run("b", T0, (v) => fake.action("b", v).then(() => null));
    expect(fake.calls.map((c) => c.id)).toEqual(["a", "b"]);
    await fake.answer({});
    await fake.answer({});
    expect([await a, await b]).toEqual([true, true]);
  });
});

describe("a line removed elsewhere while this person edits it", () => {
  it("leaves the grid with the line-removed outcome when the save finds it gone", async () => {
    // As BudgetEditor.save does: typed values show, the line is held while it saves, a refresh
    // that still carries it cannot revert it, and the not-found answer drops it.
    const previous = line("b", { lineNumber: 7 });
    let lines = typedLine([line("a"), previous], "b", inputOf(previous, { description: "Mine" }));
    const saves = new LineSaves();
    const fake = fakeUpdateAction();
    let removed = false;
    const done = saves.run("b", previous.updatedAt, async (version) => {
      const outcome = lineSaveOutcome(await fake.action("b", version));
      lines = linesAfterSave(lines, previous, outcome);
      removed = outcome.kind === "removed";
      return savedVersion(outcome);
    });
    lines = mergeLines(lines, [line("a"), line("b", { updatedAt: T1 })], new Set(["b"])).lines;
    expect(lines[1]?.description).toBe("Mine");
    await fake.answer({ error: { kind: "not-found" } });
    expect(await done).toBe(true);
    expect(removed).toBe(true);
    expect(lines.map((l) => l.id)).toEqual(["a"]);
  });

  it("reports the row when the refresh that removes it arrives first", () => {
    const previous = line("b");
    const lines = typedLine([line("a"), previous], "b", inputOf(previous, { description: "Mine" }));
    const merged = mergeLines(lines, [line("a")], new Set(["b"]));
    expect(merged.lines.map((l) => l.id)).toEqual(["a"]);
    expect(merged.removedRows).toEqual([2]);
  });
});
