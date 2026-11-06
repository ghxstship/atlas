"use server";

import { answerStillComing } from "@xos/data/notification-actions";
import { redirect } from "next/navigation";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import type { FormResult } from "@/lib/actions/operations";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Gateway Home's "Still coming?" (B9, migration 2981, ADR 0148): the person answers through app.act_on_notification, as a
 * push does, so the same rules decide and the ask's notification retires with the answer. The row leaves with it, so what
 * the answer did is said on Home through the redirect.
 */

export async function confirmStillComingAction(notificationId: string): Promise<ActionResult> {
  const result = await answerStillComing(
    await createServerSupabase(),
    z.uuid().parse(notificationId),
    true,
  );
  if (result.ok) redirect("/home?answered=coming");
  return toAction(result);
}

export async function declineStillComingAction(_: FormResult, form: FormData): Promise<FormResult> {
  const id = z.uuid().safeParse(form.get("notificationId"));
  if (!id.success) return { fieldError: "stillComing" };
  const reason = form.get("reason");
  const result = await answerStillComing(
    await createServerSupabase(),
    id.data,
    false,
    typeof reason === "string" && reason.trim() !== "" ? reason.trim().slice(0, 500) : null,
  );
  if (result.ok) redirect("/home?answered=declined");
  return { outcome: outcomeFor(result.error) };
}
