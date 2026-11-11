"use server";

import type { BulkOutcome } from "@xos/data/bulk";
import { bulkUpdateMine, GATEWAY_BULK_RESOURCES } from "@xos/data/gateway-bulk";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Gateway bulk actions (Section 11.7, ADR 0082): one call per preview, apply, undo or redo,
 * through the person's own bulk RPC (migration 2160) as the signed-in person. The database checks
 * the person's reach and every rule of the single action on each row; this action only shapes the
 * input. Refused rows come back in the outcome with their rule; a refusal of the whole call comes
 * back as a `gateway.outcomes` key.
 */

const values = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  z.union([z.string().max(200), z.null()]),
);

const inputSchema = z.object({
  resource: z.enum(GATEWAY_BULK_RESOURCES),
  rows: z
    .array(z.object({ id: z.uuid(), set: values, expect: values.optional() }))
    .min(1)
    .max(500),
  preview: z.boolean(),
});

export type GatewayBulkInput = z.input<typeof inputSchema>;

export type GatewayBulkResult =
  | { readonly ok: true; readonly outcome: BulkOutcome }
  | { readonly ok: false; readonly outcome: string };

export async function gatewayBulkAction(input: GatewayBulkInput): Promise<GatewayBulkResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, outcome: "invalid" };
  const { resource, rows, preview } = parsed.data;
  const shaped = rows.map((r) =>
    r.expect ? { id: r.id, set: r.set, expect: r.expect } : { id: r.id, set: r.set },
  );
  const result = await bulkUpdateMine(await createServerSupabase(), resource, shaped, { preview });
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  return { ok: true, outcome: result.data };
}
