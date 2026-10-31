/**
 * Push actions for offers and messages (A127, ADR 0106; Section 11.10 rule 5): a shift still to accept and an offer
 * that waits on the applicant are accepted or declined from the notification, the lock screen included, and a message
 * is answered from it with a reply typed in place, all without opening Compass.
 *
 * The categories are the server's (packages/platform/src/notifications/push.ts, pushCategoryFor): shift_offer for
 * shift.assigned and shift.changed about a shift still Published, engagement_offer for offer.sent and message_reply
 * for message.received. Each action answers through notifications.act (POST /api/v1/notifications/{id}/act), which
 * runs app.act_on_notification as the person: app.accept_shift or app.accept_engaged_shift, app.decline_shift,
 * app.accept_offer, app.decline_offer, or app.send_chat_message with the reply. The approval category stays
 * notifications.ts's; this module never reads its actions, nor that one these.
 */
import type { ActionResponseLike } from "./notifications";

export const SHIFT_OFFER_CATEGORY = "shift_offer";
export const ENGAGEMENT_OFFER_CATEGORY = "engagement_offer";
export const MESSAGE_REPLY_CATEGORY = "message_reply";

export const ACCEPT_ACTION = "accept";
export const DECLINE_ACTION = "decline";
export const REPLY_ACTION = "reply";

export type OfferAction = typeof ACCEPT_ACTION | typeof DECLINE_ACTION | typeof REPLY_ACTION;

export type OfferCategory =
  typeof SHIFT_OFFER_CATEGORY | typeof ENGAGEMENT_OFFER_CATEGORY | typeof MESSAGE_REPLY_CATEGORY;

/** The actions each category carries, in the order the notification shows them. */
export const CATEGORY_ACTIONS: Readonly<Record<OfferCategory, readonly OfferAction[]>> = {
  [SHIFT_OFFER_CATEGORY]: [ACCEPT_ACTION, DECLINE_ACTION],
  [ENGAGEMENT_OFFER_CATEGORY]: [ACCEPT_ACTION, DECLINE_ACTION],
  [MESSAGE_REPLY_CATEGORY]: [REPLY_ACTION],
};

/**
 * Whether the device must be unlocked first. Accepting or declining a shift works from the lock screen (A127's bar: a
 * shift offer is accepted from the lock screen); an offer's terms bind the person to an engagement and a reply is
 * written in their name, so both ask for the device to be unlocked.
 */
export function needsUnlock(category: OfferCategory, action: OfferAction): boolean {
  void action;
  return category !== SHIFT_OFFER_CATEGORY;
}

export interface OfferActionRequest {
  readonly notificationId: string;
  readonly category: OfferCategory;
  readonly action: OfferAction;
  /** The reply typed in place; null for Accept and Decline. */
  readonly comment: string | null;
  readonly title: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOfferCategory(value: unknown): value is OfferCategory {
  return (
    value === SHIFT_OFFER_CATEGORY ||
    value === ENGAGEMENT_OFFER_CATEGORY ||
    value === MESSAGE_REPLY_CATEGORY
  );
}

/** The push data: expo-notifications' data, or the APNs `body` it carries for a delivery it does not see as remote. */
function pushData(
  content: ActionResponseLike["notification"]["request"]["content"],
): Readonly<Record<string, unknown>> {
  const data = content.data ?? {};
  if (typeof data["notificationId"] === "string") return data;
  const body = data["body"];
  if (body && typeof body === "object" && !Array.isArray(body))
    return { ...data, ...(body as Record<string, unknown>) };
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object") return { ...data, ...(parsed as object) };
    } catch {
      return data;
    }
  }
  return data;
}

/**
 * The offer or message action a response asks for, or null for a tap, an approval, an action the category does not
 * carry, a reply with no text, or malformed data.
 */
export function readOfferResponse(response: ActionResponseLike): OfferActionRequest | null {
  const content = response.notification.request.content;
  const data = pushData(content);
  const category = content.categoryIdentifier ?? data["categoryId"];
  if (!isOfferCategory(category)) return null;
  const action = response.actionIdentifier;
  const allowed: readonly string[] = CATEGORY_ACTIONS[category];
  if (!allowed.includes(action)) return null;
  const notificationId = data["notificationId"];
  if (typeof notificationId !== "string" || !UUID.test(notificationId)) return null;
  const text = response.userText?.trim() ?? "";
  if (action === REPLY_ACTION && text === "") return null;
  const title = data["title"];
  return {
    notificationId,
    category,
    action: action as OfferAction,
    comment: action === REPLY_ACTION ? text.slice(0, 4000) : null,
    title: typeof title === "string" && title.trim() !== "" ? title : null,
  };
}

/** The notifications.act call for an offer action, with the person's own session token. */
export function offerActRequest(
  atlasUrl: string,
  request: OfferActionRequest,
  accessToken: string,
): { readonly url: string; readonly init: RequestInit } {
  return {
    url: `${atlasUrl.replace(/\/+$/, "")}/api/v1/notifications/${request.notificationId}/act`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // One key per notification and action: a retried press never acts twice (ADR 0003).
        "Idempotency-Key": `push-${request.notificationId}-${request.action}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        action: request.action,
        ...(request.comment === null ? {} : { comment: request.comment }),
      }),
    },
  };
}

export type OfferOutcome =
  | { readonly kind: "done"; readonly request: OfferActionRequest }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "failed" };

/** Reads the notifications.act answer: 2xx done, a 4xx problem's detail as the refusal, else failed. */
export async function readOfferOutcome(
  request: OfferActionRequest,
  response: { readonly status: number; json(): Promise<unknown> },
): Promise<OfferOutcome> {
  if (response.status >= 200 && response.status < 300) return { kind: "done", request };
  if (response.status >= 400 && response.status < 500) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    return { kind: "refused", detail: typeof body?.detail === "string" ? body.detail : "" };
  }
  return { kind: "failed" };
}

/** The catalog key of the confirmation a done action shows, under compass.offerActions. */
export function doneMessageKey(request: OfferActionRequest): string {
  if (request.action === REPLY_ACTION) return "compass.offerActions.replied";
  const subject = request.category === SHIFT_OFFER_CATEGORY ? "shift" : "offer";
  return `compass.offerActions.${subject}${request.action === ACCEPT_ACTION ? "Accepted" : "Declined"}`;
}
