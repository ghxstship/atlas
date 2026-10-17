"use server";

import {
  addObjectField,
  createObjectRecord,
  createObjectType,
  getObjectType,
  keyFromLabel,
  setObjectValue,
  CUSTOM_DATA_TYPES,
  OBJECT_VIEWS,
  type FieldValue,
} from "@xos/data/custom-objects";
import { revalidatePath } from "next/cache";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  done,
  field,
  fromDataError,
  inputError,
  type PlatformActionState,
} from "@/lib/platform/state";
import { contextFor } from "@/lib/platform/action-context";
import { parseValue } from "@/lib/platform/object-values";

/**
 * Custom object actions (A36 on A18's 0540; Section 4.6.3): define an object and its fields (Settings,
 * org.custom_objects.write), create records and move a record on the board. Row level security and the
 * 0540 guards decide; a value of the wrong type or a plan limit comes back as a named refusal.
 */

export async function createObjectTypeAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const label = field(form, "label");
  const parsed = z
    .object({
      label: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Z0-9]\S*( \S+)*$/),
      key: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
      icon: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
      view: z.enum(OBJECT_VIEWS),
    })
    .safeParse({
      label,
      key: field(form, "key") || keyFromLabel(label),
      icon: field(form, "icon") || "box",
      view: field(form, "view") || "Table",
    });
  if (!parsed.success) return inputError();
  const result = await createObjectType(ctx.viewer.db, {
    orgId: ctx.org.id,
    key: parsed.data.key,
    label: parsed.data.label,
    icon: parsed.data.icon,
    defaultView: parsed.data.view,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/custom-objects`);
  return done(result.data, parsed.data.key);
}

export async function addObjectFieldAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const label = field(form, "label");
  const parsed = z
    .object({
      type: z.uuid(),
      label: z.string().min(1).max(100),
      key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
      dataType: z.enum(CUSTOM_DATA_TYPES),
      order: z.coerce.number().int().min(1).max(1000),
    })
    .safeParse({
      type: field(form, "type"),
      label,
      key: keyFromLabel(label),
      dataType: field(form, "dataType"),
      order: field(form, "order") || "1",
    });
  if (!parsed.success) return inputError();
  const choices = field(form, "choices")
    .split(/\r?\n|,/)
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (parsed.data.dataType === "Choice" && choices.length === 0) {
    return { rule: "custom_choices_required", at: Date.now() };
  }
  const result = await addObjectField(ctx.viewer.db, {
    typeId: parsed.data.type,
    key: parsed.data.key,
    label: parsed.data.label,
    dataType: parsed.data.dataType,
    required: form.get("required") === "on",
    order: parsed.data.order,
    choices,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/custom-objects`);
  return done(result.data);
}

export async function createRecordAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const title = field(form, "title");
  if (title.length < 1 || title.length > 300) return inputError();
  const type = await getObjectType(ctx.viewer.db, ctx.org.id, field(form, "objectKey"));
  if (!type.ok) return fromDataError(type.error);
  const values: Record<string, FieldValue> = {};
  for (const f of type.data.fields) {
    const value = parseValue(
      f,
      field(form, `field:${f.id}`),
      field(form, `currency:${f.id}`) || "USD",
    );
    if (value === "invalid") return { rule: "custom_value_type", at: Date.now() };
    if (value === null) {
      if (f.required) return { rule: "custom_value_required", at: Date.now() };
      continue;
    }
    values[f.id] = value;
  }
  const result = await createObjectRecord(ctx.viewer.db, {
    orgId: ctx.org.id,
    typeId: type.data.id,
    title,
    values,
  });
  if (!result.ok) return fromDataError(result.error);
  const base = `/${ctx.org.slug}/objects/${type.data.key}`;
  revalidatePath(base);
  // Back to the collection the drawer opened from, keeping its view and search.
  const close = field(form, "close");
  redirect((close.startsWith(`${base}?`) || close === base ? close : base) as Route);
}

export async function setChoiceAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ record: z.uuid(), field: z.uuid(), choice: z.uuid(), objectKey: z.string().min(1) })
    .safeParse({
      record: field(form, "record"),
      field: field(form, "field"),
      choice: field(form, "choice"),
      objectKey: field(form, "objectKey"),
    });
  if (!parsed.success) return inputError();
  const result = await setObjectValue(ctx.viewer.db, {
    recordId: parsed.data.record,
    fieldId: parsed.data.field,
    value: { kind: "choice", choiceId: parsed.data.choice },
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/objects/${parsed.data.objectKey}`);
  return done(result.data);
}
