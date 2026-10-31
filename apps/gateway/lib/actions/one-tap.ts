"use server";

import { actOnInboxItem, snoozeInboxItem, snoozeUntil } from "@xos/data/inbox";
import { actThroughLink, isActionToken, type LinkAction } from "@xos/data/notification-actions";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { outcomeFor, type ActionResult } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Acting where notifications arrive in Gateway (A127, ADR 0106; Section 11.10 rule 5): the confirm button of a one-tap
 * email link, and Done (E) and Snooze (H) on Home's For Your Information list. Each runs as the signed-in person; the
 * database decides who may act and every rule of the action itself.
 */

export interface ActionLinkState {
  readonly done?: LinkAction;
  readonly outcome?: string;
}

const linkInput = z.object({
  token: z.string().refine(isActionToken),
  action: z.enum(["approve", "reject", "accept"]),
  reason: z.string().max(2000).optional(),
});

/**
 * Acts through a one-tap link on the confirm page's press; opening the page never acts. Only a link sent for Gateway
 * acts here (an external party's or an applicant's): a member's link is Atlas's, where the org's security settings
 * apply, and the database refuses it here (notification_action_elsewhere).
 */
export async function confirmActionLinkAction(
  _: ActionLinkState,
  form: FormData,
): Promise<ActionLinkState> {
  const reason = form.get("reason");
  const parsed = linkInput.safeParse({
    token: form.get("token"),
    action: form.get("action"),
    reason: typeof reason === "string" ? reason : undefined,
  });
  if (!parsed.success) return { outcome: "refusals.notification_action_invalid" };
  if (parsed.data.action === "reject" && (parsed.data.reason ?? "").trim() === "")
    return { outcome: "refusals.notification_action_reason" };
  const result = await actThroughLink(await createServerSupabase(), {
    token: parsed.data.token,
    app: "Gateway",
    comment: parsed.data.reason?.trim() || null,
  });
  if (!result.ok) return { outcome: outcomeFor(result.error) };
  revalidatePath("/home");
  return { done: parsed.data.action };
}

const id = z.uuid();

/** Done (E) on a For Your Information item: it leaves the list. */
export async function fyiDoneAction(notificationId: string): Promise<ActionResult> {
  const parsed = id.safeParse(notificationId);
  if (!parsed.success) return { ok: false, outcome: "invalid" };
  const result = await actOnInboxItem(await createServerSupabase(), {
    id: parsed.data,
    action: "done",
  });
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  revalidatePath("/home");
  return { ok: true };
}

/** Snooze (H) on a For Your Information item: it leaves the list for 24 hours. */
export async function fyiSnoozeAction(notificationId: string): Promise<ActionResult> {
  const parsed = id.safeParse(notificationId);
  if (!parsed.success) return { ok: false, outcome: "invalid" };
  const result = await snoozeInboxItem(await createServerSupabase(), {
    id: parsed.data,
    until: snoozeUntil(),
  });
  if (!result.ok) return { ok: false, outcome: outcomeFor(result.error) };
  revalidatePath("/home");
  return { ok: true };
}
