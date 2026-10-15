/**
 * The sync engine: drains the outbox in order when the network allows, and applies the conflict rules.
 *
 * Ordering. Mutations upload in queue order. A transient failure stops the drain, so nothing overtakes a
 * write that is waiting to retry. A refused write is parked in the resolution sheet; it holds back only
 * later writes to the same record and writes that depend on it, so one refusal never freezes the queue.
 *
 * Airplane mode. The engine checks the network before every upload, not just at the start of a drain, and
 * never uploads while offline. An upload cut off mid-flight is retried with the same ids, and the server
 * treats the replay as already applied, so a write is never lost and never doubled.
 */

import { classifyServerError, decide, type UploadOutcome } from "./conflict";
import type { Mutation, MutationError } from "./mutation";
import { canUpload, cameOnline, OFFLINE, type NetworkState } from "./network";
import { Outbox } from "./outbox";
import type { LocalStore } from "./store";

export interface Uploader {
  upload(mutation: Mutation): Promise<UploadOutcome>;
}

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
}

export interface SyncEngineOptions {
  readonly store: LocalStore;
  readonly uploader: Uploader;
  readonly outbox?: Outbox;
  readonly network?: NetworkState;
  readonly now?: () => number;
  /** Uniform random in [0, 1) for backoff jitter. */
  readonly random?: () => number;
  readonly backoff?: BackoffOptions;
  /** Automatic field merges allowed per mutation in one drain before it goes to the resolution sheet. */
  readonly maxRebases?: number;
}

export type DrainStop = "empty" | "offline" | "backoff" | "transient" | "auth" | "blocked";

export interface DrainReport {
  readonly uploaded: number;
  readonly conflicts: number;
  readonly stoppedBy: DrainStop;
}

export interface SyncStatus {
  readonly online: boolean;
  readonly draining: boolean;
  readonly queued: number;
  readonly conflicts: number;
  readonly authRequired: boolean;
  readonly lastError: MutationError | null;
  readonly lastDrainAt: number | null;
}

export type StatusListener = (status: SyncStatus) => void;

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 2_000, maxMs: 5 * 60_000 };

export class SyncEngine {
  readonly outbox: Outbox;
  readonly #uploader: Uploader;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #backoff: BackoffOptions;
  readonly #maxRebases: number;
  readonly #listeners = new Set<StatusListener>();
  #network: NetworkState;
  #draining: Promise<DrainReport> | null = null;
  #authRequired = false;
  #lastError: MutationError | null = null;
  #lastDrainAt: number | null = null;

  constructor(options: SyncEngineOptions) {
    this.#now = options.now ?? Date.now;
    this.outbox = options.outbox ?? new Outbox(options.store, { now: this.#now });
    this.#uploader = options.uploader;
    this.#network = options.network ?? OFFLINE;
    this.#random = options.random ?? Math.random;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#maxRebases = options.maxRebases ?? 3;
    options.store.subscribe(() => {
      void this.#emit();
    });
  }

  get network(): NetworkState {
    return this.#network;
  }

  /** Feeds a connectivity change; coming back online drains the queue. */
  setNetwork(next: NetworkState): Promise<DrainReport> | null {
    const previous = this.#network;
    this.#network = next;
    void this.#emit();
    return cameOnline(previous, next) ? this.drain() : null;
  }

  /** Sign-in restored: uploads may resume. */
  authRestored(): Promise<DrainReport> {
    this.#authRequired = false;
    return this.drain();
  }

  /** Drains the queue. Concurrent calls share one drain. */
  drain(): Promise<DrainReport> {
    if (this.#draining) return this.#draining;
    const run = this.#drain().finally(() => {
      this.#draining = null;
      this.#lastDrainAt = this.#now();
      void this.#emit();
    });
    this.#draining = run;
    void this.#emit();
    return run;
  }

  subscribe(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    void this.status().then(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async status(): Promise<SyncStatus> {
    const all = await this.outbox.all();
    return {
      online: canUpload(this.#network),
      draining: this.#draining !== null,
      queued: all.length,
      conflicts: all.filter((m) => m.status === "conflict").length,
      authRequired: this.#authRequired,
      lastError: this.#lastError,
      lastDrainAt: this.#lastDrainAt,
    };
  }

  backoffMs(attempts: number, retryAfterMs: number | null = null): number {
    const exponential = Math.min(this.#backoff.maxMs, this.#backoff.baseMs * 2 ** attempts);
    const jittered = Math.round(exponential * (0.5 + this.#random() * 0.5));
    return retryAfterMs === null ? jittered : Math.max(retryAfterMs, jittered);
  }

  async #drain(): Promise<DrainReport> {
    let uploaded = 0;
    let conflicts = 0;
    const rebases = new Map<string, number>();
    for (;;) {
      if (this.#authRequired) return { uploaded, conflicts, stoppedBy: "auth" };
      if (!canUpload(this.#network)) return { uploaded, conflicts, stoppedBy: "offline" };
      const next = nextReady(await this.outbox.all(), this.#now());
      if (next.kind !== "ready") return { uploaded, conflicts, stoppedBy: next.kind };
      const mutation = next.mutation;
      const decision = decide(mutation, await this.#upload(mutation));
      switch (decision.kind) {
        case "apply":
          await this.outbox.markApplied(mutation.id, decision.serverRow);
          uploaded += 1;
          this.#lastError = null;
          break;
        case "rebase": {
          const count = (rebases.get(mutation.id) ?? 0) + 1;
          rebases.set(mutation.id, count);
          if (count > this.#maxRebases) {
            await this.outbox.markConflict(
              mutation.id,
              { code: "stale", message: "This record keeps changing on the server." },
              decision.serverRow,
            );
            conflicts += 1;
          } else {
            await this.outbox.rebase(mutation.id, decision.serverRow, decision.payload);
          }
          break;
        }
        case "conflict":
          await this.outbox.markConflict(mutation.id, decision.error, decision.serverRow);
          conflicts += 1;
          break;
        case "retry":
          await this.outbox.scheduleRetry(
            mutation.id,
            decision.error,
            this.#now() + this.backoffMs(mutation.attempts, decision.retryAfterMs),
          );
          this.#lastError = decision.error;
          return { uploaded, conflicts, stoppedBy: "transient" };
        case "halt":
          this.#authRequired = true;
          this.#lastError = decision.error;
          return { uploaded, conflicts, stoppedBy: "auth" };
      }
    }
  }

  async #upload(mutation: Mutation): Promise<UploadOutcome> {
    try {
      return await this.#uploader.upload(mutation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return classifyServerError({ status: 0, message });
    }
  }

  async #emit(): Promise<void> {
    if (this.#listeners.size === 0) return;
    const status = await this.status();
    for (const listener of this.#listeners) listener(status);
  }
}

type NextReady =
  | { readonly kind: "ready"; readonly mutation: Mutation }
  | { readonly kind: "empty" | "backoff" | "blocked" };

/**
 * The next mutation to upload. Strict queue order among uploadable writes: the first pending write that is
 * not held back by an earlier write to its record or by an unfinished dependency is next, and if it is still
 * waiting out a backoff, nothing behind it goes first.
 */
export function nextReady(queue: readonly Mutation[], nowMs: number): NextReady {
  if (queue.length === 0) return { kind: "empty" };
  const ids = new Set(queue.map((m) => m.id));
  const heldRecords = new Set<string>();
  for (const mutation of queue) {
    const key = `${mutation.table}:${mutation.rowId}`;
    const held = heldRecords.has(key) || mutation.dependsOn.some((dep) => ids.has(dep));
    heldRecords.add(key);
    if (mutation.status !== "pending" || held) continue;
    if (mutation.nextAttemptAt > nowMs) return { kind: "backoff" };
    return { kind: "ready", mutation };
  }
  return { kind: "blocked" };
}
