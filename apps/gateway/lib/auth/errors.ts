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
]);

const ALIASES: Readonly<Record<string, string>> = {
  email_exists: "user_already_exists",
  otp_expired: "link_invalid",
  flow_state_expired: "link_invalid",
  flow_state_not_found: "link_invalid",
  bad_code_verifier: "link_invalid",
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
