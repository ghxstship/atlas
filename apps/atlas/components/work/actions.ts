"use server";

import {
  addChecklistItem,
  assignRecord,
  clearRecurrence,
  createRecord,
  formatRecordKey,
  getRecord,
  removeChecklistItem,
  restoreRecord,
  saveRecordExtension,
  setChecklistItemChecked,
  setRecurrence,
  transitionRecord,
  trashRecord,
  unassignRecord,
  unwatchRecord,
  updateRecord,
  watchRecord,
  type ExtensionValues,
} from "@xos/data/work";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { done, failed, invalid, type ActionResult } from "./action-result";
import { initialExtension } from "./kind-fields";

/**
 * Record actions (A08): create, edit, move through states, Trash and restore, checklists,
 * assignments, watching and recurrence. Each resolves the viewer's org context again (404 when it
 * is gone); row level security, the RPCs and the record guards of migrations 0310 and 0311 decide
 * every write, and their refusals come back as catalog keys under `work.errors`.
 */

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

function refresh(org: string) {
  revalidatePath(`/${org}`, "layout");
}

const id = z.uuid();
const optionalId = z.uuid().nullable().optional();
const instant = z.iso.datetime({ offset: true }).nullable().optional();

const createSchema = z.object({
  projectId: z.uuid(),
  kind: z.string().min(1).max(40),
  subtype: z.string().min(1).max(80).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  scopeNodeId: optionalId,
  phaseCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  urid: z
    .string()
    .regex(/^\d{4}\.\d{2}\.\d{2}$/)
    .nullable()
    .optional(),
  xyz: z.string().length(1).nullable().optional(),
  ownerId: optionalId,
  startsAt: instant,
  endsAt: instant,
  dueAt: instant,
});

export type CreateRecordInput = z.input<typeof createSchema>;

export async function createRecordAction(
  org: string,
  input: CreateRecordInput,
): Promise<ActionResult<{ key: string }>> {
  const ctx = await context(org);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const created = await createRecord(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...parsed.data,
    extension: initialExtension(parsed.data.kind, ctx.viewer.person?.id ?? null),
  });
  if (!created.ok) return failed(created.error);
  const record = await getRecord(ctx.viewer.db, created.data.id);
  refresh(org);
  return done({ key: record.ok ? record.data.key : formatRecordKey("", created.data.number) });
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  subtype: z.string().min(1).max(80).nullable().optional(),
  scopeNodeId: optionalId,
  phaseCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  ownerId: optionalId,
  accountableId: optionalId,
  startsAt: instant,
  endsAt: instant,
  dueAt: instant,
  replanReason: z.string().trim().min(1).max(500).nullable().optional(),
});

export type RecordPatchInput = z.input<typeof patchSchema>;

export async function updateRecordAction(
  org: string,
  recordId: string,
  input: RecordPatchInput,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = patchSchema.safeParse(input);
  if (!id.safeParse(recordId).success || !parsed.success) return invalid();
  const result = await updateRecord(ctx.viewer.db, recordId, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

const transitionSchema = z.object({
  recordId: z.uuid(),
  expected: z.string().min(1).max(40),
  next: z.string().min(1).max(40),
  reason: z.string().trim().min(1).max(500),
  blockerText: z.string().trim().min(1).max(500).nullable().optional(),
  replanReason: z.string().trim().min(1).max(500).nullable().optional(),
});

export async function transitionRecordAction(
  org: string,
  input: z.input<typeof transitionSchema>,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) return invalid("reasonRequired");
  const result = await transitionRecord(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function trashRecordAction(org: string, recordId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(recordId).success) return invalid();
  const result = await trashRecord(ctx.viewer.db, recordId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function restoreRecordAction(org: string, recordId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(recordId).success) return invalid();
  const result = await restoreRecord(ctx.viewer.db, recordId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

const extensionValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export async function saveExtensionAction(
  org: string,
  input: { recordId: string; kind: string; fields: ExtensionValues },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      recordId: z.uuid(),
      kind: z.string().regex(/^[A-Z][A-Za-z]+$/),
      fields: z.record(z.string().regex(/^[a-z_]+$/), extensionValue),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await saveRecordExtension(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function addChecklistItemAction(
  org: string,
  recordId: string,
  label: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  const text = z.string().trim().min(1).max(300).safeParse(label);
  if (!id.safeParse(recordId).success || !text.success) return invalid("checklistLabel");
  const result = await addChecklistItem(ctx.viewer.db, {
    orgId: ctx.org.id,
    recordId,
    label: text.data,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function checkItemAction(
  org: string,
  itemId: string,
  checked: boolean,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(itemId).success) return invalid();
  const result = await setChecklistItemChecked(ctx.viewer.db, itemId, checked);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function removeChecklistItemAction(
  org: string,
  itemId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(itemId).success) return invalid();
  const result = await removeChecklistItem(ctx.viewer.db, itemId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function assignAction(
  org: string,
  recordId: string,
  membershipId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(recordId).success || !id.safeParse(membershipId).success) return invalid();
  const result = await assignRecord(ctx.viewer.db, { orgId: ctx.org.id, recordId, membershipId });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function unassignAction(org: string, assignmentId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(assignmentId).success) return invalid();
  const result = await unassignRecord(ctx.viewer.db, assignmentId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function watchAction(
  org: string,
  recordId: string,
  watchId: string | null,
): Promise<ActionResult> {
  const ctx = await context(org);
  const person = ctx.viewer.person;
  if (!person || !id.safeParse(recordId).success) return invalid();
  const result = watchId
    ? await unwatchRecord(ctx.viewer.db, watchId)
    : await watchRecord(ctx.viewer.db, { orgId: ctx.org.id, recordId, personId: person.id });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

const recurrenceSchema = z.object({
  recordId: z.uuid(),
  rrule: z
    .string()
    .regex(/^FREQ=(DAILY|WEEKLY|MONTHLY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/)
    .nullable(),
  timeZone: z.string().min(1).max(64),
  untilAt: instant,
});

export async function setRecurrenceAction(
  org: string,
  input: z.input<typeof recurrenceSchema>,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = recurrenceSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const { recordId, rrule, timeZone, untilAt } = parsed.data;
  const result = rrule
    ? await setRecurrence(ctx.viewer.db, {
        orgId: ctx.org.id,
        recordId,
        rrule,
        timeZone,
        untilAt: untilAt ?? null,
      })
    : await clearRecurrence(ctx.viewer.db, recordId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}
