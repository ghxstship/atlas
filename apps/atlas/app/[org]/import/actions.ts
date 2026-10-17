"use server";

import {
  cancelImport,
  confirmMapping,
  createImport,
  decideMergeReview,
  importObjectPath,
  importSourceOf,
  requestImportCommit,
  undoImportBatch,
} from "@xos/data/imports";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  done,
  field,
  fromDataError,
  inputError,
  type PlatformActionState,
} from "@/lib/platform/state";
import { contextFor } from "@/lib/platform/action-context";

/**
 * Import wizard actions (A36, Section 4.6.2): upload a spreadsheet, confirm the mapping, decide fuzzy
 * matches, commit and undo. Detection, validation and the writes run in the import worker; these
 * actions run as the person, so row level security and the import RPCs decide.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

export async function createImportAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const file = form.get("file");
  const target = field(form, "target");
  const person = ctx.viewer.person;
  if (!person || !(file instanceof File) || file.size === 0 || !target) return inputError();
  const source = importSourceOf(file.name);
  if (!source) return { rule: "import_file_type", at: Date.now() };
  if (source.source === "XLS") return { rule: "import_xls_unsupported", at: Date.now() };
  if (file.size > MAX_BYTES) return { rule: "import_file_size", at: Date.now() };
  const result = await createImport(ctx.viewer.db, {
    orgId: ctx.org.id,
    targetCode: target,
    filename: file.name.slice(0, 255),
    objectPath: importObjectPath(person.id, crypto.randomUUID(), source.ext),
    source: source.source,
    body: new Uint8Array(await file.arrayBuffer()),
    contentType: CONTENT_TYPES[source.ext] ?? "text/csv",
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(result.data);
}

export async function confirmMappingAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const importId = field(form, "import");
  if (!z.uuid().safeParse(importId).success) return inputError();
  const mapping: { columnId: string; fieldName: string | null }[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("column:") || typeof value !== "string") continue;
    const columnId = key.slice("column:".length);
    if (!z.uuid().safeParse(columnId).success) return inputError();
    mapping.push({ columnId, fieldName: value === "" ? null : value });
  }
  const fields = mapping.flatMap((m) => (m.fieldName ? [m.fieldName] : []));
  if (new Set(fields).size !== fields.length) return { rule: "import_field_twice", at: Date.now() };
  const result = await confirmMapping(ctx.viewer.db, { importId, mapping });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(result.data);
}

export async function decideReviewAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ review: z.uuid(), decision: z.enum(["Merged", "Kept Separate"]) })
    .safeParse({ review: field(form, "review"), decision: field(form, "decision") });
  if (!parsed.success) return inputError();
  const result = await decideMergeReview(ctx.viewer.db, {
    id: parsed.data.review,
    decision: parsed.data.decision,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(result.data);
}

export async function commitImportAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const importId = field(form, "import");
  if (!z.uuid().safeParse(importId).success) return inputError();
  const result = await requestImportCommit(ctx.viewer.db, importId);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(result.data);
}

export async function undoBatchAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ batch: z.uuid(), reason: z.string().min(1).max(500) })
    .safeParse({ batch: field(form, "batch"), reason: field(form, "reason") });
  if (!parsed.success) return inputError();
  const result = await undoImportBatch(ctx.viewer.db, {
    batchId: parsed.data.batch,
    reason: parsed.data.reason,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(parsed.data.batch, `${result.data.reverted}:${result.data.kept}`);
}

export async function cancelImportAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const importId = field(form, "import");
  if (!z.uuid().safeParse(importId).success) return inputError();
  const result = await cancelImport(ctx.viewer.db, importId);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(result.data);
}
