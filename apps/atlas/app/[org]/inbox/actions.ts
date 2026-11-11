"use server";

import { actOnInboxItem, snoozeInboxItem, snoozeUntil } from "@xos/data/inbox";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { done, field, inputError, type PlatformActionState } from "@/lib/platform/state";
import { fromDataError } from "@/lib/platform/data-error";
import { contextFor } from "@/lib/platform/action-context";

/**
 * Inbox actions (A36, Section 11.10 rule 5): approve (A), reject with a reason (R), Done (E) and snooze
 * (H), each acting where the item arrives without opening the record. app.act_on_notification decides
 * every approval rule and only the recipient may act.
 */

const ids = z.object({ org: z.string().min(1), id: z.uuid() });

/** Approve, mark Done or snooze one item; called directly by the keyboard so twenty run in a row. */
export async function quickInboxAction(input: {
  org: string;
  id: string;
  action: "approve" | "done" | "snooze";
}): Promise<PlatformActionState> {
  const parsed = ids.extend({ action: z.enum(["approve", "done", "snooze"]) }).safeParse(input);
  if (!parsed.success) return inputError();
  const ctx = await getOrgContext(parsed.data.org);
  if (!ctx) return { error: "notFound", at: Date.now() };
  const result =
    parsed.data.action === "snooze"
      ? await snoozeInboxItem(ctx.viewer.db, { id: parsed.data.id, until: snoozeUntil() })
      : await actOnInboxItem(ctx.viewer.db, { id: parsed.data.id, action: parsed.data.action });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/inbox`);
  return done(parsed.data.id);
}

export async function rejectInboxAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ id: z.uuid(), reason: z.string().min(1).max(2000) })
    .safeParse({ id: field(form, "id"), reason: field(form, "reason") });
  if (!parsed.success) return inputError();
  const result = await actOnInboxItem(ctx.viewer.db, {
    id: parsed.data.id,
    action: "reject",
    comment: parsed.data.reason,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/inbox`);
  return done(parsed.data.id);
}
