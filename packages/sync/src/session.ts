/**
 * The device's sync session: writes downloaded rows through the scope check, keeps optimistic rows that
 * still have queued writes, purges rows when the scope narrows, and wipes everything on remote sign-out.
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

export class SyncSession {
  readonly #store: LocalStore;
  #scope: DownloadScope;

  constructor(store: LocalStore, scope: DownloadScope) {
    this.#store = store;
    this.#scope = scope;
  }

  get scope(): DownloadScope {
    return this.#scope;
  }

  /**
   * Applies one downloaded batch for a table: upserts and server deletions. Rows outside the scope are
   * refused, and a server deletion of a row outside the scope removes it if the device somehow held it.
   */
  async ingest(
    table: string,
    upserts: readonly Row[],
    deletedIds: readonly string[] = [],
  ): Promise<IngestReport> {
    if (table === OUTBOX_TABLE) throw new Error("the outbox is never written by download");
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
        if (!admits(table, row, this.#scope)) {
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
   * Replaces the scope, such as when an engagement reaches Complete and Compass access ends (Section 8.7),
   * and removes every stored row the new scope no longer admits. Returns the number of rows removed.
   */
  async narrow(scope: DownloadScope): Promise<number> {
    this.#scope = scope;
    const tables = (await this.#store.tables()).filter((t) => t !== OUTBOX_TABLE);
    return this.#store.transaction((tx) => {
      let removed = 0;
      for (const table of tables) {
        for (const row of tx.list(table)) {
          if (!admits(table, row, scope)) {
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
