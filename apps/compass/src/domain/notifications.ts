/**
 * Actionable push notifications (Section 11.10 rule 5, journey 57, ADR 0030): an approval request is
 * approved or rejected from the notification itself, without opening Compass or the record.
 *
 * The push contract the sender follows (Expo push service, `categoryId` and `data`; on iOS Expo carries
 * `data` in the APNs payload's `body` key and the category in `aps.category`):
 *   - categoryId "approval_request" for approval.requested notifications;
 *   - data { notificationId, kind, subjectTable, subjectId, title } where notificationId is the
 *     app.notifications id the action acts on.
 * Compass registers the category with two actions, Approve and Reject (Reject asks for the reason), and
 * answers each through notifications.act (POST /api/v1/notifications/{id}/act), which runs
 * app.act_on_notification as the person, so every approval rule still decides.
 */

export const APPROVAL_CATEGORY = "approval_request";
export const APPROVE_ACTION = "approve";
export const REJECT_ACTION = "reject";
/** expo-notifications' identifier for a tap on the notification body. */
export const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

export type NotificationAction = typeof APPROVE_ACTION | typeof REJECT_ACTION;

/** The parts of an expo-notifications response Compass reads. */
export interface ActionResponseLike {
  readonly actionIdentifier: string;
  readonly userText?: string | undefined;
  readonly notification: {
    readonly request: {
      readonly identifier: string;
      readonly content: {
        readonly categoryIdentifier?: string | null;
        readonly data?: Readonly<Record<string, unknown>> | null;
      };
    };
  };
}

export interface NotificationActionRequest {
  readonly notificationId: string;
  readonly action: NotificationAction;
  readonly comment: string | null;
  readonly title: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The approval action a response asks for, or null when it is a tap, another category or malformed. */
/**
 * The push data. expo-notifications hands over the APNs `body` for a remote notification; a delivery it
 * does not see as remote (a simulator push) hands over the whole payload, with the data still in `body`.
 */
function pushData(
  content: ActionResponseLike["notification"]["request"]["content"],
): Readonly<Record<string, unknown>> {
  const data = content.data ?? {};
  if (typeof data["notificationId"] === "string") return data;
  const body = data["body"];
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return { ...data, ...(body as Record<string, unknown>) };
  }
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

export function readActionResponse(response: ActionResponseLike): NotificationActionRequest | null {
  const action = response.actionIdentifier;
  if (action !== APPROVE_ACTION && action !== REJECT_ACTION) return null;
  const content = response.notification.request.content;
  const data = pushData(content);
  const category = content.categoryIdentifier ?? data["categoryId"];
  if (category !== APPROVAL_CATEGORY) return null;
  const notificationId = data["notificationId"];
  if (typeof notificationId !== "string" || !UUID.test(notificationId)) return null;
  const text = response.userText?.trim() ?? "";
  const title = data["title"];
  return {
    notificationId,
    action,
    comment: text === "" ? null : text,
    title: typeof title === "string" && title.trim() !== "" ? title : null,
  };
}

/** True when the person tapped an approval request itself: Compass opens its Inbox. */
export function isApprovalTap(response: ActionResponseLike): boolean {
  const content = response.notification.request.content;
  const category = content.categoryIdentifier ?? content.data?.["categoryId"];
  return response.actionIdentifier === DEFAULT_ACTION && category === APPROVAL_CATEGORY;
}

/** The notifications.act call for an action, with the person's own session token. */
export function actRequest(
  atlasUrl: string,
  request: NotificationActionRequest,
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

export type ActOutcome =
  | { readonly kind: "done"; readonly action: NotificationAction }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "failed" };

/** Reads the notifications.act answer: 200 done, a 4xx problem's detail as the refusal, else failed. */
export async function readActOutcome(
  request: NotificationActionRequest,
  response: { readonly status: number; json(): Promise<unknown> },
): Promise<ActOutcome> {
  if (response.status >= 200 && response.status < 300)
    return { kind: "done", action: request.action };
  if (response.status >= 400 && response.status < 500) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof body?.detail === "string" ? body.detail : "";
    return { kind: "refused", detail };
  }
  return { kind: "failed" };
}
