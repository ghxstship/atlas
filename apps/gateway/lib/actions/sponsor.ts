"use server";

import { respondSponsorAsset } from "@xos/data/sponsor-assets";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";
import type { FormResult } from "@/lib/actions/operations";

/**
 * The sponsor answers on a brand asset (migration 1133, journey 47): approve or return a
 * submitted asset, or resubmit a returned one. The database decides who may answer and refuses
 * a stale state or a return without a reason.
 */
export async function respondSponsorAssetAction(
  _: FormResult,
  form: FormData,
): Promise<FormResult> {
  const parsed = z
    .object({
      assetId: z.uuid(),
      expected: z.enum(["Submitted", "Returned"]),
      next: z.enum(["Approved", "Returned", "Submitted"]),
      reason: z.string().trim().max(1000),
    })
    .safeParse({
      assetId: form.get("assetId"),
      expected: form.get("expected"),
      next: form.get("next"),
      reason: form.get("reason") ?? "",
    });
  if (!parsed.success) return { fieldError: "asset" };
  if (parsed.data.next === "Returned" && parsed.data.reason === "") {
    return { fieldError: "assetReason" };
  }
  const result = await respondSponsorAsset(await createServerSupabase(), {
    assetId: parsed.data.assetId,
    expected: parsed.data.expected,
    next: parsed.data.next,
    reason: parsed.data.reason === "" ? null : parsed.data.reason,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
