"use server";

import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { requestEngagedGuest, respondToSettlement } from "@/lib/party";
import { createServerSupabase } from "@/lib/supabase/server";
import type { FormResult } from "./operations";

/**
 * Server actions for the guest list and settlement tabs (A32). Each validates its input and lets
 * the RPC decide; refusals come back as catalog copy through the shared outcome keys.
 */
const id = z.uuid();

export async function requestGuestAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      engagementId: id,
      guestName: z.string().trim().min(1).max(200),
      plusOnes: z.coerce.number().int().min(0).max(20),
      note: z.string().trim().max(500),
      guestEmail: z.union([z.literal(""), z.email().max(320)]),
    })
    .safeParse({
      engagementId: form.get("engagementId"),
      guestName: form.get("guestName"),
      plusOnes: form.get("plusOnes") ?? 0,
      note: form.get("note") ?? "",
      guestEmail: String(form.get("guestEmail") ?? "")
        .trim()
        .toLowerCase(),
    });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      fieldError:
        field === "plusOnes" ? "plusOnes" : field === "guestEmail" ? "guestEmail" : "guestName",
    };
  }
  const result = await requestEngagedGuest(await createServerSupabase(), {
    engagementId: parsed.data.engagementId,
    guestName: parsed.data.guestName,
    plusOnes: parsed.data.plusOnes,
    note: parsed.data.note.length > 0 ? parsed.data.note : null,
    guestEmail: parsed.data.guestEmail.length > 0 ? parsed.data.guestEmail : null,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function respondSettlementAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      settlementId: id,
      decision: z.enum(["accept", "dispute"]),
      reason: z.string().trim().min(1).max(2000),
    })
    .safeParse({
      settlementId: form.get("settlementId"),
      decision: form.get("decision"),
      reason: form.get("reason"),
    });
  if (!parsed.success) return { fieldError: "settlementReason" };
  const result = await respondToSettlement(await createServerSupabase(), {
    settlementId: parsed.data.settlementId,
    accept: parsed.data.decision === "accept",
    reason: parsed.data.reason,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
