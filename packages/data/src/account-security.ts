import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DataError, type Result } from "./result.ts";

/**
 * A person's own sign-in security beyond their factors (A99, RRR-144; ADR 0055): recovery codes, signed-in sessions and
 * devices, and the account security trail. Every call runs with the caller's session, and the RPCs of migrations 1560
 * and 1561 only ever read or change the caller's own codes and sessions. Refusals keep the rules the database names:
 *
 * - `code_invalid`: the recovery code did not match (counted);   - `rate_limited`: five wrong codes in 15 minutes;
 * - `no_codes`: no usable codes (no second factor held);   - `recovery_codes_need_factor`: make codes after a factor;
 * - `step_up_required`: a second factor in the last 15 minutes first;   - `session_current`: use Sign out instead.
 */

// Recovery codes ---------------------------------------------------------------------------------------------------------

export interface RecoveryCodeStatus {
  /** Codes in the current set; 0 before any were made. */
  readonly total: number;
  readonly remaining: number;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
  /** A code is left and a second factor is held, so a code can be used now. */
  readonly usable: boolean;
}

export async function getRecoveryCodeStatus(db: XosClient): Promise<Result<RecoveryCodeStatus>> {
  const { data, error } = await db.rpc("my_recovery_code_status");
  if (error) return fail(toDataError(error));
  const row = data[0];
  return ok({
    total: row?.total ?? 0,
    remaining: row?.remaining ?? 0,
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    usable: row?.usable === true,
  });
}

/** Makes a new set of ten codes, replacing the old one, and returns them: the only time they can be read. */
export async function generateRecoveryCodes(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db.rpc("generate_recovery_codes");
  if (error) return fail(toDataError(error));
  return ok(data.map((row) => row.code));
}

/** A recovery code as typed: letters and digits with the optional hyphen, at most 13 characters before checking. */
export function looksLikeRecoveryCode(input: string): boolean {
  return /^[0-9a-z]{5}-?[0-9a-z]{5}$/i.test(input.replace(/\s/g, ""));
}

/**
 * Spends one of the caller's recovery codes on the caller's own session, then refreshes the session so its new token
 * carries aal2 (ADR 0055). The database spends the code and raises the session in one transaction; the refresh only
 * fetches the token Supabase Auth now issues. Returns the codes left.
 */
export async function redeemRecoveryCode(
  db: XosClient,
  code: string,
): Promise<Result<{ remaining: number }>> {
  const { data, error } = await db.rpc("redeem_recovery_code", { p_code: code });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (row?.outcome !== "ok") {
    const rule = row?.outcome ?? "code_invalid";
    return fail({ kind: "refusal", rule, message: rule });
  }
  const refreshed = await db.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) {
    return fail({
      kind: "unexpected",
      message: refreshed.error?.message ?? "The session did not refresh.",
    });
  }
  return ok({ remaining: row.remaining ?? 0 });
}

/** Deletes the caller's codes once they hold no second factor (after removing the last one). */
export async function pruneRecoveryCodes(db: XosClient): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("prune_recovery_codes");
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

// Sessions and devices ---------------------------------------------------------------------------------------------------

export type SessionSurface = "Atlas" | "Gateway" | "Compass" | "API";

export interface SignedInSession {
  readonly id: string;
  readonly current: boolean;
  readonly signedInAt: string;
  readonly lastActiveAt: string;
  readonly secondFactor: boolean;
  readonly surface: SessionSurface | null;
  readonly clientAddress: string | null;
  readonly place: string | null;
  readonly userAgent: string | null;
}

/** The caller's own sessions, this one first, then by last activity. */
export async function listMySessions(db: XosClient): Promise<Result<SignedInSession[]>> {
  const { data, error } = await db.rpc("my_sessions");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.session_id,
      current: row.is_current === true,
      signedInAt: row.signed_in_at,
      lastActiveAt: row.last_active_at,
      secondFactor: row.second_factor === true,
      surface: (row.surface as SessionSurface | null) ?? null,
      clientAddress: row.client_address ?? null,
      place: row.place ?? null,
      userAgent: row.user_agent ?? null,
    })),
  );
}

/**
 * Records the device behind the caller's session: the surface, the client address as `clientAddress()` reads it
 * behind the trusted proxies (never the first X-Forwarded-For entry), the approximate place the host derived from it,
 * and the user agent. The database writes at most once a minute.
 */
export async function touchMySession(
  db: XosClient,
  input: {
    readonly surface: SessionSurface;
    readonly clientAddress: string | null;
    readonly place: string | null;
    readonly userAgent: string | null;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("touch_my_session", {
    p_surface: input.surface,
    p_client_address: input.clientAddress ?? "",
    p_place: input.place ?? "",
    p_user_agent: input.userAgent ?? "",
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function signOutSession(db: XosClient, sessionId: string): Promise<Result<null>> {
  const { error } = await db.rpc("sign_out_my_session", { p_session_id: sessionId });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function signOutOtherSessions(db: XosClient): Promise<Result<number>> {
  const { data, error } = await db.rpc("sign_out_my_other_sessions");
  if (error) return fail(toDataError(error));
  return ok(data ?? 0);
}

// The trail ----------------------------------------------------------------------------------------------------------------

export type SecurityEventKind =
  | "recovery_codes_generated"
  | "recovery_code_used"
  | "recovery_code_refused"
  | "recovery_codes_cleared"
  | "session_signed_out"
  | "other_sessions_signed_out";

export interface SecurityEvent {
  readonly kind: SecurityEventKind;
  readonly occurredAt: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly thisSession: boolean;
}

export async function listSecurityEvents(
  db: XosClient,
  limit = 20,
): Promise<Result<SecurityEvent[]>> {
  const { data, error } = await db.rpc("my_security_events", { p_limit: limit });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      kind: row.kind as SecurityEventKind,
      occurredAt: row.occurred_at,
      detail:
        typeof row.detail === "object" && row.detail !== null && !Array.isArray(row.detail)
          ? (row.detail as Record<string, unknown>)
          : {},
      thisSession: row.this_session === true,
    })),
  );
}

// Device names ------------------------------------------------------------------------------------------------------------

export interface DeviceName {
  /** Browser or app, as a catalog key: chrome, edge, firefox, safari, opera, compass, or other. */
  readonly browser: "chrome" | "edge" | "firefox" | "safari" | "opera" | "compass" | "other";
  /** Operating system, as a catalog key: macos, windows, ios, android, linux, chromeos, or other. */
  readonly os: "macos" | "windows" | "ios" | "android" | "linux" | "chromeos" | "other";
}

/** A device's browser and system from its user agent, for "Chrome on macOS". Unknown agents read as other. */
export function deviceName(userAgent: string | null): DeviceName {
  const ua = userAgent ?? "";
  const browser: DeviceName["browser"] = /Compass\//i.test(ua)
    ? "compass"
    : /Edg(e|A|iOS)?\//.test(ua)
      ? "edge"
      : /OPR\/|Opera/.test(ua)
        ? "opera"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "chrome"
            : /Safari\//.test(ua)
              ? "safari"
              : "other";
  const os: DeviceName["os"] = /iPhone|iPad|iPod|iOS/.test(ua)
    ? "ios"
    : /Android/.test(ua)
      ? "android"
      : /CrOS/.test(ua)
        ? "chromeos"
        : /Windows/.test(ua)
          ? "windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macos"
            : /Linux/.test(ua)
              ? "linux"
              : "other";
  return { browser, os };
}

/** The refusal rules the security screens name in copy; anything else is unexpected. */
export const ACCOUNT_SECURITY_RULES = new Set([
  "code_invalid",
  "rate_limited",
  "no_codes",
  "recovery_codes_need_factor",
  "step_up_required",
  "session_current",
]);

export function accountSecurityError(error: DataError): string {
  if (error.kind === "refusal") {
    return ACCOUNT_SECURITY_RULES.has(error.rule) ? error.rule : "unexpected";
  }
  if (error.kind === "not-found") return "denied";
  return "unexpected";
}
