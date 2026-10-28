import { isActionToken } from "@xos/schemas/notifications/action-token";
import type { XosClient } from "./client.ts";
import { fail, ok, type Result } from "./result.ts";
import { rows, rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * One-tap action links from notification emails (A127, migration 2200, ADR 0089) and the For Your Information list
 * Gateway Home shows beside Needs You.
 *
 * A link opens the confirm page in Atlas or Gateway at /auth/act/{token}. Opening it reads what it does
 * (app.read_notification_action) and never acts; the page's button acts (app.use_notification_action), for the
 * signed-in recipient only, once, before it expires, through app.act_on_notification, so every rule and step-up
 * decides as in the Inbox.
 */

export { isActionToken };

export type ActionLinkState = "ready" | "used" | "expired" | "not_yours" | "invalid";
export type LinkAction = "approve" | "reject" | "accept";

export interface ActionLink {
  readonly state: ActionLinkState;
  /** Null unless the link is the signed-in person's own. */
  readonly action: LinkAction | null;
  readonly kind: string | null;
  readonly title: string | null;
  readonly orgName: string | null;
  /** The org's slug, for a link to its Inbox in Atlas. */
  readonly orgSlug: string | null;
  readonly audience: "Atlas" | "Gateway" | null;
  readonly expiresAt: string | null;
}

const STATES: readonly ActionLinkState[] = ["ready", "used", "expired", "not_yours", "invalid"];
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

/** What a link does, for the signed-in person; a malformed token is invalid without asking the database. */
export async function readActionLink(db: XosClient, token: string): Promise<Result<ActionLink>> {
  if (!isActionToken(token)) return ok(INVALID);
  return rpc(db, "read_notification_action", { p_token: token }, (data) => {
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

/** Acts through a link: a rejection carries its reason. Returns the notification id. */
export async function actThroughLink(
  db: XosClient,
  input: { token: string; comment?: string | null },
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
    { p_token: input.token, p_comment: input.comment ?? null },
    str,
  );
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

/**
 * The signed-in person's For Your Information items across every org that notified them, newest first: live
 * notifications that are neither Done nor snoozed (app.inbox_items, under their own row level security), and need
 * nothing from them.
 */
export async function listForYourInformation(
  db: XosClient,
  limit = 20,
): Promise<Result<FyiItem[]>> {
  const result = await rows(
    untyped(db)
      .from("inbox_items")
      .select("id, org_id, kind, created_at, read_at, message_args")
      .eq("section", "For Your Information")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
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
