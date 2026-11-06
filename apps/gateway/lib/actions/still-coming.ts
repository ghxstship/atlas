"use server";

import { actOnInboxItem } from "@xos/data/inbox";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import type { FormResult } from "@/lib/actions/operations";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Gateway Home's "Still coming?" (B9, migration 2981, ADR 0148): the person answers through app.act_on_notification, as a
 * push does, so the same rules decide and the ask's notification retires with the answer.
 */

export async function confirmStillComingAction(notificationId: string): Promise<ActionResult> {
  return toAction(
    await actOnInboxItem(await createServerSupabase(), {
      id: z.uuid().parse(notificationId),
      action: "accept",
    }),
  );
}

export async function declineStillComingAction(_: FormResult, form: FormData): Promise<FormResult> {
  const id = z.uuid().safeParse(form.get("notificationId"));
  if (!id.success) return { fieldError: "stillComing" };
  const reason = form.get("reason");
  const result = await actOnInboxItem(await createServerSupabase(), {
    id: id.data,
    action: "decline",
    comment: typeof reason === "string" && reason.trim() !== "" ? reason.trim().slice(0, 500) : null,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
