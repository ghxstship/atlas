/**
 * Forgot password (release 4.19, owner decision of 2026-11-27). A person asks for a reset link on
 * /auth/forgot-password; Supabase Auth emails the recovery template (supabase/templates/recovery.html); the link
 * returns through /auth/callback, which exchanges its code and lands on /auth/reset-password, where the person
 * chooses a new password. Three rules hold the flow together:
 *   - the request answers the same way whether or not an account uses the address (no account enumeration);
 *   - only a session that came from a reset link, in the last RECOVERY_WINDOW_SECONDS, may set a password there, so a
 *     session left open on a shared computer cannot be turned into a password;
 *   - a person who holds a second factor passes it first: the page sends them to /auth/mfa, and Supabase Auth refuses
 *     the change at aal1 on its own.
 */

export const FORGOT_PASSWORD_PATH = "/auth/forgot-password";
export const RESET_PASSWORD_PATH = "/auth/reset-password";

/** How long after the reset link was opened the session may set a password: time to pass a second factor and type. */
export const RECOVERY_WINDOW_SECONDS = 30 * 60;

/**
 * What auth-js reports as `redirectType` from exchangeCodeForSession when the code came from a reset link:
 * resetPasswordForEmail stores its code verifier with a `/recovery` suffix.
 */
export const RECOVERY_REDIRECT_TYPE = "recovery";

function claims(accessToken: string | null | undefined): Record<string, unknown> | null {
  const payload = accessToken?.split(".")[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      (error instanceof Error && error.name === "InvalidCharacterError")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * When the session behind an access token opened a reset link, in epoch seconds, or null when it never did. Supabase
 * Auth lists how a session authenticated in the token's `amr` claim; a reset link adds `recovery` with its time. The
 * token comes from the session cookie after `getUser()` confirmed the session with Supabase Auth.
 */
export function tokenRecoveredAt(accessToken: string | null | undefined): number | null {
  const amr = claims(accessToken)?.["amr"];
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const entry of amr as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (method !== "recovery" || typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      continue;
    }
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest;
}

/** Whether the session opened a reset link recently enough to set a password at `nowMs`. */
export function recoveryIsFresh(accessToken: string | null | undefined, nowMs: number): boolean {
  const at = tokenRecoveredAt(accessToken);
  if (at === null) return false;
  const age = nowMs / 1000 - at;
  // A minute of clock difference between this server and Supabase Auth is allowed for.
  return age >= -60 && age <= RECOVERY_WINDOW_SECONDS;
}

/**
 * Whether a code exchange came from a reset link. auth-js returns `redirectType` at runtime though its types leave it
 * out, so it is read from an unknown; the new session's `recovery` method in `amr` says the same thing on its own.
 */
export function exchangedResetLink(
  data: { readonly session: { readonly access_token: string } | null },
  nowMs: number,
): boolean {
  const redirectType: unknown = (data as { readonly redirectType?: unknown }).redirectType;
  return (
    redirectType === RECOVERY_REDIRECT_TYPE || recoveryIsFresh(data.session?.access_token, nowMs)
  );
}

interface AuthErrorLike {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
}

/**
 * What the request form says after Supabase Auth answered. Supabase Auth answers 200 for an address with no account,
 * and refuses only an address that has one (its per-address send interval and the hourly email limit, both
 * `over_email_send_rate_limit`, or a mail server fault), so every one of those reads as sent. The request rate limit
 * counts requests by network address before any account is looked up, so saying it tells nothing about an account.
 */
export function resetRequestOutcome(error: AuthErrorLike | null): "sent" | "rate_limited" {
  if (!error) return "sent";
  if (error.code === "over_request_rate_limit") return "rate_limited";
  if (error.status === 429 && (error.code ?? "") === "") return "rate_limited";
  return "sent";
}

export type NewPasswordError =
  | "weak_password"
  | "same_password"
  | "reset_link_invalid"
  | "second_factor"
  | "over_request_rate_limit"
  | "unexpected";

/** A Supabase Auth refusal of the new password, as the message the form shows (`shell.auth.errors`). */
export function newPasswordError(error: AuthErrorLike): NewPasswordError {
  switch (error.code) {
    case "weak_password":
      return "weak_password";
    case "same_password":
      return "same_password";
    case "insufficient_aal":
      return "second_factor";
    // The session is older than Supabase Auth's secure password change allows, or it ended.
    case "reauthentication_needed":
    case "session_not_found":
    case "session_expired":
    case "user_not_found":
    case "bad_jwt":
    case "no_authorization":
      return "reset_link_invalid";
    case "over_request_rate_limit":
      return "over_request_rate_limit";
    default:
      return error.status === 429 ? "over_request_rate_limit" : "unexpected";
  }
}
