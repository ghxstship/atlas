import { DatabaseSync } from "node:sqlite";
import { OUTBOX_TABLE } from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  DB_KEY,
  DB_NAME,
  DEFAULT_DB_NAME,
  openLocalStore,
  settleStorageNotice,
  STORAGE_NOTICE,
  type DatabaseConnection,
  type LocalDatabaseDeps,
} from "../src/data/localDatabase";

type Params = (string | number | null)[];

/**
 * Database files on a pretend device, each written with a key (null: plain SQLite, as iOS builds before
 * A68-001 wrote them). As with SQLCipher, opening never fails; the first read with the wrong key does.
 */
function device(options: { failNewFiles?: boolean } = {}) {
  const files = new Map<string, { key: string | null; db: DatabaseSync }>();
  const secure = new Map<string, string>();
  let clock = 1_000;
  const run = (db: DatabaseSync, sql: string, params: Params = []) =>
    /^\s*(select|pragma)/i.test(sql)
      ? (db.prepare(sql).all(...params) as Record<string, unknown>[])
      : (db.prepare(sql).run(...params), []);
  const deps: LocalDatabaseDeps = {
    open(name, key): DatabaseConnection {
      let file = files.get(name);
      if (!file) {
        if (options.failNewFiles && name !== DEFAULT_DB_NAME) throw new Error("disk I/O error");
        file = { key, db: new DatabaseSync(":memory:") };
        files.set(name, file);
      }
      const readable = () => {
        if (file.key !== key) throw new Error("file is not a database");
        return file.db;
      };
      return {
        execute: (sql, params) => Promise.resolve({ rows: run(readable(), sql, params) }),
        async transaction(work) {
          const db = readable();
          db.exec("begin");
          try {
            await work({
              execute: (sql, params) => Promise.resolve({ rows: run(db, sql, params) }),
            });
            db.exec("commit");
          } catch (error) {
            db.exec("rollback");
            throw error;
          }
        },
        close: () => undefined,
        delete: () => void files.delete(name),
      };
    },
    getItem: (key) => Promise.resolve(secure.get(key) ?? null),
    setItem: (key, value) => {
      secure.set(key, value);
      return Promise.resolve();
    },
    newKey: () => "device-key",
    now: () => (clock += 1),
  };
  /** Writes a file the way an earlier build left it. */
  function oldFile(key: string | null, rows: [string, string, object][]) {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "create table xos_local_rows (table_name text not null, id text not null, data text not null, primary key (table_name, id))",
    );
    for (const [table, id, data] of rows)
      db.prepare("insert into xos_local_rows values (?, ?, ?)").run(
        table,
        id,
        JSON.stringify(data),
      );
    files.set(DEFAULT_DB_NAME, { key, db });
  }
  return { deps, files, secure, oldFile };
}

const unsent = (id: string) => ({
  id,
  seq: 1,
  status: "pending",
  op: "insert",
  table: "incidents",
});

describe("A66: opening the offline database recovers from a file it cannot read", () => {
  it("opens a new install's database with a fresh key and nothing to report", async () => {
    const d = device();
    const opened = await openLocalStore(d.deps);
    expect(opened.recovery).toBeNull();
    expect(d.secure.get(DB_KEY)).toBe("device-key");
    expect([...d.files.keys()]).toEqual([DEFAULT_DB_NAME]);
    await opened.store.transaction((tx) => tx.put("projects", { id: "p1" }));
    const again = await openLocalStore(d.deps);
    expect(again.recovery).toBeNull();
    expect(await again.store.get("projects", "p1")).toEqual({ id: "p1" });
  });

  it("carries the unsent writes of a plain pre-A68 file into a fresh encrypted one", async () => {
    const d = device();
    d.secure.set(DB_KEY, "device-key");
    d.oldFile(null, [
      [OUTBOX_TABLE, "m1", unsent("m1")],
      [OUTBOX_TABLE, "m2", unsent("m2")],
      ["incidents", "i1", { id: "i1", title: "Guest slipped" }],
    ]);
    const opened = await openLocalStore(d.deps);
    expect(opened.recovery).toMatchObject({ recovered: 2, unreadable: false });
    expect(opened.recovery?.reason).toBe("file is not a database");
    expect((await opened.store.list(OUTBOX_TABLE)).map((r) => r["id"]).sort()).toEqual([
      "m1",
      "m2",
    ]);
    // Downloaded rows come back from the server; only the unsent writes are carried.
    expect(await opened.store.list("incidents")).toEqual([]);
    const fresh = d.secure.get(DB_NAME);
    expect(fresh).toMatch(/^compass-\d+\.sqlite$/);
    expect(d.files.get(fresh ?? "")?.key).toBe("device-key");
    // The plain file, which may hold offline data in the clear, is gone; nothing to tell the person.
    expect(d.files.has(DEFAULT_DB_NAME)).toBe(false);
    expect(d.secure.has(STORAGE_NOTICE)).toBe(false);
    // The next launch opens the fresh file normally.
    const again = await openLocalStore(d.deps);
    expect(again.recovery).toBeNull();
    expect(await again.store.list(OUTBOX_TABLE)).toHaveLength(2);
  });

  it("starts fresh and tells the person once when the old file cannot be read at all", async () => {
    const d = device();
    d.secure.set(DB_KEY, "device-key");
    // Encrypted with a key the keychain no longer holds.
    d.oldFile("lost-key", [[OUTBOX_TABLE, "m1", unsent("m1")]]);
    const opened = await openLocalStore(d.deps);
    expect(opened.recovery).toMatchObject({ recovered: 0, unreadable: true });
    expect(await opened.store.list(OUTBOX_TABLE)).toEqual([]);
    expect(d.secure.get(STORAGE_NOTICE)).toBe("1");
    expect(d.files.has(DEFAULT_DB_NAME)).toBe(false);
  });

  it("treats a readable old file without the store's table as nothing lost", async () => {
    const d = device();
    d.secure.set(DB_KEY, "device-key");
    d.files.set(DEFAULT_DB_NAME, { key: null, db: new DatabaseSync(":memory:") });
    const opened = await openLocalStore(d.deps);
    expect(opened.recovery).toMatchObject({ recovered: 0, unreadable: false });
    expect(d.secure.has(STORAGE_NOTICE)).toBe(false);
  });

  it("rejects when a fresh file will not open either, for the startup error screen", async () => {
    const d = device({ failNewFiles: true });
    d.secure.set(DB_KEY, "device-key");
    d.oldFile("lost-key", []);
    await expect(openLocalStore(d.deps)).rejects.toThrow("disk I/O error");
  });
});

describe("A66: Compass never sits on a blank screen when startup fails", () => {
  it("shows a startup error with a retry, and the storage notice on Today", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const layout = read("../app/_layout.tsx");
    expect(layout).toContain('testID="startup-failed"');
    expect(layout).toContain("onRetry={retryStartup}");
    const provider = read("../src/runtime/CompassProvider.tsx");
    expect(provider).toMatch(/\.catch\(\(error: unknown\) => \{\s+if \(!stopped\) setStartupError/);
    expect(read("../app/(tabs)/today.tsx")).toContain("<StorageResetNotice />");
  });
});

describe("C-22: the storage reset notice never carries over to the next person", () => {
  /** The device's flag, deleted as the sign-out handler deletes it (dismissStorageNotice). */
  const flagOn = (d: ReturnType<typeof device>) => ({
    getItem: d.deps.getItem,
    deleteItem: (key: string) => {
      d.secure.delete(key);
      return Promise.resolve();
    },
  });
  /** Replaces the store with one whose old file cannot be read, which raises the notice. */
  async function replaceStore(d: ReturnType<typeof device>) {
    d.secure.set(DB_KEY, "device-key");
    d.oldFile("lost-key", [[OUTBOX_TABLE, "m1", unsent("m1")]]);
    await openLocalStore(d.deps);
    expect(d.secure.get(STORAGE_NOTICE)).toBe("1");
  }

  it("deletes the saved flag when no one signed in before the store opened, so the next person never sees it", async () => {
    const d = device();
    const flag = flagOn(d);
    // A cold launch with no one signed in: the signed-out handler runs first and finds nothing to delete.
    let signedOut = true;
    await flag.deleteItem(STORAGE_NOTICE);
    await replaceStore(d);
    expect(await settleStorageNotice(flag, () => signedOut)).toBe(false);
    expect(d.secure.has(STORAGE_NOTICE)).toBe(false);
    // The next person signs in, and on their next launch nothing is pending.
    signedOut = false;
    expect(await settleStorageNotice(flag, () => signedOut)).toBe(false);
  });

  it("tells the person signed in when the store was replaced, until they dismiss it", async () => {
    const d = device();
    const flag = flagOn(d);
    await replaceStore(d);
    expect(await settleStorageNotice(flag, () => false)).toBe(true);
    expect(d.secure.get(STORAGE_NOTICE)).toBe("1");
  });

  it("counts a sign-out that lands while the flag is being read", async () => {
    const d = device();
    let signedOut = false;
    const flag = {
      getItem: async (key: string) => {
        const value = await d.deps.getItem(key);
        signedOut = true;
        return value;
      },
      deleteItem: flagOn(d).deleteItem,
    };
    await replaceStore(d);
    expect(await settleStorageNotice(flag, () => signedOut)).toBe(false);
    expect(d.secure.has(STORAGE_NOTICE)).toBe(false);
  });

  it("is cleared when the session ends, and the provider settles it with the launch's sign-in state", async () => {
    const { readFileSync } = await import("node:fs");
    const provider = readFileSync(
      new URL("../src/runtime/CompassProvider.tsx", import.meta.url),
      "utf8",
    );
    const listener = provider.slice(provider.indexOf("client.auth.onAuthStateChange("));
    const signedOut = listener.slice(
      listener.indexOf("if (!next) {"),
      listener.indexOf('setPhase({ kind: "signed-out" });'),
    );
    expect(signedOut).toContain("setStorageNotice(false);");
    expect(signedOut).toContain("void forgetStorageNotice();");
    expect(provider).toContain(
      "setStorageNotice(await storageNoticePending(() => signedOutRef.current));",
    );
  });
});
