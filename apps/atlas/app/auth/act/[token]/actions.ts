"use server";

import { isActionToken, actThroughLink, type LinkAction } from "@xos/data/notification-actions";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The confirm button of a one-tap email link (A127, ADR 0086). Only this acts, never opening the page: the database
 * checks the link is the signed-in recipient's, unused and unexpired, then acts through app.act_on_notification, so a
 * refusal (step-up included) names its rule and the link stays unused.
 */

export interface ActionLinkState {
  readonly done?: LinkAction;
  readonly rule?: string;
  readonly message?: string;
  readonly at?: number;
}

const input = z.object({
  token: z.string().refine(isActionToken),
  action: z.enum(["approve", "reject", "accept"]),
  reason: z.string().max(2000).optional(),
});

export async function confirmActionLink(
  _: ActionLinkState,
  form: FormData,
): Promise<ActionLinkState> {
  const parsed = input.safeParse({
    token: form.get("token"),
    action: form.get("action"),
    reason: typeof form.get("reason") === "string" ? form.get("reason") : undefined,
  });
  if (!parsed.success) return { rule: "notification_action_invalid", at: Date.now() };
  if (parsed.data.action === "reject" && (parsed.data.reason ?? "").trim() === "")
    return { rule: "notification_action_reason", at: Date.now() };
  const db = await createServerSupabase();
  const result = await actThroughLink(db, {
    token: parsed.data.token,
    comment: parsed.data.reason?.trim() || null,
  });
  if (result.ok) return { done: parsed.data.action, at: Date.now() };
  if (result.error.kind === "refusal")
    return { rule: result.error.rule, message: result.error.message, at: Date.now() };
  return { rule: "unexpected", at: Date.now() };
}
