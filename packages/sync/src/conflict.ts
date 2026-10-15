/**
 * Conflict rules: what an upload result means for the queued write.
 */

import type { Mutation, MutationError } from "./mutation";
import type { Row } from "./store";

/** What the uploader reports for one mutation. */
export type UploadOutcome =
  | { readonly kind: "applied"; readonly serverRow?: Row | null }
  /** The server already holds this write: the client id or mutation id was seen before. */
  | { readonly kind: "duplicate"; readonly serverRow?: Row | null }
  /** The server refused the write for good: a rule (XR001), a permission or a constraint. */
  | { readonly kind: "refused"; readonly error: MutationError; readonly serverRow?: Row | null }
  /** The server row changed since the device's base (guarded update or compare-and-set mismatch). */
  | { readonly kind: "stale"; readonly serverRow: Row | null; readonly error?: MutationError }
  /** Network loss, timeout, rate limit or a server fault: try again later. */
  | { readonly kind: "transient"; readonly error: MutationError; readonly retryAfterMs?: number }
  /** The session expired; uploads wait for sign-in. */
  | { readonly kind: "unauthorized"; readonly error: MutationError };

/** What the engine does next. */
export type Decision =
  | { readonly kind: "apply"; readonly serverRow: Row | null }
  | { readonly kind: "conflict"; readonly error: MutationError; readonly serverRow: Row | null }
  | {
      readonly kind: "rebase";
      readonly serverRow: Row;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "retry"; readonly error: MutationError; readonly retryAfterMs: number | null }
  | { readonly kind: "halt"; readonly error: MutationError };

export const STALE_ERROR: MutationError = {
  code: "stale",
  message: "Someone else changed this record after you did.",
};

/** Applies the mutation's conflict policy to an upload outcome. */
export function decide(mutation: Mutation, outcome: UploadOutcome): Decision {
  switch (outcome.kind) {
    case "applied":
    case "duplicate":
      return { kind: "apply", serverRow: outcome.serverRow ?? null };
    case "refused":
      return { kind: "conflict", error: outcome.error, serverRow: outcome.serverRow ?? null };
    case "transient":
      return { kind: "retry", error: outcome.error, retryAfterMs: outcome.retryAfterMs ?? null };
    case "unauthorized":
      return { kind: "halt", error: outcome.error };
    case "stale":
      return decideStale(mutation, outcome.serverRow, outcome.error ?? STALE_ERROR);
  }
}

function decideStale(mutation: Mutation, serverRow: Row | null, error: MutationError): Decision {
  if (mutation.policy === "append") {
    // A ledger insert cannot go stale; a server that says so has the row already.
    return { kind: "apply", serverRow };
  }
  if (mutation.policy === "merge" && serverRow && mutation.base) {
    const merged = mergeFields(mutation.base, serverRow, mutation.payload);
    if (merged) return { kind: "rebase", serverRow, payload: merged };
  }
  return { kind: "conflict", error, serverRow };
}

/**
 * Three-way field merge. Returns the device's payload to send on top of the server row when the server
 * changed only fields the device left alone, or null when both changed the same field to different values.
 */
export function mergeFields(
  base: Row,
  server: Row,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const toSend: Record<string, unknown> = {};
  for (const [field, mine] of Object.entries(payload)) {
    const theirs = server[field];
    const before = base[field];
    const serverChanged = !sameValue(before, theirs);
    if (serverChanged && !sameValue(theirs, mine)) return null;
    if (!sameValue(theirs, mine)) toSend[field] = mine;
  }
  return toSend;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A Postgres or PostgREST error as the Supabase client returns it, or a thrown fetch failure. */
export interface ServerError {
  readonly status?: number;
  readonly code?: string;
  readonly message?: string;
  readonly details?: string;
}

/**
 * Maps a server error to an outcome. XR001 is the refusal SQLSTATE (Section 3.7); 42501 is a permission
 * refusal; class 23 is a constraint. A unique violation on the primary key means the replayed insert is
 * already there.
 */
export function classifyServerError(error: ServerError, retryAfterMs?: number): UploadOutcome {
  const code = error.code ?? "";
  const message = error.message ?? "The server did not accept the change.";
  const status = error.status ?? 0;
  if (code === "23505" && /_pkey\b/.test(`${error.message ?? ""} ${error.details ?? ""}`)) {
    return { kind: "duplicate" };
  }
  if (status === 401 || code === "PGRST301" || code === "PGRST303") {
    return { kind: "unauthorized", error: { code: code || "401", message } };
  }
  if (
    code === "XR001" ||
    code === "42501" ||
    code.startsWith("23") ||
    code === "22023" ||
    code === "P0001"
  ) {
    return { kind: "refused", error: { code, message } };
  }
  if (
    code === "40001" ||
    code === "40P01" ||
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  ) {
    const outcome: UploadOutcome = {
      kind: "transient",
      error: { code: code || String(status), message },
    };
    return retryAfterMs === undefined ? outcome : { ...outcome, retryAfterMs };
  }
  return { kind: "refused", error: { code: code || String(status), message } };
}
