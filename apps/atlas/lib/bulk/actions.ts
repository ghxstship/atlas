"use server";

import { BULK_RESOURCES, bulkUpdate, type BulkOutcome } from "@xos/data/bulk";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Bulk edit (Section 11.7, ADR 0044): one call per preview, apply or undo, through the resource's
 * transactional RPC as the signed-in person. The database checks the capability on every row; this
 * action only shapes the input and revalidates the org's pages after a committed change.
 */

const value = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const values = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), value);

const inputSchema = z.object({
  org: z.string().min(1).max(80),
  resource: z.enum(BULK_RESOURCES),
  rows: z
    .array(z.object({ id: z.uuid(), set: values, expect: values.optional() }))
    .min(1)
    .max(500),
  preview: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export type BulkActionInput = z.input<typeof inputSchema>;

export type BulkActionResult =
  | { readonly ok: true; readonly outcome: BulkOutcome }
  | { readonly ok: false; readonly rule?: string; readonly message?: string };

export async function bulkUpdateAction(input: BulkActionInput): Promise<BulkActionResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const { org, resource, rows, preview, reason } = parsed.data;
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false };
  const shaped = rows.map((r) =>
    r.expect ? { id: r.id, set: r.set, expect: r.expect } : { id: r.id, set: r.set },
  );
  const result = await bulkUpdate(ctx.viewer.db, resource, shaped, {
    preview,
    ...(reason ? { reason } : {}),
  });
  if (!result.ok) {
    return result.error.kind === "refusal"
      ? { ok: false, rule: result.error.rule, message: result.error.message }
      : { ok: false };
  }
  if (result.data.committed) revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, outcome: result.data };
}
