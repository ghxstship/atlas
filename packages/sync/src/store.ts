/**
 * The local store contract and an in-memory implementation.
 *
 * On device the store is PowerSync's encrypted SQLite database (SQLCipher, Section 13); in tests and on the
 * kiosk preview it is the in-memory store below. Both satisfy LocalStore, so the outbox and sync engine never
 * know which one they run on. Optimistic writes and their outbox entries commit in one transaction, so a
 * crash never leaves a local change without its queued upload or the reverse.
 */

export type Row = { readonly id: string } & Readonly<Record<string, unknown>>;

export type RowFilter = (row: Row) => boolean;

export interface StoreTransaction {
  get(table: string, id: string): Row | undefined;
  list(table: string, filter?: RowFilter): Row[];
  put(table: string, row: Row): void;
  remove(table: string, id: string): void;
}

export type StoreListener = (table: string) => void;

export interface LocalStore {
  get(table: string, id: string): Promise<Row | undefined>;
  list(table: string, filter?: RowFilter): Promise<Row[]>;
  /** Runs the work atomically: every write lands or none does. */
  transaction<T>(work: (tx: StoreTransaction) => T): Promise<T>;
  /** Names of the tables that hold rows. */
  tables(): Promise<string[]>;
  /** Removes every row in every table (remote sign-out, Section 13). */
  wipe(): Promise<void>;
  subscribe(listener: StoreListener): () => void;
}

type Tables = Map<string, Map<string, Row>>;

function cloneTables(source: Tables): Tables {
  const copy: Tables = new Map();
  for (const [name, rows] of source) copy.set(name, new Map(rows));
  return copy;
}

export class MemoryStore implements LocalStore {
  #tables: Tables = new Map();
  readonly #listeners = new Set<StoreListener>();

  get(table: string, id: string): Promise<Row | undefined> {
    return Promise.resolve(this.#tables.get(table)?.get(id));
  }

  list(table: string, filter?: RowFilter): Promise<Row[]> {
    return Promise.resolve(listRows(this.#tables, table, filter));
  }

  transaction<T>(work: (tx: StoreTransaction) => T): Promise<T> {
    const draft = cloneTables(this.#tables);
    const touched = new Set<string>();
    const tx: StoreTransaction = {
      get: (table, id) => draft.get(table)?.get(id),
      list: (table, filter) => listRows(draft, table, filter),
      put: (table, row) => {
        let rows = draft.get(table);
        if (!rows) {
          rows = new Map();
          draft.set(table, rows);
        }
        rows.set(row.id, Object.freeze({ ...row }));
        touched.add(table);
      },
      remove: (table, id) => {
        if (draft.get(table)?.delete(id)) touched.add(table);
      },
    };
    let result: T;
    try {
      result = work(tx);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#tables = draft;
    for (const table of touched) this.#emit(table);
    return Promise.resolve(result);
  }

  tables(): Promise<string[]> {
    return Promise.resolve(
      [...this.#tables].filter(([, rows]) => rows.size > 0).map(([name]) => name),
    );
  }

  wipe(): Promise<void> {
    const names = [...this.#tables.keys()];
    this.#tables = new Map();
    for (const name of names) this.#emit(name);
    return Promise.resolve();
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

function listRows(tables: Tables, table: string, filter?: RowFilter): Row[] {
  const rows = [...(tables.get(table)?.values() ?? [])];
  return filter ? rows.filter(filter) : rows;
}
