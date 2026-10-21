/**
 * Opening the offline database, and recovering when it will not open (A66, RRR-111; the SQLCipher fix it
 * follows is A68-001, RRR-113).
 *
 * Builds made before A68-001 wrote a plain SQLite file on iOS, because op-sqlite was built without
 * SQLCipher there. A build with SQLCipher cannot read that file with the device's key ("hmac check failed
 * for pgno=1"), and nor can any build once the key is gone from the keychain. Compass then sat on a blank
 * screen. Now an open that fails:
 *
 * 1. reads the unsent outbox from the old file if it is still readable (plain SQLite, as pre-A68 builds
 *    wrote it), so those writes are not lost;
 * 2. creates a fresh encrypted file under a new name, which the device remembers, and carries the unsent
 *    writes into it; everything else downloads again from the server on the next refresh;
 * 3. deletes the old file, which may hold offline data in the clear;
 * 4. reports what happened, so the person is told once when unsent offline work could not be recovered.
 *
 * A fresh file that will not open either is a startup error: the caller shows it with a retry, never a
 * blank screen. Nothing here imports a native module, so the tests run it against node:sqlite.
 */
import { OUTBOX_TABLE, PersistentStore, SCHEMA_SQL, type SqlExecutor } from "@xos/sync";

/** The part of an op-sqlite connection this module uses. */
export interface DatabaseConnection {
  execute(
    sql: string,
    params?: (string | number | null)[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  transaction(
    work: (tx: { execute: DatabaseConnection["execute"] }) => Promise<void>,
  ): Promise<void>;
  close(): void;
  delete(): void;
}

export interface LocalDatabaseDeps {
  /** Opens (or creates) a database file; a null key opens it as plain SQLite. */
  readonly open: (name: string, key: string | null) => DatabaseConnection;
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly newKey: () => string;
  readonly now: () => number;
}

export interface StoreRecovery {
  /** Unsent writes carried over from the old file. */
  readonly recovered: number;
  /** The old file could not be read at all, so any unsent offline work on it is gone. */
  readonly unreadable: boolean;
  /** Why the old file would not open, for the support log. */
  readonly reason: string;
}

export interface OpenedStore {
  readonly store: PersistentStore;
  /** Null when the database opened normally. */
  readonly recovery: StoreRecovery | null;
}

export const DB_KEY = "xos.compass.db-key";
/** The current database file name; it changes when a file that would not open is replaced. */
export const DB_NAME = "xos.compass.db-name";
export const DEFAULT_DB_NAME = "compass.sqlite";
/** Set when unsent work may have been lost, until the person has seen the notice. */
export const STORAGE_NOTICE = "xos.compass.storage-reset-notice";

const ROWS_TABLE = "xos_local_rows";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function executor(db: DatabaseConnection): SqlExecutor {
  return {
    transaction: (statements) =>
      db.transaction(async (tx) => {
        for (const s of statements) await tx.execute(s.sql, s.params as (string | number | null)[]);
      }),
    all: async (sql, params = []) =>
      (await db.execute(sql, params as (string | number | null)[])).rows,
  };
}

/** Opens a file and proves it can be read; SQLCipher only fails on the first read, not on open. */
async function openReadable(
  deps: LocalDatabaseDeps,
  name: string,
  key: string | null,
): Promise<DatabaseConnection> {
  const db = deps.open(name, key);
  try {
    await db.execute("select count(*) as n from sqlite_master");
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Already closed or never opened; the read error is the one that matters.
    }
    throw error;
  }
}

async function configured(db: DatabaseConnection): Promise<SqlExecutor> {
  // Writers wait briefly for the lock instead of failing; WAL lets the sync reads run beside a write.
  await db.execute("PRAGMA busy_timeout = 5000");
  await db.execute("PRAGMA journal_mode = WAL");
  return executor(db);
}

/** The unsent outbox rows of a file that opens as plain SQLite, or null when it cannot be read. */
async function readUnsent(
  deps: LocalDatabaseDeps,
  name: string,
): Promise<Record<string, unknown>[] | null> {
  let db: DatabaseConnection;
  try {
    db = await openReadable(deps, name, null);
  } catch {
    return null;
  }
  try {
    const tables = await db.execute(
      "select name from sqlite_master where type = 'table' and name = ?",
      [ROWS_TABLE],
    );
    if (tables.rows.length === 0) return [];
    return (
      await db.execute(`select table_name, id, data from ${ROWS_TABLE} where table_name = ?`, [
        OUTBOX_TABLE,
      ])
    ).rows;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Opens the offline store with the device's key, recovering from a file it cannot read. Throws only when
 * a fresh file will not open either.
 */
export async function openLocalStore(deps: LocalDatabaseDeps): Promise<OpenedStore> {
  let key = await deps.getItem(DB_KEY);
  if (!key) {
    key = deps.newKey();
    await deps.setItem(DB_KEY, key);
  }
  const name = (await deps.getItem(DB_NAME)) ?? DEFAULT_DB_NAME;

  let reason: string;
  try {
    const db = await openReadable(deps, name, key);
    return { store: await PersistentStore.open(await configured(db)), recovery: null };
  } catch (error) {
    reason = message(error);
  }

  const unsent = await readUnsent(deps, name);
  const freshName = `compass-${deps.now()}.sqlite`;
  const fresh = await openReadable(deps, freshName, key);
  const exec = await configured(fresh);
  if (unsent && unsent.length > 0) {
    await exec.transaction([
      { sql: SCHEMA_SQL, params: [] },
      ...unsent.map((row) => ({
        sql: `insert or replace into ${ROWS_TABLE} (table_name, id, data) values (?, ?, ?)`,
        params: [String(row["table_name"]), String(row["id"]), String(row["data"])],
      })),
    ]);
  }
  const store = await PersistentStore.open(exec);
  await deps.setItem(DB_NAME, freshName);
  if (!unsent) await deps.setItem(STORAGE_NOTICE, "1");
  try {
    // The old file may hold offline data in the clear (pre-A68 iOS builds); it is never opened again.
    deps.open(name, null).delete();
  } catch {
    // A file that cannot be removed now stays unused; the new name keeps it out of the way.
  }
  return { store, recovery: { recovered: unsent?.length ?? 0, unreadable: !unsent, reason } };
}
