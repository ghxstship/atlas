import { isActionToken } from "@xos/schemas/notifications/action-token";
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { rows, rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * One-tap action links from notification emails (A127, migration 2200, ADR 0106) and the For Your Information list
 * Gateway Home shows beside Needs You.
 *
 * A link opens the confirm page in Atlas or Gateway at /auth/act/{token}. Opening it reads what it does
 * (app.read_notification_action) and never acts; the page's button acts (app.use_notification_action), for the
 * signed-in recipient only, once, before it expires, through app.act_on_notification, so every rule and step-up
 * decides as in the Inbox. Each page names its app, and a link works only in the app it was sent for: a member's in
 * Atlas, which applies the org's security settings, an external party's or an applicant's in Gateway.
 */

export { isActionToken };

export type ActionLinkState = "ready" | "used" | "expired" | "elsewhere" | "not_yours" | "invalid";
export type LinkAction = "approve" | "reject" | "accept";
/** The app whose confirm page reads or uses a link. */
export type LinkApp = "Atlas" | "Gateway";

export interface ActionLink {
  readonly state: ActionLinkState;
  /** Null unless the link is the signed-in person's own. */
  readonly action: LinkAction | null;
  readonly kind: string | null;
  readonly title: string | null;
  readonly orgName: string | null;
  /** The org's slug, for a link to its Inbox in Atlas. */
  readonly orgSlug: string | null;
  /** The app the link was sent for; with state elsewhere, the other app. */
  readonly audience: LinkApp | null;
  readonly expiresAt: string | null;
}

const STATES: readonly ActionLinkState[] = [
  "ready",
  "used",
  "expired",
  "elsewhere",
  "not_yours",
  "invalid",
];
const ACTIONS: readonly LinkAction[] = ["approve", "reject", "accept"];

const INVALID: ActionLink = {
  state: "invalid",
  action: null,
  kind: null,
  title: null,
  orgName: null,
  orgSlug: null,
  audience: null,
  expiresAt: null,
};

/**
 * What a link does, for the signed-in person, on the confirm page of `app`; a malformed token is invalid without
 * asking the database.
 */
export async function readActionLink(
  db: XosClient,
  token: string,
  app: LinkApp,
): Promise<Result<ActionLink>> {
  if (!isActionToken(token)) return ok(INVALID);
  return rpc(db, "read_notification_action", { p_token: token, p_app: app }, (data) => {
    const row = (Array.isArray(data) ? data[0] : data) as Raw | undefined;
    if (!row) return INVALID;
    const state = str(row["link_state"]) as ActionLinkState;
    const action = strOrNull(row["action"]);
    const audience = strOrNull(row["audience"]);
    return {
      state: STATES.includes(state) ? state : "invalid",
      action:
        action !== null && (ACTIONS as readonly string[]).includes(action)
          ? (action as LinkAction)
          : null,
      kind: strOrNull(row["kind"]),
      title: strOrNull(row["title"]),
      orgName: strOrNull(row["org_name"]),
      orgSlug: strOrNull(row["org_slug"]),
      audience: audience === "Atlas" || audience === "Gateway" ? audience : null,
      expiresAt: strOrNull(row["expires_at"]),
    };
  });
}

/** Acts through a link on the confirm page of `input.app`: a rejection carries its reason. Returns the notification id. */
export async function actThroughLink(
  db: XosClient,
  input: { token: string; app: LinkApp; comment?: string | null },
): Promise<Result<string>> {
  if (!isActionToken(input.token))
    return fail({
      kind: "refusal",
      rule: "notification_action_invalid",
      message: "This link does not work. Open the item from your Inbox.",
    });
  return rpc(
    db,
    "use_notification_action",
    { p_token: input.token, p_app: input.app, p_comment: input.comment ?? null },
    str,
  );
}

// Signed-out approval links (P9, migration 2861, ADR 0138) ------------------------------------------------------

/**
 * A link sent to an outside approver of an engagement step that lets them decide from email works without a sign-in:
 * the page reads what it does with the token alone (no title: it names the pass holder), emails a 6-digit code on
 * request, shows the request once the code is entered, and decides with the token and the code. Every call runs as
 * anon through api_public; wrong codes count across both links of the notification and lock them at 5.
 */
export type SignedOutLinkState = "ready" | "used" | "expired" | "locked" | "sign_in" | "invalid";

export interface SignedOutApprovalLink {
  readonly state: SignedOutLinkState;
  /** The link's own action; a Reject link needs a reason. Null unless the state is ready, used, expired or locked. */
  readonly action: "approve" | "reject" | null;
  readonly orgName: string | null;
  /** Where the code goes, such as j***@venue.com. */
  readonly maskedEmail: string | null;
  readonly expiresAt: string | null;
}

const SIGNED_OUT_STATES: readonly SignedOutLinkState[] = [
  "ready",
  "used",
  "expired",
  "locked",
  "sign_in",
  "invalid",
];

const SIGNED_OUT_INVALID: SignedOutApprovalLink = {
  state: "invalid",
  action: null,
  orgName: null,
  maskedEmail: null,
  expiresAt: null,
};

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
};

function publicRpc(db: XosClient): PublicRpc {
  return (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
}

async function publicRows(db: XosClient, fn: string, args: Raw): Promise<Result<Raw[]>> {
  const { data, error } = await publicRpc(db).rpc(fn, args);
  if (error) return fail(toDataError(error));
  return ok(Array.isArray(data) ? (data as Raw[]) : data ? [data as Raw] : []);
}

/** Maps a read_approval_link row; anything unexpected reads as invalid. */
export function toSignedOutLink(row: Raw | undefined): SignedOutApprovalLink {
  if (!row) return SIGNED_OUT_INVALID;
  const state = str(row["link_state"]) as SignedOutLinkState;
  if (!SIGNED_OUT_STATES.includes(state)) return SIGNED_OUT_INVALID;
  const action = strOrNull(row["action"]);
  return {
    state,
    action: action === "approve" || action === "reject" ? action : null,
    orgName: strOrNull(row["org_name"]),
    maskedEmail: strOrNull(row["masked_email"]),
    expiresAt: strOrNull(row["expires_at"]),
  };
}

/** What a signed-out approval link does, with the token alone (api_public.read_approval_link). Never acts. */
export async function readSignedOutApprovalLink(
  db: XosClient,
  token: string,
): Promise<Result<SignedOutApprovalLink>> {
  if (!isActionToken(token)) return ok(SIGNED_OUT_INVALID);
  const result = await publicRows(db, "read_approval_link", { p_token: token });
  if (!result.ok) return result;
  return ok(toSignedOutLink(result.data[0]));
}

/** Email me a code: queues the code to the link's recipient; refusals come back typed with their rule. */
export async function requestApprovalLinkCode(db: XosClient, token: string): Promise<Result<null>> {
  if (!isActionToken(token))
    return fail({
      kind: "refusal",
      rule: "notification_action_invalid",
      message: "This link does not work. Open the item from your Inbox.",
    });
  const result = await publicRows(db, "request_approval_link_code", { p_token: token });
  return result.ok ? ok(null) : result;
}

/** The outcome of a code check or a decision through a signed-out link. */
export type SignedOutOutcome =
  | "ok"
  | "decided"
  | "notification_action_invalid"
  | "approval_link_locked"
  | "approval_link_code_wrong"
  | "notification_action_used"
  | "notification_action_expired"
  | "notification_action_reason";

const OUTCOMES: readonly SignedOutOutcome[] = [
  "ok",
  "decided",
  "notification_action_invalid",
  "approval_link_locked",
  "approval_link_code_wrong",
  "notification_action_used",
  "notification_action_expired",
  "notification_action_reason",
];

export interface SignedOutCheck {
  readonly outcome: SignedOutOutcome;
  /** Wrong codes still allowed before the links lock; null when the link was refused before the code. */
  readonly attemptsLeft: number | null;
}

/** Maps a refusal row of preview_approval_link or use_approval_link; an unknown outcome reads as invalid. */
export function toSignedOutCheck(row: Raw | undefined): SignedOutCheck {
  const outcome = str(row?.["outcome"]) as SignedOutOutcome;
  const left = row?.["attempts_left"];
  return {
    outcome: OUTCOMES.includes(outcome) ? outcome : "notification_action_invalid",
    attemptsLeft:
      typeof left === "number" ? left : left === null || left === undefined ? null : Number(left),
  };
}

const ACCESS_CODE = /^[0-9]{6}$/;

export interface SignedOutPreview extends SignedOutCheck {
  /** With outcome ok: what the request is about, and the step it waits on. */
  readonly title: string | null;
  readonly stepName: string | null;
}

/** The request behind a signed-out link, once the code is entered (api_public.preview_approval_link). */
export async function previewSignedOutApprovalLink(
  db: XosClient,
  input: { readonly token: string; readonly code: string },
): Promise<Result<SignedOutPreview>> {
  if (!isActionToken(input.token))
    return ok({
      outcome: "notification_action_invalid",
      attemptsLeft: null,
      title: null,
      stepName: null,
    });
  const result = await publicRows(db, "preview_approval_link", {
    p_token: input.token,
    p_access_code: ACCESS_CODE.test(input.code.trim()) ? input.code.trim() : "",
  });
  if (!result.ok) return result;
  const row = result.data[0];
  return ok({
    ...toSignedOutCheck(row),
    title: strOrNull(row?.["title"]),
    stepName: strOrNull(row?.["current_step_name"]),
  });
}

/**
 * Decides through a signed-out link with its code (api_public.use_approval_link). Refusals of the link itself come back
 * as outcomes (a counted wrong code keeps its count); a refusal of the decision's own rules comes back as the error,
 * with its rule, so both reach the page as one typed result.
 */
export async function decideThroughSignedOutLink(
  db: XosClient,
  input: { readonly token: string; readonly code: string; readonly comment?: string | null },
): Promise<Result<SignedOutCheck>> {
  if (!isActionToken(input.token))
    return ok({ outcome: "notification_action_invalid", attemptsLeft: null });
  const result = await publicRows(db, "use_approval_link", {
    p_token: input.token,
    p_access_code: ACCESS_CODE.test(input.code.trim()) ? input.code.trim() : "",
    p_comment: input.comment?.trim() || null,
  });
  if (!result.ok) return result;
  return ok(toSignedOutCheck(result.data[0]));
}

/** One For Your Information item on Gateway Home. */
export interface FyiItem {
  readonly id: string;
  readonly orgId: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly read: boolean;
  /** Display values for the kind's catalog message (title, orgName, gatewayPath and the like). */
  readonly args: Readonly<Record<string, string>>;
}

function stringArgs(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, value] of Object.entries(v as Raw)) {
      if (typeof value === "string" || typeof value === "number") out[k] = String(value);
    }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The signed-in person's For Your Information items across every org that notified them, newest first: live
 * notifications that are neither Done nor snoozed (app.inbox_items, under their own row level security), and need
 * nothing from them. A published shift they work or an offer awaiting them still needs their answer
 * (app.my_notifications_awaiting_answer), so it is left out: Done there would retire the email's Accept link while
 * the shift or offer stays unanswered.
 */
export async function listForYourInformation(
  db: XosClient,
  limit = 20,
): Promise<Result<FyiItem[]>> {
  const awaiting = await rpc(db, "my_notifications_awaiting_answer", {}, (data) =>
    (Array.isArray(data) ? data : [])
      .map((v) => (typeof v === "string" ? v : str((v as Raw)["my_notifications_awaiting_answer"])))
      .filter((v) => UUID.test(v)),
  );
  if (!awaiting.ok) return awaiting;
  let query = untyped(db)
    .from("inbox_items")
    .select("id, org_id, kind, created_at, read_at, message_args")
    .eq("section", "For Your Information");
  if (awaiting.data.length > 0) query = query.not("id", "in", `(${awaiting.data.join(",")})`);
  const result = await rows(
    query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      orgId: str(r["org_id"]),
      kind: str(r["kind"]),
      createdAt: str(r["created_at"]),
      read: r["read_at"] !== null && r["read_at"] !== undefined,
      args: stringArgs(r["message_args"]),
    })),
  );
}
