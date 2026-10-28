/**
 * Settings, Security in Compass (Section 4.5.6 item 4, A77, A99, ADR 0070): the password, second factors, passkeys,
 * recovery codes and signed-in sessions of the one sign-in a person uses in Atlas, Gateway and Compass. Every call
 * runs with the person's own session, so Supabase Auth and the RPCs of migrations 1330, 1331, 1560 and 1561 touch
 * only their own factors, codes and sessions. All of it needs the server's answer at once, so none of it queues.
 *
 * Step-up follows Gateway (apps/gateway/app/auth/security-actions.ts, stepUpGate): a second factor passed in the
 * last 15 minutes before removing a second factor or making recovery codes, and, once the person holds a second
 * factor, before removing a passkey or changing the password, like any change to how they sign in. The database and
 * Supabase Auth refuse on their own; the check here opens the step-up sheet before the call.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_SECURITY_RULES } from "@xos/data/account-security";
import type { DataError } from "@xos/data/result";

/** When an action asks for a recent second factor first. */
export type StepUpRule = "always" | "if-factor";

/** Whether to step up before the action, given whether the person holds a second factor and passed one recently. */
export function needsStepUp(rule: StepUpRule, holdsFactor: boolean, recent: boolean): boolean {
  if (recent) return false;
  return rule === "always" || holdsFactor;
}

/** The step-up rule of each action on the Security screen. */
export const STEP_UP: Readonly<Record<string, StepUpRule>> = {
  /** Supabase Auth asks for aal2 to add a factor beside one held; Compass asks for a recent one, as for any change. */
  addFactor: "if-factor",
  removeFactor: "always",
  makeRecoveryCodes: "always",
  removePasskey: "if-factor",
  changePassword: "if-factor",
};

/** Refusals the security screens name in copy (authSecurity.errors.*). */
const KNOWN = new Set([
  ...ACCOUNT_SECURITY_RULES,
  "code_expired",
  "factor_limit",
  "factor_name_taken",
  "factor_label_length",
  "passkey_failed",
]);

/** The authSecurity.errors key for a failed security call. */
export function securityErrorKey(error: DataError): string {
  if (error.kind === "refusal") {
    if (error.rule === "code_invalid") return "authSecurity.errors.code_invalid";
    if (KNOWN.has(error.rule)) return `authSecurity.errors.${error.rule}`;
    return "authSecurity.errors.unexpected";
  }
  if (error.kind === "not-found") return "authSecurity.errors.denied";
  if (error.kind === "invalid") return "authSecurity.errors.invalid";
  return "authSecurity.errors.unexpected";
}

/** True for a refusal that a recent second factor answers. */
export function isStepUpRefusal(error: DataError): boolean {
  return error.kind === "refusal" && error.rule === "step_up_required";
}

// Password ------------------------------------------------------------------------------------------------------------

export type PasswordOutcome =
  | "ok"
  /** The session signed in more than a day ago (secure_password_change): confirm with a code sent by email. */
  | "reauthenticate"
  | "code_invalid"
  | "same_password"
  | "weak_password"
  | "step_up_required"
  | "rate_limited"
  | "network"
  | "unexpected";

interface AuthErrorLike {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  readonly message: string;
}

function isNetwork(error: AuthErrorLike): boolean {
  return error.status === 0 || /fetch|network/i.test(error.message);
}

/** A Supabase Auth answer to a password change, as an outcome the form names. */
export function passwordOutcome(error: AuthErrorLike | null): PasswordOutcome {
  if (!error) return "ok";
  switch (error.code) {
    case "reauthentication_needed":
      return "reauthenticate";
    case "reauthentication_not_valid":
      return "code_invalid";
    case "same_password":
      return "same_password";
    case "weak_password":
      return "weak_password";
    case "insufficient_aal":
      return "step_up_required";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "rate_limited";
    default:
      return isNetwork(error) ? "network" : "unexpected";
  }
}

/**
 * Sets a new password on the person's sign-in (Supabase Auth updateUser). With secure_password_change on, a session
 * that signed in more than a day ago first gets a code by email (sendPasswordCode) and passes it as `nonce`. A person
 * who signs in only with Google or an email link sets their first password the same way. Supabase Auth tells the
 * person by email, and the database sends account.security_changed (A104).
 */
export async function changePassword(
  client: SupabaseClient,
  password: string,
  nonce?: string,
): Promise<PasswordOutcome> {
  try {
    const { error } = await client.auth.updateUser(nonce ? { password, nonce } : { password });
    return passwordOutcome(error);
  } catch (error: unknown) {
    return passwordOutcome({ message: error instanceof Error ? error.message : String(error) });
  }
}

/** Emails the person the code a password change asks for on a session older than a day. */
export async function sendPasswordCode(client: SupabaseClient): Promise<PasswordOutcome> {
  try {
    const { error } = await client.auth.reauthenticate();
    return passwordOutcome(error);
  } catch (error: unknown) {
    return passwordOutcome({ message: error instanceof Error ? error.message : String(error) });
  }
}

// Sessions ------------------------------------------------------------------------------------------------------------

/**
 * The user agent Compass records for its session (app.touch_my_session, 1561), so Sessions and devices reads
 * "Compass on iOS": deviceName in @xos/data/account-security reads the app from "Compass/" and the system from
 * "iOS" or "Android".
 */
export function compassUserAgent(
  version: string,
  platform: string,
  osVersion: string | number,
): string {
  const system = platform === "ios" ? "iOS" : platform === "android" ? "Android" : platform;
  return `Compass/${version || "0"} (${system} ${String(osVersion)})`;
}

/** Recovery codes as one block of text, for the share sheet: a heading, the codes one per line, and the note. */
export function recoveryCodesText(codes: readonly string[], heading: string, note: string): string {
  return [heading, "", ...codes, "", note].join("\n");
}
