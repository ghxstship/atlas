"use server";

import { isCustomFieldTable } from "@xos/data/custom-fields";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { canWriteCustomFields, loadCustomFieldForm, saveCustomFields } from "./server";
import type { CustomFieldForm, CustomFieldInput, CustomFieldSaveResult } from "./types";

/**
 * Server actions behind the custom field inputs and record sections (A117, RRR-162). Each resolves the viewer's
 * org from its slug (null for an org the viewer is not in), so row level security on custom_field_values decides
 * what is read and written.
 */

const ID = z.uuid();
const INPUTS = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  z.object({ value: z.string().max(10_000), currency: z.string().max(3).optional() }),
);

/** The fields of a table for a form, and a row's values when editing it; null when the viewer cannot see them. */
export async function loadCustomFieldFormAction(
  orgSlug: string,
  table: string,
  targetId: string | null,
): Promise<CustomFieldForm | null> {
  if (!isCustomFieldTable(table) || (targetId !== null && !ID.safeParse(targetId).success)) {
    return null;
  }
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) return null;
  return loadCustomFieldForm(ctx, table, targetId);
}

/**
 * Saves a row's custom fields: after a create form made the row (`create` needs every required field) or from a
 * record's custom fields section (`update`). Problems come back by field key; refusals by their rule.
 */
export async function saveCustomFieldsAction(
  orgSlug: string,
  table: string,
  targetId: string,
  inputs: Readonly<Record<string, CustomFieldInput>>,
  mode: "create" | "update",
): Promise<CustomFieldSaveResult> {
  const parsed = INPUTS.safeParse(inputs);
  if (
    !isCustomFieldTable(table) ||
    !ID.safeParse(targetId).success ||
    !parsed.success ||
    (mode !== "create" && mode !== "update")
  ) {
    return { ok: false, error: "invalid" };
  }
  const ctx = await getOrgContext(orgSlug);
  // Row level security would drop the writes of a member below the writer band without an error, so they are
  // refused here rather than answered with a success that wrote nothing.
  if (!ctx || !canWriteCustomFields(ctx)) return { ok: false, error: "denied" };
  const result = await saveCustomFields(ctx, { table, targetId, inputs: parsed.data, mode });
  if (result.ok) revalidatePath(`/${ctx.org.slug}`, "layout");
  return result;
}
