/**
 * Idempotency-Key on POST (ADR 0003), stored in A18's per-tenant ledger `app.idempotency_keys`
 * through `app.begin_idempotent_request`, `app.complete_idempotent_request` and
 * `app.abandon_idempotent_request` (migration 0510), called as the caller.
 *
 * The request hash covers the caller, the method, the path and the canonical body, so the same key
 * from another member of the org, or with a different body, is a 409 and never replays someone
 * else's response. Only success responses are stored; a failed request releases its key so the
 * client can retry with it.
 */
import { createHash } from "node:crypto";
import { conflict } from "../problem.ts";
import type { RequestContext } from "./context.ts";

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type BeginOutcome =
  | { readonly outcome: "proceed" }
  | { readonly outcome: "replay"; readonly response: StoredResponse }
  | { readonly outcome: "in_progress" }
  | { readonly outcome: "mismatch" };

export interface IdempotencyStore {
  begin(context: RequestContext, key: string, hash: Buffer): Promise<BeginOutcome>;
  complete(context: RequestContext, key: string, response: StoredResponse): Promise<void>;
  abandon(context: RequestContext, key: string): Promise<void>;
}

/** JSON with object keys sorted, so equal bodies hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestHash(userId: string, method: string, path: string, body: unknown): Buffer {
  return createHash("sha256")
    .update(`${userId}\n${method.toUpperCase()} ${path}\n${canonicalJson(body ?? null)}`)
    .digest();
}

interface RpcError {
  readonly code?: string;
  readonly message: string;
  readonly hint?: string | null;
  readonly details?: string | null;
}

type Rpc = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: RpcError | null }>;

function rpcOf(context: RequestContext): Rpc {
  const db = context.db as unknown as { rpc: Rpc };
  return (name, args) => db.rpc(name, args);
}

/** The store over A18's ledger. Requests without an active org are not stored. */
export const databaseIdempotencyStore: IdempotencyStore = {
  async begin(context, key, hash) {
    if (context.org === null) return { outcome: "proceed" };
    const { data, error } = await rpcOf(context)("begin_idempotent_request", {
      p_org_id: context.org.id,
      p_key: key,
      p_request_hash: `\\x${hash.toString("hex")}`,
    });
    if (error !== null) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as
      { outcome: string; response_status: number | null; response_body: unknown } | undefined;
    switch (row?.outcome) {
      case "proceed":
        return { outcome: "proceed" };
      case "replay":
        return {
          outcome: "replay",
          response: { status: row.response_status ?? 200, body: row.response_body },
        };
      case "in_progress":
        return { outcome: "in_progress" };
      case "mismatch":
        return { outcome: "mismatch" };
      default:
        throw new Error(`begin_idempotent_request returned ${JSON.stringify(data)}.`);
    }
  },
  async complete(context, key, response) {
    if (context.org === null) return;
    const { error } = await rpcOf(context)("complete_idempotent_request", {
      p_org_id: context.org.id,
      p_key: key,
      p_response_status: response.status,
      p_response_body: response.body ?? null,
    });
    if (error !== null) throw error;
  },
  async abandon(context, key) {
    if (context.org === null) return;
    const { error } = await rpcOf(context)("abandon_idempotent_request", {
      p_org_id: context.org.id,
      p_key: key,
    });
    if (error !== null) throw error;
  },
};

export function inProgress() {
  return conflict("A request with this Idempotency-Key is still running. Retry when it finishes.");
}

export function keyReused() {
  return conflict("This Idempotency-Key was used with a different request body.");
}
