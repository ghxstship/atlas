"use server";

import {
  cancelImport,
  checkImportUpload,
  confirmMapping,
  createImport,
  createSheetsImport,
  decideMergeReview,
  googleSheetsLinkId,
  importDetectedSheet,
  importObjectPath,
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

export async function createImportAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const file = form.get("file");
  const target = field(form, "target");
  const person = ctx.viewer.person;
  if (!person || !(file instanceof File) || file.size === 0 || !target) return inputError();
  // .csv and .xlsx only; a legacy .xls gets its own message (owner decision 28).
  const upload = checkImportUpload(file.name, file.size);
  if (!upload.ok) return { rule: upload.rule, at: Date.now() };
  const result = await createImport(ctx.viewer.db, {
    orgId: ctx.org.id,
    targetCode: target,
    filename: file.name.slice(0, 255),
    objectPath: importObjectPath(person.id, crypto.randomUUID(), upload.ext),
    source: upload.source,
    body: new Uint8Array(await file.arrayBuffer()),
    contentType: upload.contentType,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(result.data);
}

/** A Google Sheets link (A83): the worker reads it through the org's Google Drive connection. */
export async function createSheetsImportAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const link = field(form, "link");
  const target = field(form, "target");
  const person = ctx.viewer.person;
  if (!person || !target || !link) return inputError();
  if (googleSheetsLinkId(link) === null) return { rule: "import_link_invalid", at: Date.now() };
  const result = await createSheetsImport(ctx.viewer.db, {
    orgId: ctx.org.id,
    targetCode: target,
    link,
    objectPath: importObjectPath(person.id, crypto.randomUUID(), "xlsx"),
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/import`);
  return done(result.data);
}

/** Starts the import of another detected sheet of the workbook (A83). */
export async function importSheetAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ sheet: z.uuid(), target: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/) })
    .safeParse({ sheet: field(form, "sheet"), target: field(form, "target") });
  if (!parsed.success) return inputError();
  const result = await importDetectedSheet(ctx.viewer.db, {
    sheetId: parsed.data.sheet,
    targetCode: parsed.data.target,
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
