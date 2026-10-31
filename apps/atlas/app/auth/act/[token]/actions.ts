"use server";

import {
  actThroughLink,
  isActionToken,
  readActionLink,
  type LinkAction,
} from "@xos/data/notification-actions";
import { z } from "zod";
import { enforceActionLinkGate } from "@/lib/auth/action-link-gate";
import { getViewer } from "@/lib/shell/context";

/**
 * The confirm button of a one-tap email link (A127, ADR 0106). Only this acts, never opening the page. The org's
 * security settings decide first, as for an action in its Inbox (IP allow-list, MFA policy, session lifetime and
 * idle timeout), then the database checks the link is the signed-in recipient's, sent for Atlas, unused and
 * unexpired, and acts through app.act_on_notification, so a refusal (step-up included) names its rule and the link
 * stays unused.
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
  const viewer = await getViewer();
  if (!viewer) return { rule: "notification_action_invalid", at: Date.now() };
  const db = viewer.db;
  // The org comes from the link itself, never from the form.
  const link = await readActionLink(db, parsed.data.token, "Atlas");
  if (!link.ok) return { rule: "unexpected", at: Date.now() };
  // Only a member's link acts here; the database refuses any other in Atlas too.
  if (link.data.state === "elsewhere")
    return { rule: "notification_action_elsewhere", at: Date.now() };
  if (link.data.state === "ready") {
    const member =
      link.data.orgSlug !== null &&
      (await enforceActionLinkGate(viewer, link.data.orgSlug, parsed.data.token));
    if (!member) return { rule: "notification_action_invalid", at: Date.now() };
  }
  const result = await actThroughLink(db, {
    token: parsed.data.token,
    app: "Atlas",
    comment: parsed.data.reason?.trim() || null,
  });
  if (result.ok) return { done: parsed.data.action, at: Date.now() };
  if (result.error.kind === "refusal")
    return { rule: result.error.rule, message: result.error.message, at: Date.now() };
  return { rule: "unexpected", at: Date.now() };
}
