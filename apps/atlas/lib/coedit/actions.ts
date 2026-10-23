"use server";

import { appendDocUpdate, compactDoc, openDoc, type OpenedDoc } from "@xos/data/coedit";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Live co-editing (Section 5, ADR 0044) as the signed-in person: open a row's document, append a
 * Yjs update, fold updates into a snapshot. The database checks the row's own read and update
 * access on every call; these actions only name which fields Atlas edits live.
 */

const SUBJECTS = {
  sop: { table: "app.sops", docKey: "body" },
  document: { table: "app.documents", docKey: "notes" },
} as const;

export type CoeditSubject = keyof typeof SUBJECTS;

const base64 = z
  .string()
  .max(12_000_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

export type CoeditResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly rule?: string };

async function context(org: string) {
  return z.string().min(1).max(80).safeParse(org).success ? getOrgContext(org) : null;
}

export async function openDocAction(
  org: string,
  subject: CoeditSubject,
  id: string,
  since = 0,
): Promise<CoeditResult<OpenedDoc>> {
  const target = SUBJECTS[subject];
  if (!target || !z.uuid().safeParse(id).success) return { ok: false };
  const ctx = await context(org);
  if (!ctx) return { ok: false };
  const result = await openDoc(ctx.viewer.db, {
    table: target.table,
    id,
    docKey: target.docKey,
    since: Math.max(0, Math.trunc(since)),
  });
  if (!result.ok) {
    return result.error.kind === "refusal" ? { ok: false, rule: result.error.rule } : { ok: false };
  }
  return { ok: true, data: result.data };
}

export async function appendDocUpdateAction(
  org: string,
  docId: string,
  generation: number,
  update: string,
): Promise<CoeditResult<number>> {
  if (!z.uuid().safeParse(docId).success || !base64.safeParse(update).success) return { ok: false };
  const ctx = await context(org);
  if (!ctx) return { ok: false };
  const result = await appendDocUpdate(ctx.viewer.db, { docId, generation, update });
  if (!result.ok) {
    return result.error.kind === "refusal" ? { ok: false, rule: result.error.rule } : { ok: false };
  }
  return { ok: true, data: result.data };
}

export async function compactDocAction(
  org: string,
  docId: string,
  generation: number,
  state: string,
  through: number,
  text: string,
): Promise<CoeditResult<{ compacted: boolean; throughSeq: number }>> {
  if (!z.uuid().safeParse(docId).success || !base64.safeParse(state).success) return { ok: false };
  if (text.length > 200_000) return { ok: false, rule: "coedit_text_size" };
  const ctx = await context(org);
  if (!ctx) return { ok: false };
  const result = await compactDoc(ctx.viewer.db, { docId, generation, state, through, text });
  if (!result.ok) {
    return result.error.kind === "refusal" ? { ok: false, rule: result.error.rule } : { ok: false };
  }
  return { ok: true, data: result.data };
}
