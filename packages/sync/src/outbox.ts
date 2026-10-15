/**
 * The outbox: an ordered queue of writes kept in the local store itself.
 *
 * Enqueueing applies the optimistic local write and stores the mutation in one transaction (Section 13:
 * writes queue locally with idempotency keys, upload in order, and show a visible queue count).
 */

import { uuidv7 } from "./ids";
import { defaultPolicy, type Mutation, type MutationError, type MutationInput } from "./mutation";
import type { LocalStore, Row, StoreTransaction } from "./store";

export const OUTBOX_TABLE = "_outbox";

export interface OutboxOptions {
  readonly now?: () => number;
  readonly newId?: (nowMs: number) => string;
}

export type Resolution =
  | { readonly action: "discard" }
  | { readonly action: "retry"; readonly payload?: Readonly<Record<string, unknown>> };

function toRow(mutation: Mutation): Row {
  return mutation as unknown as Row;
}

function fromRow(row: Row): Mutation {
  return row as unknown as Mutation;
}

function bySeq(a: Mutation, b: Mutation): number {
  return a.seq - b.seq;
}

export class Outbox {
  readonly #store: LocalStore;
  readonly #now: () => number;
  readonly #newId: (nowMs: number) => string;

  constructor(store: LocalStore, options: OutboxOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? ((ms) => uuidv7(ms));
  }

  /** Queues a write and applies its optimistic local row in the same transaction. */
  async enqueue(input: MutationInput): Promise<Mutation> {
    const nowMs = this.#now();
    return this.#store.transaction((tx) => {
      const queued = tx.list(OUTBOX_TABLE).map(fromRow);
      const seq = queued.reduce((max, m) => Math.max(max, m.seq), 0) + 1;
      const base = tx.get(input.table, input.rowId) ?? null;
      const mutation: Mutation = {
        id: this.#newId(nowMs),
        seq,
        op: input.op,
        target: input.target ?? input.table,
        table: input.table,
        rowId: input.rowId,
        payload: input.payload,
        base: earliestBase(queued, input.table, input.rowId) ?? base,
        policy: input.policy ?? defaultPolicy(input.op),
        dependsOn: input.dependsOn ?? [],
        queuedAt: new Date(nowMs).toISOString(),
        attempts: 0,
        nextAttemptAt: nowMs,
        status: "pending",
        lastError: null,
        serverRow: null,
      };
      if (input.optimistic) tx.put(input.table, input.optimistic);
      tx.put(OUTBOX_TABLE, toRow(mutation));
      return mutation;
    });
  }

  async all(): Promise<Mutation[]> {
    return (await this.#store.list(OUTBOX_TABLE)).map(fromRow).sort(bySeq);
  }

  async get(id: string): Promise<Mutation | undefined> {
    const row = await this.#store.get(OUTBOX_TABLE, id);
    return row ? fromRow(row) : undefined;
  }

  /** The visible queue count: every write not yet confirmed by the server. */
  async count(): Promise<number> {
    return (await this.#store.list(OUTBOX_TABLE)).length;
  }

  async conflicts(): Promise<Mutation[]> {
    return (await this.all()).filter((m) => m.status === "conflict");
  }

  /**
   * The server confirmed the write. The mutation leaves the queue, and the server's row replaces the
   * optimistic one unless a later queued write to the same row is still waiting.
   */
  async markApplied(id: string, serverRow: Row | null = null): Promise<void> {
    await this.#store.transaction((tx) => {
      const mutation = readMutation(tx, id);
      if (!mutation) return;
      tx.remove(OUTBOX_TABLE, id);
      const later = tx
        .list(OUTBOX_TABLE)
        .map(fromRow)
        .filter((m) => m.table === mutation.table && m.rowId === mutation.rowId);
      if (later.length === 0 && serverRow) tx.put(mutation.table, serverRow);
      for (const next of later) {
        tx.put(OUTBOX_TABLE, toRow({ ...next, base: serverRow ?? next.base }));
      }
    });
  }

  async markConflict(id: string, error: MutationError, serverRow: Row | null): Promise<void> {
    await this.#update(id, (m) => ({ ...m, status: "conflict", lastError: error, serverRow }));
  }

  async scheduleRetry(id: string, error: MutationError, nextAttemptAt: number): Promise<void> {
    await this.#update(id, (m) => ({
      ...m,
      attempts: m.attempts + 1,
      lastError: error,
      nextAttemptAt,
    }));
  }

  /** Re-bases a mutation on a newer server row and sends again, used by automatic field merges. */
  async rebase(
    id: string,
    serverRow: Row,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#update(id, (m) => ({ ...m, base: serverRow, payload, nextAttemptAt: this.#now() }));
  }

  /**
   * Settles a conflict from the resolution sheet. Discard drops the device's change and every queued write
   * that depends on it, restoring the server's row (or the row as it was before, when the server sent
   * none). Retry sends again, optionally with an edited payload, based on the server's current row.
   */
  async resolve(id: string, resolution: Resolution): Promise<void> {
    await this.#store.transaction((tx) => {
      const mutation = readMutation(tx, id);
      if (!mutation) return;
      if (resolution.action === "retry") {
        tx.put(
          OUTBOX_TABLE,
          toRow({
            ...mutation,
            payload: resolution.payload ?? mutation.payload,
            base: mutation.serverRow ?? mutation.base,
            status: "pending",
            attempts: 0,
            lastError: null,
            nextAttemptAt: this.#now(),
          }),
        );
        return;
      }
      for (const dropped of withDependents(tx, mutation)) {
        tx.remove(OUTBOX_TABLE, dropped.id);
        const restore = dropped.serverRow ?? dropped.base;
        if (restore) tx.put(dropped.table, restore);
        else tx.remove(dropped.table, dropped.rowId);
      }
    });
  }

  async #update(id: string, change: (m: Mutation) => Mutation): Promise<void> {
    await this.#store.transaction((tx) => {
      const mutation = readMutation(tx, id);
      if (mutation) tx.put(OUTBOX_TABLE, toRow(change(mutation)));
    });
  }
}

function readMutation(tx: StoreTransaction, id: string): Mutation | undefined {
  const row = tx.get(OUTBOX_TABLE, id);
  return row ? fromRow(row) : undefined;
}

/** The base of the first queued write to the row, so a chain of edits reverts to the confirmed state. */
function earliestBase(queued: Mutation[], table: string, rowId: string): Row | null | undefined {
  const first = queued.filter((m) => m.table === table && m.rowId === rowId).sort(bySeq)[0];
  return first ? first.base : undefined;
}

/** The mutation, every later write to the same row, and everything that depends on them, latest first. */
function withDependents(tx: StoreTransaction, root: Mutation): Mutation[] {
  const queued = tx.list(OUTBOX_TABLE).map(fromRow);
  const dropped = new Map<string, Mutation>([[root.id, root]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of queued) {
      if (dropped.has(m.id)) continue;
      const sameRowLater = [...dropped.values()].some(
        (d) => d.table === m.table && d.rowId === m.rowId && m.seq > d.seq,
      );
      if (sameRowLater || m.dependsOn.some((dep) => dropped.has(dep))) {
        dropped.set(m.id, m);
        grew = true;
      }
    }
  }
  return [...dropped.values()].sort((a, b) => b.seq - a.seq);
}
