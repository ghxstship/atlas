/**
 * The device's sync session: writes downloaded rows through the scope check, keeps optimistic rows that
 * still have queued writes, purges rows when the scope narrows, and wipes everything on remote sign-out.
 *
 * Several orgs (Section 4.5.7 org switching). A person in more than one org holds one scope per org: a
 * membership scope for each member org and an engagement scope for each org that engages them. A row is
 * stored when one of those scopes admits it, so the device holds each org's rows under that org's own
 * rules and nothing from an org the person has no part in. Dropping an org's scope (the membership ended)
 * purges every row only that org admitted.
 */

import { OUTBOX_TABLE } from "./outbox";
import type { Mutation } from "./mutation";
import { admits, type DownloadScope } from "./scope";
import type { LocalStore, Row } from "./store";

export interface IngestReport {
  readonly written: number;
  /** Rows the scope refused; never stored. */
  readonly refused: number;
  /** Rows not overwritten because the device has queued writes to them. */
  readonly deferred: number;
  readonly removed: number;
}

/**
 * Device-local tables (the outbox, resumable upload state) start with an underscore. Downloads never write
 * them and the scope check never purges them; signing out wipes them with everything else.
 */
export function isDeviceTable(table: string): boolean {
  return table.startsWith("_");
}

/** True when one of the person's per-org scopes admits the row. */
export function admitsAny(table: string, row: Row, scopes: readonly DownloadScope[]): boolean {
  return scopes.some((scope) => admits(table, row, scope));
}

function asList(scope: DownloadScope | readonly DownloadScope[]): readonly DownloadScope[] {
  return Array.isArray(scope) ? (scope as readonly DownloadScope[]) : [scope as DownloadScope];
}

export class SyncSession {
  readonly #store: LocalStore;
  #scopes: readonly DownloadScope[];

  constructor(store: LocalStore, scope: DownloadScope | readonly DownloadScope[]) {
    this.#store = store;
    this.#scopes = asList(scope);
  }

  /** The first scope: the only one for a person in a single org. */
  get scope(): DownloadScope {
    const first = this.#scopes[0];
    if (!first) throw new Error("a sync session needs at least one scope");
    return first;
  }

  /** Every per-org scope the device holds rows under. */
  get scopes(): readonly DownloadScope[] {
    return this.#scopes;
  }

  /**
   * Applies one downloaded batch for a table: upserts and server deletions. Rows outside every scope are
   * refused, and a server deletion of a row outside the scope removes it if the device somehow held it.
   */
  async ingest(
    table: string,
    upserts: readonly Row[],
    deletedIds: readonly string[] = [],
  ): Promise<IngestReport> {
    if (table === OUTBOX_TABLE) throw new Error("the outbox is never written by download");
    if (isDeviceTable(table)) throw new Error(`${table} is device-local; downloads never write it`);
    return this.#store.transaction((tx) => {
      const queuedRows = new Set(
        tx
          .list(OUTBOX_TABLE)
          .map((row) => row as unknown as Mutation)
          .filter((m) => m.table === table)
          .map((m) => m.rowId),
      );
      let written = 0;
      let refused = 0;
      let deferred = 0;
      let removed = 0;
      for (const row of upserts) {
        if (!admitsAny(table, row, this.#scopes)) {
          refused += 1;
          if (tx.get(table, row.id)) {
            tx.remove(table, row.id);
            removed += 1;
          }
          continue;
        }
        if (queuedRows.has(row.id)) {
          deferred += 1;
          continue;
        }
        tx.put(table, row);
        written += 1;
      }
      for (const id of deletedIds) {
        if (queuedRows.has(id) || !tx.get(table, id)) continue;
        tx.remove(table, id);
        removed += 1;
      }
      return { written, refused, deferred, removed };
    });
  }

  /**
   * Applies a full snapshot of a table: upserts every row and removes local rows the snapshot no longer
   * holds, except rows with queued writes. Used by full pulls, which carry no deletion log.
   */
  async replace(table: string, rows: readonly Row[]): Promise<IngestReport> {
    const present = new Set(rows.map((r) => r.id));
    const gone = (await this.#store.list(table)).map((r) => r.id).filter((id) => !present.has(id));
    return this.ingest(table, rows, gone);
  }

  /**
   * Replaces the scope, such as when an engagement reaches Complete and Compass access ends (Section 8.7) or
   * the membership in one of several orgs ends, and removes every stored row no remaining scope admits.
   * Returns the number of rows removed.
   */
  async narrow(scope: DownloadScope | readonly DownloadScope[]): Promise<number> {
    const scopes = asList(scope);
    this.#scopes = scopes;
    const tables = (await this.#store.tables()).filter((t) => !isDeviceTable(t));
    return this.#store.transaction((tx) => {
      let removed = 0;
      for (const table of tables) {
        for (const row of tx.list(table)) {
          if (!admitsAny(table, row, scopes)) {
            tx.remove(table, row.id);
            removed += 1;
          }
        }
      }
      return removed;
    });
  }

  /**
   * Remote sign-out from Atlas wipes the local store (Section 13), queued writes included. Returns how many
   * queued writes were discarded so the sign-in screen can say so.
   */
  async remoteSignOut(): Promise<number> {
    const discarded = (await this.#store.list(OUTBOX_TABLE)).length;
    await this.#store.wipe();
    return discarded;
  }
}
