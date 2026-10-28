import { describe, expect, it } from "vitest";
import {
  changedFields,
  propertyEdit,
  sameValue,
  softDelete,
  stateChange,
  toggle,
  versionChain,
} from "../components/undo/entries";
import { createUndoStack } from "../components/undo/undo-stack";

/** A fake server that records each call and answers ok, or refuses the calls named in `refuse`. */
function server(refuse: readonly string[] = []) {
  const calls: string[] = [];
  const answer = (call: string) => {
    calls.push(call);
    return Promise.resolve(
      refuse.includes(call)
        ? { ok: false as const, message: "Someone changed this after your edit." }
        : { ok: true as const },
    );
  };
  return { calls, answer };
}

describe("undo entries for inline edits (A118)", () => {
  it("keeps only the fields an edit changed, comparing instants by meaning", () => {
    const diff = changedFields(
      { title: "Hang the banner", ownerId: null, dueAt: "2027-06-05T18:00:00+00:00" },
      { title: "Hang two banners", ownerId: null, dueAt: "2027-06-05T18:00:00.000Z" },
    );
    expect(diff.keys).toEqual(["title"]);
    expect(diff.before).toEqual({ title: "Hang the banner" });
    expect(diff.after).toEqual({ title: "Hang two banners" });
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue("2027-06-05T18:00:00Z", "2027-06-05T19:00:00Z")).toBe(false);
  });

  it("undoes a property edit by writing the values before, expecting the values after", async () => {
    const { calls, answer } = server();
    const stack = createUndoStack();
    stack.push(
      propertyEdit({
        label: "Edited NWL-12.",
        before: { title: "Hang the banner" },
        after: { title: "Hang two banners" },
        save: (set, expect) => answer(`set ${set.title} expect ${expect.title}`),
      }),
    );
    await stack.undo();
    await stack.redo();
    expect(calls).toEqual([
      "set Hang the banner expect Hang two banners",
      "set Hang two banners expect Hang the banner",
    ]);
  });

  it("leaves a refused undo on the stack, so nothing is lost silently", async () => {
    const { answer } = server(["set a expect b"]);
    const stack = createUndoStack();
    const events: string[] = [];
    stack.subscribe((e) => events.push(e.kind === "failed" ? `failed ${e.message}` : e.kind));
    const entry = stack.push(
      propertyEdit({
        label: "Edited NWL-12.",
        before: { title: "a" },
        after: { title: "b" },
        save: (set, expect) => answer(`set ${set.title} expect ${expect.title}`),
      }),
    );
    await stack.undo();
    expect(stack.has(entry.id)).toBe(true);
    expect(events).toEqual(["pushed", "failed Someone changed this after your edit."]);
  });

  it("moves a state back from where it went, and forward again on redo", async () => {
    const { calls, answer } = server();
    const stack = createUndoStack();
    stack.push(
      stateChange({
        label: "Moved NWL-12 to Scheduled.",
        from: "Ready",
        to: "Scheduled",
        move: (expected, next) => answer(`${expected} to ${next}`),
      }),
    );
    await stack.undo();
    await stack.redo();
    expect(calls).toEqual(["Scheduled to Ready", "Ready to Scheduled"]);
  });

  it("restores a delete on undo and deletes again on redo, with the shell's toast unless the page shows its own", async () => {
    const { calls, answer } = server();
    const stack = createUndoStack();
    const shown = stack.push(
      softDelete({
        label: "Removed Truss.",
        restore: () => answer("restore"),
        remove: () => answer("remove"),
      }),
    );
    const own = softDelete({
      label: "2 lines deleted.",
      toast: false,
      restore: () => answer("restore"),
      remove: () => answer("remove"),
    });
    expect(shown.toast).toBeUndefined();
    expect(own.toast).toBe(false);
    await stack.undo(shown.id);
    await stack.redo();
    expect(calls).toEqual(["restore", "remove"]);
  });

  it("sets a checklist item back on undo", async () => {
    const { calls, answer } = server();
    const stack = createUndoStack();
    stack.push(
      toggle({
        label: "Checked Rig the truss.",
        after: true,
        set: (value) => answer(`checked ${value}`),
      }),
    );
    await stack.undo();
    await stack.redo();
    expect(calls).toEqual(["checked false", "checked true"]);
  });
});

/** A budget line on a fake server: a save commits only against the line's version now, as updateBudgetLine does. */
function budgetLine(values: string) {
  let version = 0;
  return {
    get values() {
      return values;
    },
    version: () => `v${version}`,
    save(expected: string, next: string): string | null {
      if (expected !== `v${version}`) return null;
      version += 1;
      values = next;
      return `v${version}`;
    },
  };
}

describe("budget cell undo saves against the version its edit left (A118)", () => {
  /** A cell edit the way the budget editor makes it: saved, recorded on the chain, pushed with its inverse. */
  function editor(line: ReturnType<typeof budgetLine>) {
    const chain = versionChain();
    const stack = createUndoStack();
    const edit = (next: string) => {
      const before = line.values;
      const from = line.version();
      const left = line.save(from, next);
      if (left === null) throw new Error("the edit itself was stale");
      chain.record("l1", from, left);
      return stack.push(
        propertyEdit({
          label: "Edited line 1.",
          before: { line: before },
          after: { line: next },
          save: (set) => {
            const expected = chain.latest("l1", left);
            const saved = line.save(expected, String(set.line));
            if (saved === null) {
              return Promise.resolve({
                ok: false as const,
                message: "Someone changed this line after your edit.",
              });
            }
            chain.record("l1", expected, saved);
            return Promise.resolve({ ok: true as const });
          },
        }),
      );
    };
    return { stack, edit };
  }

  it("undoes two edits of one line in turn, and redoes against the undo's version", async () => {
    const line = budgetLine("cost 50");
    const { stack, edit } = editor(line);
    edit("cost 100");
    edit("cost 120");
    await stack.undo();
    expect(line.values).toBe("cost 100");
    await stack.undo();
    expect(line.values).toBe("cost 50");
    await stack.redo();
    expect(line.values).toBe("cost 100");
  });

  it("refuses an undo after someone else saved the line, even once the grid holds their version", async () => {
    const line = budgetLine("cost 50, quantity 1");
    const { stack, edit } = editor(line);
    const mine = edit("cost 100, quantity 1");
    // Another session saves the same line; the grid reloads (a paste or a delete) and now shows their version.
    line.save(line.version(), "cost 100, quantity 5");
    const events: string[] = [];
    stack.subscribe((e) => events.push(e.kind === "failed" ? `failed ${e.message}` : e.kind));
    await stack.undo();
    expect(line.values).toBe("cost 100, quantity 5");
    expect(stack.has(mine.id)).toBe(true);
    expect(events).toEqual(["failed Someone changed this line after your edit."]);
  });

  it("follows only the row's own chain", () => {
    const chain = versionChain();
    chain.record("l1", "v0", "v1");
    chain.record("l1", "v1", "v2");
    chain.record("l2", "v2", "v3");
    expect(chain.latest("l1", "v0")).toBe("v2");
    expect(chain.latest("l2", "v0")).toBe("v0");
    expect(chain.latest("l1", "v9")).toBe("v9");
  });
});
