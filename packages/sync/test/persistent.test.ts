import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Outbox, PersistentStore, type SqlExecutor } from "../src";
import { sequentialIds } from "./support";

/** node:sqlite behind the executor contract, standing in for op-sqlite with SQLCipher on device. */
function sqlite(
  db = new DatabaseSync(":memory:"),
  failOn?: RegExp,
): SqlExecutor & { db: DatabaseSync } {
  return {
    db,
    transaction(statements) {
      db.exec("begin");
      try {
        for (const s of statements) {
          if (failOn?.test(JSON.stringify(s.params))) throw new Error("disk full");
          db.prepare(s.sql).run(...(s.params as (string | number | null)[]));
        }
        db.exec("commit");
        return Promise.resolve();
      } catch (error) {
        db.exec("rollback");
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    all(sql, params = []) {
      return Promise.resolve(
        db.prepare(sql).all(...(params as (string | number | null)[])) as Record<string, unknown>[],
      );
    },
  };
}

describe("PersistentStore", () => {
  it("survives a restart: rows and the outbox reload from SQLite", async () => {
    const exec = sqlite();
    const first = await PersistentStore.open(exec);
    const outbox = new Outbox(first, { newId: sequentialIds() });
    await outbox.enqueue({
      op: "insert",
      table: "clock_punches",
      rowId: "p1",
      payload: { punch_kind: "In" },
      optimistic: { id: "p1", punch_kind: "In" },
    });
    await first.transaction((tx) => {
      tx.put("shifts", { id: "s1", note: "a" });
      tx.put("shifts", { id: "s2", note: "b" });
      tx.remove("shifts", "s2");
      tx.remove("shifts", "missing");
    });

    const reopened = await PersistentStore.open(exec);
    expect(await reopened.get("clock_punches", "p1")).toEqual({ id: "p1", punch_kind: "In" });
    expect(await reopened.list("shifts")).toEqual([{ id: "s1", note: "a" }]);
    expect(await new Outbox(reopened).count()).toBe(1);
    expect((await reopened.tables()).sort()).toEqual(["_outbox", "clock_punches", "shifts"]);
    expect(await reopened.list("shifts", (r) => r["note"] === "z")).toEqual([]);
  });

  it("shows nothing when SQLite refuses the commit", async () => {
    const store = await PersistentStore.open(sqlite(undefined, /boom/));
    await store.transaction((tx) => tx.put("t", { id: "ok" }));
    await expect(store.transaction((tx) => tx.put("t", { id: "x", v: "boom" }))).rejects.toThrow(
      "disk full",
    );
    expect(await store.list("t")).toEqual([{ id: "ok" }]);
    // The queue keeps working after a failed transaction.
    await store.transaction((tx) => tx.put("t", { id: "after" }));
    expect((await store.list("t")).map((r) => r.id)).toEqual(["ok", "after"]);
  });

  it("serializes transactions so each sees the previous one", async () => {
    const store = await PersistentStore.open(sqlite());
    const outbox = new Outbox(store, { newId: sequentialIds() });
    const queued = await Promise.all(
      [1, 2, 3].map((n) =>
        outbox.enqueue({ op: "insert", table: "t", rowId: `r${n}`, payload: {} }),
      ),
    );
    expect(queued.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("notifies listeners and wipes the database on remote sign-out", async () => {
    const exec = sqlite();
    const store = await PersistentStore.open(exec);
    const seen: string[] = [];
    const stop = store.subscribe((t) => seen.push(t));
    await store.transaction((tx) => tx.put("t", { id: "1" }));
    await store.transaction(() => 0);
    await store.wipe();
    stop();
    expect(seen).toEqual(["t", "t"]);
    expect(await store.tables()).toEqual([]);
    expect(exec.db.prepare("select count(*) as n from xos_local_rows").get()).toEqual({ n: 0 });
  });
});
