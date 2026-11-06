"use server";

import { clearGuestNeeds, setGuestNeeds } from "@xos/data/sensitive-consent";
import { parseGuestNeedsForm, workDetailErrorKey } from "@xos/data/work-details-forms";
import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { outcomeFor } from "@/lib/action-result";
import { clientIp } from "@/lib/auth/legal";
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
    })
    .safeParse({
      engagementId: form.get("engagementId"),
      guestName: form.get("guestName"),
      plusOnes: form.get("plusOnes") ?? 0,
      note: form.get("note") ?? "",
    });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { fieldError: field === "plusOnes" ? "plusOnes" : "guestName" };
  }
  const result = await requestEngagedGuest(await createServerSupabase(), {
    engagementId: parsed.data.engagementId,
    guestName: parsed.data.guestName,
    plusOnes: parsed.data.plusOnes,
    note: parsed.data.note.length > 0 ? parsed.data.note : null,
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

// A guest's dietary and access needs (ADR 0164) ------------------------------------------------------------------------

export interface GuestNeedsFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
}

/** Sets a guest's needs under the party's attestation; the database refuses it without both statements. */
export async function setGuestNeedsAction(
  _: GuestNeedsFormState,
  form: FormData,
): Promise<GuestNeedsFormState> {
  const parsed = parseGuestNeedsForm(form);
  if (!parsed.ok) return { fieldErrors: Object.fromEntries(parsed.fields.map((f) => [f, f])) };
  const result = await setGuestNeeds(await createServerSupabase(), {
    ...parsed.value,
    locale: await getLocale(),
    surface: "Gateway",
    clientIp: clientIp(await headers()),
  });
  if (!result.ok) return { error: workDetailErrorKey(result.error) };
  revalidatePath("/work/engagements", "layout");
  return { ok: true };
}

export async function clearGuestNeedsAction(
  _: GuestNeedsFormState,
  form: FormData,
): Promise<GuestNeedsFormState> {
  const guestId = id.safeParse(form.get("guestId"));
  if (!guestId.success) return { error: "invalid" };
  const result = await clearGuestNeeds(await createServerSupabase(), guestId.data);
  if (!result.ok) return { error: workDetailErrorKey(result.error) };
  revalidatePath("/work/engagements", "layout");
  return { ok: true };
}
