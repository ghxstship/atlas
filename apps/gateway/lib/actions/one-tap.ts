"use server";

import { actOnInboxItem, snoozeInboxItem, snoozeUntil } from "@xos/data/inbox";
import {
  actThroughLink,
  decideThroughSignedOutLink,
  isActionToken,
  previewSignedOutApprovalLink,
  requestApprovalLinkCode,
  type LinkAction,
  type SignedOutOutcome,
} from "@xos/data/notification-actions";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { outcomeFor, type ActionResult } from "@/lib/action-result";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Acting where notifications arrive in Gateway (A127, ADR 0106; Section 11.10 rule 5): the confirm button of a one-tap
 * email link, the signed-out approval page of an outside approver (P9, ADR 0138), and Done (E) and Snooze (H) on Home's
 * For Your Information list. Each runs as the signed-in person; the
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

// Signed-out approval links (P9, migration 2861, ADR 0138) -----------------------------------------------------

/**
 * What the signed-out approval page shows after a press: a typed outcome of the link (its copy is
 * gateway.auth.actionLink.signedOut.outcome.*, with the attempts left after a wrong code), a refusal of the decision's
 * own rules (gateway.outcomes.*), and, once the code is right, the request's title and step.
 */
export interface SignedOutApprovalResult {
  readonly outcome: SignedOutOutcome | "code_sent" | "refused";
  readonly attemptsLeft?: number | null;
  /** A refusal of the decision's own rules or of the code request, as a gateway.outcomes key. */
  readonly refusal?: string;
  readonly title?: string | null;
  readonly stepName?: string | null;
}

const signedOutInput = z.object({
  token: z.string().refine(isActionToken),
  code: z.string().trim().regex(/^[0-9]{6}$/).optional(),
  reason: z.string().max(2000).optional(),
});

/** Email me a code: the database queues it to the link's recipient, at most one a minute and five an hour. */
export async function requestApprovalCodeAction(input: {
  token: string;
}): Promise<SignedOutApprovalResult> {
  const parsed = signedOutInput.safeParse(input);
  if (!parsed.success) return { outcome: "notification_action_invalid" };
  const result = await requestApprovalLinkCode(await createServerSupabase(), parsed.data.token);
  if (!result.ok) return { outcome: "refused", refusal: outcomeFor(result.error) };
  return { outcome: "code_sent" };
}

/** Shows the request once the code is right; a wrong code counts toward the lock of 5. */
export async function previewApprovalLinkAction(input: {
  token: string;
  code: string;
}): Promise<SignedOutApprovalResult> {
  const parsed = signedOutInput.safeParse(input);
  if (!parsed.success || !parsed.data.code)
    return { outcome: "approval_link_code_wrong", attemptsLeft: null };
  const result = await previewSignedOutApprovalLink(await createServerSupabase(), {
    token: parsed.data.token,
    code: parsed.data.code,
  });
  if (!result.ok) return { outcome: "refused", refusal: outcomeFor(result.error) };
  return result.data;
}

/** Decides with the link's own action, the code and, for a rejection, the reason. */
export async function decideApprovalLinkAction(input: {
  token: string;
  code: string;
  reason?: string;
}): Promise<SignedOutApprovalResult> {
  const parsed = signedOutInput.safeParse(input);
  if (!parsed.success || !parsed.data.code)
    return { outcome: "approval_link_code_wrong", attemptsLeft: null };
  const result = await decideThroughSignedOutLink(await createServerSupabase(), {
    token: parsed.data.token,
    code: parsed.data.code,
    comment: parsed.data.reason ?? null,
  });
  if (!result.ok) return { outcome: "refused", refusal: outcomeFor(result.error) };
  return result.data;
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
