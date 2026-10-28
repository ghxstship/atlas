/**
 * Actionable push notifications (Section 11.10 rule 5, journey 57, ADR 0030): an approval request is
 * approved or rejected from the notification itself, without opening Compass or the record.
 *
 * The push contract the sender follows (Expo push service, `categoryId` and `data`; on iOS Expo carries
 * `data` in the APNs payload's `body` key and the category in `aps.category`):
 *   - categoryId "approval_request" for approval.requested notifications;
 *   - data { notificationId, kind, subjectTable, subjectId, title, recordKey, url } where notificationId
 *     is the app.notifications id the action acts on, recordKey the key of the record it is about, if any,
 *     and url its deep link.
 * Compass registers the category with two actions, Approve and Reject (Reject asks for the reason), and
 * answers each through notifications.act (POST /api/v1/notifications/{id}/act), which runs
 * app.act_on_notification as the person, so every approval rule still decides.
 *
 * Every other tap opens its target (A101, Section 4.5.7): the record the notification carries the key of
 * (data.recordKey, from message_args.recordKey of migration 1600), else the deep link in data.url, which the
 * sender resolves from the record and its project when no key is carried. A tap that launched Compass is
 * routed the same way. The in-app Inbox opens its notifications by the same rule.
 */
import {
  compassPathForIncoming,
  compassRoute,
  isRecordKey,
  parseHandoffUrl,
} from "@xos/ia/handoff";

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

/** The approval action a response asks for, or null when it is a tap, another category or malformed. */
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

/** What a notification names as its target: its deep link, the record key it carries and its org. */
export interface NotificationLink {
  /** The push's deep link (data.url): a Compass scheme link, a Compass route or a handoff URL. */
  readonly url?: unknown;
  /** The display key of the record the notification is about (message_args.recordKey, 1600). */
  readonly recordKey?: unknown;
  /** The slug of the notification's org, when the caller knows it. */
  readonly org?: unknown;
}

const ORG_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The Compass route the default deep link opens, and any target Compass cannot resolve. */
export const INBOX_ROUTE = "/inbox";

/**
 * The Compass route a notification opens: the record it carries the key of, in the org its link or the
 * caller names; else the item its deep link hands off (a record or an engagement); else the route of a
 * Compass scheme link (compass://inbox opens the Inbox); else the Inbox.
 */
export function notificationRoute(link: NotificationLink): string {
  const url = typeof link.url === "string" ? link.url.trim() : "";
  const target = url === "" ? null : parseHandoffUrl(url);
  const key = typeof link.recordKey === "string" ? link.recordKey : "";
  if (isRecordKey(key)) {
    const org = target?.kind === "record" ? target.org : link.org;
    return typeof org === "string" && ORG_SLUG.test(org)
      ? compassRoute({ kind: "record", org, recordKey: key })
      : `/r/${encodeURIComponent(key)}`;
  }
  // A handoff link in any form becomes the Compass route of its item, as an incoming system link does.
  const incoming = url === "" ? "" : compassPathForIncoming(url);
  if (target && incoming !== "") return incoming;
  const scheme = /^compass:\/\/\/?([A-Za-z0-9][A-Za-z0-9/_-]*)(\?[^#]*)?$/.exec(url);
  if (scheme) return `/${scheme[1] ?? ""}${scheme[2] ?? ""}`;
  if (/^\/(?!\/)[A-Za-z0-9/_-]*(\?[^#]*)?$/.test(url)) return url;
  return INBOX_ROUTE;
}

/** The record key a push or Inbox notification carries: data.recordKey, or its message_args. */
function carriedRecordKey(data: Readonly<Record<string, unknown>>): unknown {
  if (typeof data["recordKey"] === "string") return data["recordKey"];
  const args = data["message_args"];
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)["recordKey"]
    : undefined;
}

/**
 * The route a tap on the notification itself opens, or null for an action button. A tap on an approval
 * request opens the Inbox, as before; every other tap opens its target (notificationRoute).
 */
export function tapRoute(response: ActionResponseLike): string | null {
  if (response.actionIdentifier !== DEFAULT_ACTION) return null;
  if (isApprovalTap(response)) return INBOX_ROUTE;
  const data = pushData(response.notification.request.content);
  return notificationRoute({ url: data["url"], recordKey: carriedRecordKey(data) });
}

/** A notification as the in-app Inbox reads it (app.notifications under the person's own access). */
export interface InboxNotificationRow {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly read: boolean;
  readonly args: Readonly<Record<string, unknown>>;
  readonly subjectTable: string | null;
  readonly subjectId: string | null;
  readonly orgSlug: string | null;
  /** The org the notification belongs to, for the role lens of the active org (A128). */
  readonly orgId?: string | null;
  /** For an approval request, the spend document type it asks about. */
  readonly documentType?: string | null;
  /** The record key read from the record and its project when the notification carries none. */
  readonly lookedUpRecordKey: string | null;
}

/** Where an Inbox notification opens: a Compass route, or a Gateway page for what Compass has no screen for. */
export type InboxTarget =
  | { readonly kind: "route"; readonly route: string }
  | { readonly kind: "gateway"; readonly path: string };

const GATEWAY_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]{0,199}$/;

/** True for a notification about a record, whose key the Inbox reads when the notification carries none. */
export function needsRecordLookup(
  row: Pick<InboxNotificationRow, "args" | "subjectTable" | "subjectId">,
): boolean {
  const key = row.args["recordKey"];
  return (
    !(typeof key === "string" && isRecordKey(key)) &&
    row.subjectId !== null &&
    (row.subjectTable === "records" || row.subjectTable === "app.records")
  );
}

/**
 * Where an Inbox notification opens: the record it carries the key of, or whose key the Inbox read from
 * the record and its project (the sender's own fallback); else the Gateway page it names, such as a
 * marketplace match's listing; else nowhere, and the row only informs.
 */
export function inboxTarget(row: InboxNotificationRow): InboxTarget | null {
  const carried = row.args["recordKey"];
  const key = typeof carried === "string" && isRecordKey(carried) ? carried : row.lookedUpRecordKey;
  if (key !== null && isRecordKey(key))
    return { kind: "route", route: notificationRoute({ recordKey: key, org: row.orgSlug }) };
  const path = row.args["gatewayPath"];
  if (typeof path === "string" && GATEWAY_PATH.test(path)) return { kind: "gateway", path };
  return null;
}

/** The record key the Inbox shows beside a notification, when it has one. */
export function inboxRecordKey(row: InboxNotificationRow): string | null {
  const carried = row.args["recordKey"];
  if (typeof carried === "string" && isRecordKey(carried)) return carried;
  return row.lookedUpRecordKey !== null && isRecordKey(row.lookedUpRecordKey)
    ? row.lookedUpRecordKey
    : null;
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
