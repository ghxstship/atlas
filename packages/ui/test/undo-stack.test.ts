import { describe, expect, it } from "vitest";
import { createUndoStack, UNDO_LIMIT, type UndoEvent } from "../src/lib/undo-stack.ts";

function recorder() {
  const log: string[] = [];
  const action = (name: string, outcome: { ok: boolean; message?: string } = { ok: true }) => ({
    label: name,
    undo: async () => {
      log.push(`undo ${name}`);
      return outcome.ok
        ? { ok: true as const }
        : { ok: false as const, message: outcome.message ?? "" };
    },
    redo: async () => {
      log.push(`redo ${name}`);
      return { ok: true as const };
    },
  });
  return { log, action };
}

describe("undo stack", () => {
  it("undoes the latest action, redoes it, and a new action clears the redo list", async () => {
    const stack = createUndoStack();
    const { log, action } = recorder();
    const events: string[] = [];
    stack.subscribe((e: UndoEvent) =>
      events.push(e.kind === "empty" ? `empty ${e.direction}` : `${e.kind} ${e.entry.label}`),
    );
    stack.push(action("a"));
    stack.push(action("b"));
    await stack.undo();
    await stack.undo();
    expect(log).toEqual(["undo b", "undo a"]);
    await stack.redo();
    expect(log.at(-1)).toBe("redo a");
    expect(stack.size()).toEqual({ past: 1, future: 1 });
    stack.push(action("c"));
    expect(stack.size()).toEqual({ past: 2, future: 0 });
    await stack.redo();
    expect(events).toEqual([
      "pushed a",
      "pushed b",
      "undone b",
      "undone a",
      "redone a",
      "pushed c",
      "empty redo",
    ]);
  });

  it("keeps the last 50 actions", async () => {
    const stack = createUndoStack();
    const { action } = recorder();
    for (let i = 0; i < UNDO_LIMIT + 5; i += 1) stack.push(action(`n${i}`));
    expect(stack.size().past).toBe(UNDO_LIMIT);
    expect(stack.has(1)).toBe(false);
    expect(stack.has(UNDO_LIMIT + 5)).toBe(true);
  });

  it("leaves an action in place when the server refuses its undo", async () => {
    const stack = createUndoStack();
    const { action } = recorder();
    const events: UndoEvent[] = [];
    stack.subscribe((e) => events.push(e));
    const entry = stack.push(action("stale", { ok: false, message: "Someone changed this row." }));
    await stack.undo();
    expect(stack.has(entry.id)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "failed", message: "Someone changed this row." });
  });

  it("undoes a named entry from its toast and says when there is nothing to undo", async () => {
    const stack = createUndoStack();
    const { log, action } = recorder();
    const first = stack.push(action("first"));
    stack.push(action("second"));
    await stack.undo(first.id);
    expect(log).toEqual(["undo first"]);
    expect(stack.has(first.id)).toBe(false);
    const empty = createUndoStack();
    const events: UndoEvent[] = [];
    empty.subscribe((e) => events.push(e));
    await empty.undo();
    expect(events).toEqual([{ kind: "empty", direction: "undo" }]);
  });

  it("drops an action without redo once undone, and reports a thrown undo as failed", async () => {
    const stack = createUndoStack();
    stack.push({ label: "once", undo: async () => ({ ok: true }) });
    await stack.undo();
    expect(stack.size()).toEqual({ past: 0, future: 0 });
    const events: UndoEvent[] = [];
    stack.subscribe((e) => events.push(e));
    stack.push({
      label: "boom",
      undo: async () => {
        throw new Error("network");
      },
    });
    await stack.undo();
    expect(events.at(-1)).toMatchObject({ kind: "failed", message: "network" });
  });
});
