"use server";

import { setArchived, type ArchivableEntity } from "@xos/data/archive";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Archive and unarchive (A124): one action for every archivable row. The org context is resolved
 * again (404 when it is gone); app.archive_row and app.unarchive_row decide, checking the capability
 * that edits the row, and their refusals come back as keys under `archive.errors`.
 */

const ENTITIES = [
  "records",
  "punch_items",
  "work_orders",
  "custom_object_records",
  "vendors",
  "venues",
  "documents",
] as const satisfies readonly ArchivableEntity[];

const input = z.object({ entity: z.enum(ENTITIES), id: z.uuid(), archived: z.boolean() });

/** Keys under `archive.errors`: the refusal the copy explains, a row gone or not editable, or anything else. */
export type ArchiveError = "archive_name_taken" | "notFound" | "unexpected";

export type ArchiveResult = { ok: true } | { ok: false; error: ArchiveError };

export async function setArchivedAction(
  org: string,
  entity: ArchivableEntity,
  id: string,
  archived: boolean,
): Promise<ArchiveResult> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  const parsed = input.safeParse({ entity, id, archived });
  if (!parsed.success) return { ok: false, error: "notFound" };
  const result = await setArchived(ctx.viewer.db, parsed.data.entity, parsed.data.id, archived);
  if (!result.ok) {
    const { error } = result;
    if (error.kind === "refusal" && error.rule === "archive_name_taken") {
      return { ok: false, error: "archive_name_taken" };
    }
    return { ok: false, error: error.kind === "not-found" ? "notFound" : "unexpected" };
  }
  revalidatePath(`/${org}`, "layout");
  return { ok: true };
}
