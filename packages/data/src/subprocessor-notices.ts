import type { XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Subprocessor List change notices (Section 14.4, legal/subprocessors.md section 1, finding A65-014;
 * migration 1382). Anyone may subscribe with double opt-in: the subscribe call queues a
 * confirmation email and only the token in that email confirms. Owners and Admins of a customer org
 * receive the notices by default and opt out in Settings, Notifications.
 *
 * The public calls answer the same whatever the address's state, so a form built on them reveals
 * nothing about who subscribed. Each refuses a read-only (GET) request, so the shells call them from
 * a server action after a POST, never while rendering a page a mail scanner may fetch.
 */

/** Confirmation tokens the email carries (1382). */
export const SUBPROCESSOR_CONFIRM_TOKEN = /^xspn_[0-9a-f]{64}$/;
/** Unsubscribe tokens each notice carries (1382). */
export const SUBPROCESSOR_UNSUBSCRIBE_TOKEN = /^xspu_[0-9a-f]{64}$/;

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
};

function publicApi(db: XosClient): PublicRpc {
  return (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
}

/**
 * Subscribes an address; a confirmation email follows. Answers false only when the input is not an
 * address. A rate-limited call also answers true and sends nothing, as the database decides.
 */
export async function subscribeSubprocessorNotices(
  db: XosClient,
  email: string,
  locale: "en-US" | "es-US",
): Promise<Result<boolean>> {
  const { data, error } = await publicApi(db).rpc("subscribe_subprocessor_notices", {
    p_email: email.trim(),
    p_locale: locale,
  });
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

/** Confirms a subscription with the emailed token. False for a wrong, used or expired token. */
export async function confirmSubprocessorNotices(
  db: XosClient,
  token: string,
): Promise<Result<boolean>> {
  if (!SUBPROCESSOR_CONFIRM_TOKEN.test(token)) return ok(false);
  const { data, error } = await publicApi(db).rpc("confirm_subprocessor_notices", {
    p_token: token,
  });
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

/** Ends a subscription with the unsubscribe token a notice carried. False for an unknown token. */
export async function unsubscribeSubprocessorNotices(
  db: XosClient,
  token: string,
): Promise<Result<boolean>> {
  if (!SUBPROCESSOR_UNSUBSCRIBE_TOKEN.test(token)) return ok(false);
  const { data, error } = await publicApi(db).rpc("unsubscribe_subprocessor_notices", {
    p_token: token,
  });
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

export interface MemberNoticeSubscription {
  /** An Owner or Admin of a customer org: receives the notices unless opted out. */
  readonly eligible: boolean;
  readonly subscribed: boolean;
}

/** Whether the signed-in person receives the notices as an Owner or Admin. */
export async function getMemberNoticeSubscription(
  db: XosClient,
): Promise<Result<MemberNoticeSubscription>> {
  const { data, error } = await db.rpc("subprocessor_notice_subscription");
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : data) as
    { eligible?: boolean; subscribed?: boolean } | null | undefined;
  return ok({ eligible: row?.eligible === true, subscribed: row?.subscribed === true });
}

/** Opts the signed-in person out of the notices, or back in. */
export async function setMemberNoticeSubscription(
  db: XosClient,
  subscribed: boolean,
): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("set_subprocessor_notice_subscription", {
    p_subscribed: subscribed,
  });
  if (error) return fail(toDataError(error));
  return ok(data === true);
}
