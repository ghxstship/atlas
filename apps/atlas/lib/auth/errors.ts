/**
 * Supabase Auth error codes mapped to the catalog messages under `shell.auth.errors`. Each message
 * names the problem and the fix (Section 11.10, rule 11). Unknown codes fall back to `unexpected`.
 */
const KNOWN = new Set([
  "invalid_credentials",
  "email_not_confirmed",
  "user_already_exists",
  "weak_password",
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "provider_disabled",
  "oauth_cancelled",
  "oauth_expired",
  "provider_error",
  "email_not_verified",
  "sso_required",
  // Raised by the org blocklist (B16, migration 3050) when single sign-on would add a blocked person.
  "member_blocked",
]);

const ALIASES: Readonly<Record<string, string>> = {
  email_exists: "user_already_exists",
  otp_expired: "link_invalid",
  flow_state_expired: "link_invalid",
  flow_state_not_found: "link_invalid",
  bad_code_verifier: "link_invalid",
  // auth-js: the sign-in or link was started in another browser, or its cookie is gone.
  pkce_code_verifier_not_found: "link_invalid",
  // Sign in with Google and the other OAuth providers (ADR 0036).
  provider_email_needs_verification: "email_not_verified",
  bad_oauth_state: "oauth_expired",
  bad_oauth_callback: "provider_error",
  oauth_provider_not_supported: "provider_disabled",
  // Raised by app.join_by_sso (migration 0638) and kept for org single sign-on enforcement.
  sso_session_required: "sso_required",
};

export type AuthErrorKey =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "user_already_exists"
  | "weak_password"
  | "over_email_send_rate_limit"
  | "over_request_rate_limit"
  | "provider_disabled"
  | "link_invalid"
  | "oauth_cancelled"
  | "oauth_expired"
  | "provider_error"
  | "email_not_verified"
  | "sso_required"
  | "member_blocked"
  | "unexpected";

export function authErrorKey(error: {
  code?: string | undefined;
  status?: number | undefined;
}): AuthErrorKey {
  const code = error.code ?? "";
  const alias = ALIASES[code];
  if (alias !== undefined) return alias as AuthErrorKey;
  if (KNOWN.has(code)) return code as AuthErrorKey;
  if (error.status === 429) return "over_request_rate_limit";
  return "unexpected";
}

/**
 * The error an OAuth provider round trip came back with, or null when it came back with a code.
 * Supabase Auth returns to /auth/callback with `error`, `error_code` and `error_description` in the
 * query (RFC 6749 section 4.1.2.1). A provider refusal that names no Supabase code, such as
 * `access_denied` when the person closes Google's consent screen, means the person cancelled; any
 * other refusal is the provider's error. The description is free text and is never shown.
 */
export function oauthCallbackError(params: URLSearchParams): AuthErrorKey | null {
  const error = params.get("error");
  const code = params.get("error_code");
  if (!error && !code) return null;
  if (code) {
    const key = authErrorKey({ code });
    if (key !== "unexpected") return key;
  }
  if (error === "access_denied" && !code) return "oauth_cancelled";
  return "provider_error";
}

/** Errors that are the person's own choice: shown as information, not as a failure. */
export function isAuthNotice(key: AuthErrorKey): boolean {
  return key === "oauth_cancelled";
}
