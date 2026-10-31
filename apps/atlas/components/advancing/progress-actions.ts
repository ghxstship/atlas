"use server";

import type { DataError } from "@xos/data";
import {
  ADVANCE_TRACKS,
  REMINDER_BATCH_LIMIT,
  revokeTrackSignoff,
  sendAdvanceReminderNow,
  signOffTrack,
} from "@xos/data/advancing";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { KNOWN_ERRORS } from "./errors";

/**
 * Actions of the Progress section (R11): reminding chosen recipients now, and signing off or revoking a recipient's
 * track. Each resolves the viewer's org context again (404 when it is gone) and calls the repository; the RPCs of
 * 2741 and 2743 decide every write. Refusals come back as catalog keys under `advancing.errors`.
 */

export type ProgressOutcome =
  | { readonly ok: true; readonly sent?: number; readonly skipped?: number }
  | { readonly ok: false; readonly error: string };

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_ERRORS.has(error.rule) ? error.rule : "refused";
  return error.kind;
}

async function contextFor(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

const id = z.uuid();

/** Reminds the chosen recipients of one sent packet now, at most once a day each (app.send_advance_reminder_now). */
export async function sendAdvanceReminderAction(
  org: string,
  packetId: string,
  recipientIds: readonly string[],
): Promise<ProgressOutcome> {
  const ctx = await contextFor(org);
  const parsed = z
    .object({ packetId: id, recipientIds: z.array(id).min(1).max(REMINDER_BATCH_LIMIT) })
    .safeParse({ packetId, recipientIds: [...new Set(recipientIds)] });
  if (!parsed.success) return { ok: false, error: "advance_reminder_batch" };
  const result = await sendAdvanceReminderNow(
    ctx.viewer.db,
    parsed.data.packetId,
    parsed.data.recipientIds,
  );
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  return { ok: true, sent: result.data.sent, skipped: result.data.skipped };
}

/** Signs off one recipient's track (app.sign_off_advance_track). */
export async function signOffTrackAction(
  org: string,
  recipientId: string,
  track: string,
): Promise<ProgressOutcome> {
  const ctx = await contextFor(org);
  const parsed = z
    .object({ recipientId: id, track: z.enum(ADVANCE_TRACKS) })
    .safeParse({ recipientId, track });
  if (!parsed.success) return { ok: false, error: "invalid" };
  const result = await signOffTrack(ctx.viewer.db, parsed.data.recipientId, parsed.data.track);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

/** Revokes a live track sign-off with a reason (app.revoke_advance_track_signoff). */
export async function revokeTrackSignoffAction(
  org: string,
  signoffId: string,
  reason: string,
): Promise<ProgressOutcome> {
  const ctx = await contextFor(org);
  const parsed = z
    .object({ signoffId: id, reason: z.string().trim().min(1).max(500) })
    .safeParse({ signoffId, reason });
  if (!parsed.success) return { ok: false, error: "advance_track_revoke_reason" };
  const result = await revokeTrackSignoff(ctx.viewer.db, parsed.data.signoffId, parsed.data.reason);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}
