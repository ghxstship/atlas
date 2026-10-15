/**
 * A durable local store: an in-memory working copy that commits every transaction to SQLite before it
 * resolves.
 *
 * Mobile SQLite drivers are asynchronous, while the outbox needs synchronous reads inside a transaction
 * (read the queue, pick the next sequence number, write). The working copy gives that; the SQL write-behind
 * gives durability. A transaction is visible to readers only after SQLite has committed it, so a crash
 * between the two never shows a change that was not saved. On device the database is SQLCipher-encrypted
 * (Section 13); the executor is the encrypted connection.
 */
import type { LocalStore, Row, RowFilter, StoreListener, StoreTransaction } from "./store";

/** The minimum a SQLite connection must offer: op-sqlite, PowerSync's database and node:sqlite all fit. */
export interface SqlExecutor {
  /** Runs statements in one SQLite transaction. */
  transaction(statements: readonly { sql: string; params: readonly unknown[] }[]): Promise<void>;
  all(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

const TABLE = "xos_local_rows";

export const SCHEMA_SQL = `create table if not exists ${TABLE} (
  table_name text not null,
  id text not null,
  data text not null,
  primary key (table_name, id)
)`;

type Change =
  { kind: "put"; table: string; row: Row } | { kind: "remove"; table: string; id: string };

export class PersistentStore implements LocalStore {
  readonly #sql: SqlExecutor;
  #tables = new Map<string, Map<string, Row>>();
  readonly #listeners = new Set<StoreListener>();
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  /** Opens the store, creating its table and loading every row into the working copy. */
  static async open(sql: SqlExecutor): Promise<PersistentStore> {
    await sql.transaction([{ sql: SCHEMA_SQL, params: [] }]);
    const store = new PersistentStore(sql);
    for (const record of await sql.all(`select table_name, id, data from ${TABLE}`)) {
      const table = String(record["table_name"]);
      let rows = store.#tables.get(table);
      if (!rows) {
        rows = new Map();
        store.#tables.set(table, rows);
      }
      rows.set(String(record["id"]), Object.freeze(JSON.parse(String(record["data"])) as Row));
    }
    return store;
  }

  get(table: string, id: string): Promise<Row | undefined> {
    return Promise.resolve(this.#tables.get(table)?.get(id));
  }

  list(table: string, filter?: RowFilter): Promise<Row[]> {
    const rows = [...(this.#tables.get(table)?.values() ?? [])];
    return Promise.resolve(filter ? rows.filter(filter) : rows);
  }

  /** Transactions run one at a time, in call order, so each sees the last one's committed state. */
  transaction<T>(work: (tx: StoreTransaction) => T): Promise<T> {
    const run = this.#queue.then(() => this.#commit(work));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #commit<T>(work: (tx: StoreTransaction) => T): Promise<T> {
    const draft = new Map([...this.#tables].map(([name, rows]) => [name, new Map(rows)]));
    const changes: Change[] = [];
    const tx: StoreTransaction = {
      get: (table, id) => draft.get(table)?.get(id),
      list: (table, filter) => {
        const rows = [...(draft.get(table)?.values() ?? [])];
        return filter ? rows.filter(filter) : rows;
      },
      put: (table, row) => {
        let rows = draft.get(table);
        if (!rows) {
          rows = new Map();
          draft.set(table, rows);
        }
        const frozen = Object.freeze({ ...row });
        rows.set(row.id, frozen);
        changes.push({ kind: "put", table, row: frozen });
      },
      remove: (table, id) => {
        if (draft.get(table)?.delete(id)) changes.push({ kind: "remove", table, id });
      },
    };
    const result = work(tx);
    if (changes.length > 0) {
      await this.#sql.transaction(
        changes.map((c) =>
          c.kind === "put"
            ? {
                sql: `insert into ${TABLE} (table_name, id, data) values (?, ?, ?) on conflict (table_name, id) do update set data = excluded.data`,
                params: [c.table, c.row.id, JSON.stringify(c.row)],
              }
            : {
                sql: `delete from ${TABLE} where table_name = ? and id = ?`,
                params: [c.table, c.id],
              },
        ),
      );
    }
    this.#tables = draft;
    for (const table of new Set(changes.map((c) => c.table))) this.#emit(table);
    return result;
  }

  tables(): Promise<string[]> {
    return Promise.resolve(
      [...this.#tables].filter(([, rows]) => rows.size > 0).map(([name]) => name),
    );
  }

  wipe(): Promise<void> {
    const run = this.#queue.then(async () => {
      await this.#sql.transaction([{ sql: `delete from ${TABLE}`, params: [] }]);
      const names = [...this.#tables.keys()];
      this.#tables = new Map();
      for (const name of names) this.#emit(name);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(table: string): void {
    for (const listener of this.#listeners) listener(table);
  }
}
