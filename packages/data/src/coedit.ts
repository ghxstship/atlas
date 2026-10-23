import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Live co-editing (Section 5, ADR 0044) over migration 1453: open a row's document, append Yjs
 * updates, and fold them into a snapshot. Updates and states travel as base64; editors broadcast
 * them over the document's private Realtime channel and keep them here for recovery.
 */

export interface DocUpdate {
  readonly seq: number;
  /** Base64 Yjs update. */
  readonly update: string;
}

export interface OpenedDoc {
  readonly docId: string;
  readonly generation: number;
  /** Base64 Yjs state covering every update up to throughSeq, or null before a compaction. */
  readonly state: string | null;
  readonly throughSeq: number;
  readonly lastSeq: number;
  /** The text an empty document is seeded from: the row's field, or the last compacted text. */
  readonly seedText: string | null;
  readonly canEdit: boolean;
  readonly updates: readonly DocUpdate[];
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function toOpenedDoc(raw: unknown): OpenedDoc | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["doc_id"] !== "string") return null;
  const updates = Array.isArray(o["updates"]) ? (o["updates"] as Record<string, unknown>[]) : [];
  return {
    docId: o["doc_id"],
    generation: num(o["generation"]),
    state: typeof o["state"] === "string" ? o["state"] : null,
    throughSeq: num(o["through_seq"]),
    lastSeq: num(o["last_seq"]),
    seedText: typeof o["seed_text"] === "string" ? o["seed_text"] : null,
    canEdit: o["can_edit"] === true,
    updates: updates.flatMap((u) =>
      typeof u["update"] === "string" ? [{ seq: num(u["seq"]), update: u["update"] }] : [],
    ),
  };
}

export async function openDoc(
  db: XosClient,
  input: {
    readonly table: string;
    readonly id: string;
    readonly docKey: string;
    readonly since?: number;
  },
): Promise<Result<OpenedDoc>> {
  const { data, error } = await db.rpc("open_doc", {
    p_subject_table: input.table,
    p_subject_id: input.id,
    p_doc_key: input.docKey,
    p_since: input.since ?? 0,
  });
  if (error) return fail(toDataError(error));
  const doc = toOpenedDoc(data);
  return doc
    ? ok(doc)
    : fail({ kind: "unexpected", message: "open_doc answered without a document" });
}

export async function appendDocUpdate(
  db: XosClient,
  input: { readonly docId: string; readonly generation: number; readonly update: string },
): Promise<Result<number>> {
  const { data, error } = await db.rpc("append_doc_update", {
    p_doc_id: input.docId,
    p_generation: input.generation,
    p_update: input.update,
  });
  if (error) return fail(toDataError(error));
  return ok(num(data));
}

export async function compactDoc(
  db: XosClient,
  input: {
    readonly docId: string;
    readonly generation: number;
    readonly state: string;
    readonly through: number;
    readonly text: string;
  },
): Promise<Result<{ compacted: boolean; throughSeq: number }>> {
  const { data, error } = await db.rpc("compact_doc", {
    p_doc_id: input.docId,
    p_generation: input.generation,
    p_state: input.state,
    p_through: input.through,
    p_text: input.text,
  });
  if (error) return fail(toDataError(error));
  const o = (data ?? {}) as Record<string, unknown>;
  return ok({ compacted: o["compacted"] === true, throughSeq: num(o["through_seq"]) });
}
