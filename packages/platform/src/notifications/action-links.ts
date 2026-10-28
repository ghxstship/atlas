// The action names alone: the email entry would bring React Email and the transports into every function (A85).
import { isEmailActionName, type EmailAction } from "@xos/email/actions";
import { ACTION_PATH, ACTION_TOKEN, isActionToken } from "@xos/schemas/notifications/action-token";

/**
 * One-tap action links in notification emails (A127, ADR 0086). The database mints each token at dispatch
 * (app.mint_notification_action_tokens): `xact_` and a 48 hex digit nonce, a dot, and the first 32 hex digits of the
 * HMAC-SHA256 of the nonce and the action under the Vault key xos_notification_action_key. Only its SHA-256 is stored.
 * This module turns minted tokens into the links an email carries and checks a token's shape before a page sends it on;
 * the signature itself is checked only in the database, which alone holds the key.
 *
 * A link opens the confirm page of the app it names, at /auth/act/{token}: Atlas for a member's approval or shift,
 * Gateway for an engaged worker's shift or an applicant's offer. The page never acts on opening; it shows what the link
 * does to the signed-in recipient and acts on a press (app.use_notification_action).
 */

export { ACTION_PATH, ACTION_TOKEN, isActionToken };

export type ActionAudience = "Atlas" | "Gateway";

/** One token as app.mint_notification_action_tokens returns it. */
export interface MintedAction {
  readonly action: string;
  readonly token: string;
  readonly audience: string;
}

export interface ActionLinkBases {
  /** Atlas's base URL (XOS_APP_URL). */
  readonly atlasUrl: string;
  /** Gateway's base URL (XOS_GATEWAY_URL); without it, Gateway's links are left out. */
  readonly gatewayUrl: string | null | undefined;
}

/** The confirm page path of a token. */
export function actionPath(token: string): string {
  if (!isActionToken(token)) throw new Error("Not an action token");
  return `${ACTION_PATH}/${token}`;
}

/** One link per well-formed minted token, on its app's base URL; anything else is left out, never sent broken. */
export function actionLinks(
  minted: readonly MintedAction[],
  bases: ActionLinkBases,
): EmailAction[] {
  return minted.flatMap((m): EmailAction[] => {
    if (!isEmailActionName(m.action) || !isActionToken(m.token)) return [];
    const base =
      m.audience === "Atlas" ? bases.atlasUrl : m.audience === "Gateway" ? bases.gatewayUrl : null;
    if (!base) return [];
    return [{ action: m.action, url: `${base.replace(/\/+$/, "")}${actionPath(m.token)}` }];
  });
}
