/**
 * Queued writes. A mutation is the unit the outbox stores and the uploader sends.
 */

import type { Row } from "./store";

/**
 * How the server and the device settle disagreement about one mutation (Section 13: conflicts surface in a
 * resolution sheet).
 *
 * - `append`: a ledger insert (punch, scan, custody hand-over, media). The client id is the key; a replay is
 *   already applied, and the only conflict is a refusal.
 * - `cas`: a state transition through a compare-and-set RPC carrying the expected state. A mismatch means
 *   someone else moved the record first; the person decides.
 * - `guarded`: an update that applies only when the server row still matches the base the person edited.
 * - `merge`: an update whose fields merge with concurrent server edits when they touch different fields,
 *   and conflict only when both sides changed the same field.
 */
export type ConflictPolicy = "append" | "cas" | "guarded" | "merge";

export type MutationOp = "insert" | "update" | "rpc";

export type MutationStatus = "pending" | "conflict";

export interface MutationError {
  readonly code: string;
  readonly message: string;
}

export interface Mutation {
  /** Mutation id, a UUIDv7; the server's replay ledger (app.sync_mutations) is keyed by it. */
  readonly id: string;
  /** Upload order. Strictly increasing per device. */
  readonly seq: number;
  readonly op: MutationOp;
  /** Table for insert and update, RPC name for rpc. */
  readonly target: string;
  /** Local table and row the mutation changes; conflicts and ordering group by it. */
  readonly table: string;
  readonly rowId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The local row before the optimistic write, or null for an insert; used to revert and to merge. */
  readonly base: Row | null;
  readonly policy: ConflictPolicy;
  /** Mutations that must be applied first, such as the incident a photo belongs to. */
  readonly dependsOn: readonly string[];
  /** Device wall time when queued, ISO 8601. */
  readonly queuedAt: string;
  readonly attempts: number;
  /** Earliest wall time, in milliseconds, of the next upload attempt. */
  readonly nextAttemptAt: number;
  readonly status: MutationStatus;
  readonly lastError: MutationError | null;
  /** The server row reported with a conflict, shown beside the device's version in the resolution sheet. */
  readonly serverRow: Row | null;
}

export interface MutationInput {
  readonly op: MutationOp;
  readonly target?: string;
  readonly table: string;
  readonly rowId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly policy?: ConflictPolicy;
  readonly dependsOn?: readonly string[];
  /** The optimistic row to write locally now; omit for an RPC with no local effect. */
  readonly optimistic?: Row | null;
}

export function recordKey(table: string, rowId: string): string {
  return `${table}:${rowId}`;
}

export function defaultPolicy(op: MutationOp): ConflictPolicy {
  if (op === "insert") return "append";
  if (op === "rpc") return "cas";
  return "merge";
}
