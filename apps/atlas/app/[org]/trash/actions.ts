"use server";

import { restoreTrashItem } from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { fromDataError, type WorkflowActionState } from "@/lib/workflow/state";

/** Restores a row from Trash as the viewer (app.restore_trash_item): the table's own rules decide. */
export async function restoreAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  const parsed = z
    .object({ table: z.string().regex(/^[a-z][a-z0-9_]*$/), id: z.uuid() })
    .safeParse({ table: form.get("table"), id: form.get("id") });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await restoreTrashItem(ctx.viewer.db, parsed.data);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, id: String(result.data), at: Date.now() };
}
