/**
 * Sign-in errors the console names, as catalog keys under `console.auth.errors`. Supabase Auth codes map to a few
 * sentences; `not_operator` is the console's own: the account is not on the platform team, so it was signed out.
 */
export type SignInErrorKey =
  | "invalid_credentials"
  | "not_operator"
  | "provider_disabled"
  | "provider_error"
  | "link_invalid"
  | "over_request_rate_limit"
  | "unexpected";

const KNOWN: ReadonlySet<string> = new Set([
  "invalid_credentials",
  "not_operator",
  "provider_disabled",
  "provider_error",
  "link_invalid",
  "over_request_rate_limit",
]);

const ALIASES: Readonly<Record<string, SignInErrorKey>> = {
  email_not_confirmed: "invalid_credentials",
  bad_oauth_state: "link_invalid",
  bad_oauth_callback: "provider_error",
  flow_state_expired: "link_invalid",
  flow_state_not_found: "link_invalid",
  bad_code_verifier: "link_invalid",
  pkce_code_verifier_not_found: "link_invalid",
  oauth_provider_not_supported: "provider_disabled",
  over_email_send_rate_limit: "over_request_rate_limit",
};

export function signInErrorKey(error: {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
}): SignInErrorKey {
  const code = error.code ?? "";
  const alias = ALIASES[code];
  if (alias) return alias;
  if (KNOWN.has(code)) return code as SignInErrorKey;
  if (error.status === 429) return "over_request_rate_limit";
  return "unexpected";
}

/** The error a sign-in page shows from its `error` query parameter; unknown values say nothing. */
export function shownError(value: unknown): SignInErrorKey | null {
  return typeof value === "string" && (KNOWN.has(value) || value === "unexpected")
    ? (value as SignInErrorKey)
    : null;
}

/** Second-factor refusals the console names under `console.auth.secondFactor.errors`. */
export type SecondFactorErrorKey = "code_invalid" | "code_expired" | "rate_limited" | "unexpected";

export function secondFactorErrorKey(error: {
  readonly kind: string;
  readonly rule?: string;
}): SecondFactorErrorKey {
  if (error.kind !== "refusal") return "unexpected";
  return error.rule === "code_invalid" ||
    error.rule === "code_expired" ||
    error.rule === "rate_limited"
    ? error.rule
    : "unexpected";
}
