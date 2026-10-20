import { isAuthError, type AuthError } from "@supabase/supabase-js";
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DataError, type Result } from "./result.ts";
import {
  binaryToJson,
  type CreationOptionsJSON,
  type CredentialJSON,
  type RequestOptionsJSON,
} from "./webauthn-json.ts";

/**
 * Authentication assurance (A77, RRR-122; Section 9): second factors, passkeys, step-up and what an org's security
 * settings ask of a session. Second factors and passkeys live in Supabase Auth; these functions call it with the
 * caller's session, so a factor is always the caller's own, and read the org policy through the RPCs of migration
 * 1330. Failures come back as refusals with a rule the shells name in copy:
 *
 * - `code_invalid`: the code or security key did not match;   - `code_expired`: the challenge timed out;
 * - `step_up_required`: Supabase Auth wants a second factor first (insufficient_aal);
 * - `factor_limit`, `factor_name_taken`: enrollment limits;   - `passkey_failed`: a passkey ceremony failed;
 * - `sso_unavailable`: no single sign-on provider for the domain;   - `rate_limited`;   - `unexpected` otherwise.
 */

/** The refusal for a Supabase Auth error. */
export function authFailure(error: AuthError | Error): DataError {
  const code = isAuthError(error) ? error.code : undefined;
  const refusal = (rule: string): DataError => ({ kind: "refusal", rule, message: error.message });
  switch (code) {
    case "mfa_verification_failed":
    case "mfa_verification_rejected":
    case "invalid_credentials":
      return refusal("code_invalid");
    case "mfa_challenge_expired":
    case "webauthn_challenge_expired":
    case "mfa_factor_not_found":
      return refusal("code_expired");
    case "insufficient_aal":
    case "reauthentication_needed":
      return refusal("step_up_required");
    case "too_many_enrolled_mfa_factors":
      return refusal("factor_limit");
    case "mfa_factor_name_conflict":
      return refusal("factor_name_taken");
    case "sso_provider_not_found":
    case "saml_provider_disabled":
    case "saml_idp_not_found":
      return refusal("sso_unavailable");
    case "over_request_rate_limit":
      return refusal("rate_limited");
    default:
      // Passkey and WebAuthn verification failures carry no code of their own.
      if (/webauthn|passkey|credential/i.test(error.message)) return refusal("passkey_failed");
      return { kind: "unexpected", message: error.message, ...(code ? { code } : {}) };
  }
}

// Assurance ------------------------------------------------------------------------------------------------------------

export type AssuranceLevel = "aal1" | "aal2";

export interface Assurance {
  /** What the session has: aal2 once a second factor passed in it. */
  readonly current: AssuranceLevel;
  /** What the person can reach: aal2 when they hold a verified second factor. */
  readonly next: AssuranceLevel;
}

const level = (value: string | null | undefined): AssuranceLevel =>
  value === "aal2" ? "aal2" : "aal1";

/** The session's assurance, from its JWT and the person's verified factors (no network call when cached). */
export async function getAssurance(db: XosClient): Promise<Result<Assurance>> {
  const { data, error } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return fail(authFailure(error));
  return ok({ current: level(data.currentLevel), next: level(data.nextLevel) });
}

/** Whether a signed-in person holds a second factor this session has not passed: they verify before going on. */
export function needsSecondFactor(assurance: Assurance): boolean {
  return assurance.current === "aal1" && assurance.next === "aal2";
}

/** The `aal` claim of an access token, read without verifying it (the caller verified the session already). */
export function tokenAal(accessToken: string | null | undefined): AssuranceLevel {
  const payload = accessToken?.split(".")[1];
  if (!payload) return "aal1";
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as { aal?: unknown };
    return level(typeof claims.aal === "string" ? claims.aal : null);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.name === "InvalidCharacterError")
    ) {
      return "aal1";
    }
    throw error;
  }
}

export interface SecondFactorStatus {
  /** Step-up as the database asks for it (Restricted exports, break-glass): the session passed a second factor. */
  readonly steppedUp: boolean;
  readonly secondFactorAt: string | null;
  /** The second factor passed in the last 15 minutes: enough to change one's own sign-in methods. */
  readonly recent: boolean;
  readonly recentUntil: string | null;
}

/** The session's second-factor standing (migration 1330). */
export async function getSecondFactorStatus(db: XosClient): Promise<Result<SecondFactorStatus>> {
  const { data, error } = await db.rpc("my_second_factor_status");
  if (error) return fail(toDataError(error));
  const row = data[0];
  return ok({
    steppedUp: row?.session_aal === "aal2",
    secondFactorAt: row?.second_factor_at ?? null,
    recent: row?.recent === true,
    recentUntil: row?.recent_until ?? null,
  });
}

// What an org asks of the session --------------------------------------------------------------------------------------

export interface OrgAuthStatus {
  readonly mfaRequired: boolean;
  readonly mfaVerified: boolean;
  readonly signedInAt: string | null;
  readonly sessionHours: number | null;
  readonly sessionExpiresAt: string | null;
  readonly sessionExpired: boolean;
  readonly idleTimeoutMinutes: number | null;
}

/** What the org's security settings ask of the caller's session, or null when the caller is not a member. */
export async function getOrgAuthStatus(
  db: XosClient,
  orgId: string,
): Promise<Result<OrgAuthStatus | null>> {
  const { data, error } = await db.rpc("my_org_auth_status", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return ok(null);
  return ok({
    mfaRequired: row.mfa_required === true,
    mfaVerified: row.mfa_verified === true,
    signedInAt: row.signed_in_at ?? null,
    sessionHours: row.session_hours ?? null,
    sessionExpiresAt: row.session_expires_at ?? null,
    sessionExpired: row.session_expired === true,
    idleTimeoutMinutes: row.idle_timeout_minutes ?? null,
  });
}

/** Why a member may not enter an org with this session, or `ok`. */
export type OrgAuthDecision = "ok" | "mfa" | "session-expired" | "idle";

/**
 * The guard's decision for an org (Section 9): a session past the org's lifetime or idle longer than its timeout
 * signs in again; a session the policy asks a second factor of verifies one first. `lastSeenAt` is the device's
 * last request; activity before the sign-in does not count against it.
 */
export function orgAuthDecision(
  status: OrgAuthStatus,
  input: { readonly lastSeenAt: number | null; readonly now: number },
): OrgAuthDecision {
  if (status.sessionExpired) return "session-expired";
  if (status.idleTimeoutMinutes !== null && input.lastSeenAt !== null) {
    const signedIn = status.signedInAt === null ? 0 : Date.parse(status.signedInAt);
    const active = Math.max(input.lastSeenAt, signedIn);
    if (input.now - active > status.idleTimeoutMinutes * 60_000) return "idle";
  }
  if (status.mfaRequired && !status.mfaVerified) return "mfa";
  return "ok";
}

// Second factors -------------------------------------------------------------------------------------------------------

export type SecondFactorType = "totp" | "webauthn" | "phone";

export interface SecondFactor {
  readonly id: string;
  readonly type: SecondFactorType;
  /** The name the person gave it: renamed (migration 1331) or as enrolled. */
  readonly label: string;
  readonly verified: boolean;
  readonly createdAt: string;
}

/** The caller's second factors, verified first, with the names they gave them. */
export async function listSecondFactors(db: XosClient): Promise<Result<SecondFactor[]>> {
  const [factors, labels] = await Promise.all([
    db.auth.mfa.listFactors(),
    db.rpc("my_auth_factor_labels"),
  ]);
  if (factors.error) return fail(authFailure(factors.error));
  if (labels.error) return fail(toDataError(labels.error));
  const names = new Map(labels.data.map((l) => [l.factor_id, l.label]));
  return ok(
    factors.data.all
      .map((f) => ({
        id: f.id,
        type: f.factor_type as SecondFactorType,
        label: names.get(f.id) ?? f.friendly_name ?? "",
        verified: f.status === "verified",
        createdAt: f.created_at,
      }))
      .sort(
        (a, b) => Number(b.verified) - Number(a.verified) || a.createdAt.localeCompare(b.createdAt),
      ),
  );
}

/** Removes the caller's unfinished enrollments of a type, so a new one can start under the same name. */
async function clearPending(db: XosClient, type: SecondFactorType): Promise<Result<null>> {
  const factors = await db.auth.mfa.listFactors();
  if (factors.error) return fail(authFailure(factors.error));
  for (const factor of factors.data.all) {
    if (factor.factor_type !== type || factor.status === "verified") continue;
    const { error } = await db.auth.mfa.unenroll({ factorId: factor.id });
    if (error) return fail(authFailure(error));
  }
  return ok(null);
}

export interface TotpEnrollment {
  readonly factorId: string;
  /** The otpauth URI as an SVG QR code data URI, rendered by Supabase Auth. */
  readonly qrCode: string;
  /** The shared secret, for typing into an authenticator app that cannot scan. */
  readonly secret: string;
}

/** Starts enrolling an authenticator app; the factor counts once a code from it is verified. */
export async function startTotpEnrollment(
  db: XosClient,
  label: string,
): Promise<Result<TotpEnrollment>> {
  const cleared = await clearPending(db, "totp");
  if (!cleared.ok) return cleared;
  const { data, error } = await db.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: label.trim(),
  });
  if (error) return fail(authFailure(error));
  return ok({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
}

/**
 * Verifies a code from an authenticator app: finishes an enrollment, answers the sign-in challenge or steps the
 * session up. The session becomes aal2 with a fresh second factor.
 */
export async function verifyTotp(
  db: XosClient,
  factorId: string,
  code: string,
): Promise<Result<null>> {
  const { error } = await db.auth.mfa.challengeAndVerify({
    factorId,
    code: code.replace(/\s/g, ""),
  });
  if (error) return fail(authFailure(error));
  return ok(null);
}

/** The relying party for security keys as a second factor, from the shell's configuration. */
export interface RelyingParty {
  readonly id: string;
  readonly origins: readonly string[];
}

export type SecurityKeyCeremony =
  | { readonly kind: "create"; readonly options: CreationOptionsJSON }
  | { readonly kind: "request"; readonly options: RequestOptionsJSON };

export interface SecurityKeyChallenge {
  readonly factorId: string;
  readonly challengeId: string;
  readonly ceremony: SecurityKeyCeremony;
}

async function challengeSecurityKey(
  db: XosClient,
  factorId: string,
  rp: RelyingParty,
): Promise<Result<SecurityKeyChallenge>> {
  const { data, error } = await db.auth.mfa.challenge({
    factorId,
    webauthn: { rpId: rp.id, rpOrigins: [...rp.origins] },
  });
  if (error) return fail(authFailure(error));
  if (data.type !== "webauthn") {
    return fail({ kind: "unexpected", message: "The factor is not a security key." });
  }
  const webauthn = data.webauthn;
  const options = binaryToJson(webauthn.credential_options.publicKey);
  return ok({
    factorId,
    challengeId: data.id,
    ceremony:
      webauthn.type === "create"
        ? { kind: "create", options: options as CreationOptionsJSON }
        : { kind: "request", options: options as RequestOptionsJSON },
  });
}

/** Starts enrolling a security key or passkey as a second factor; the browser then creates the credential. */
export async function startSecurityKeyEnrollment(
  db: XosClient,
  label: string,
  rp: RelyingParty,
): Promise<Result<SecurityKeyChallenge>> {
  const cleared = await clearPending(db, "webauthn");
  if (!cleared.ok) return cleared;
  const { data, error } = await db.auth.mfa.enroll({
    factorType: "webauthn",
    friendlyName: label.trim(),
  });
  if (error) return fail(authFailure(error));
  return challengeSecurityKey(db, data.id, rp);
}

/** Challenges a verified security key, for the sign-in challenge or step-up. */
export function startSecurityKeyChallenge(
  db: XosClient,
  factorId: string,
  rp: RelyingParty,
): Promise<Result<SecurityKeyChallenge>> {
  return challengeSecurityKey(db, factorId, rp);
}

/** Verifies the credential the browser returned for a security-key challenge. */
export async function verifySecurityKey(
  db: XosClient,
  input: {
    readonly factorId: string;
    readonly challengeId: string;
    readonly kind: "create" | "request";
    readonly credential: CredentialJSON;
    readonly rp: RelyingParty;
  },
): Promise<Result<null>> {
  // supabase-js serializes a browser credential through its toJSON, so the JSON the browser sent passes as is.
  const credential = { toJSON: () => input.credential } as never;
  const { error } = await db.auth.mfa.verify({
    factorId: input.factorId,
    challengeId: input.challengeId,
    webauthn: {
      type: input.kind,
      rpId: input.rp.id,
      rpOrigins: [...input.rp.origins],
      credential_response: credential,
    },
  });
  if (error) return fail(authFailure(error));
  return ok(null);
}

/** Removes one of the caller's second factors. Supabase Auth asks for aal2 to remove a verified one. */
export async function removeSecondFactor(db: XosClient, factorId: string): Promise<Result<null>> {
  const { error } = await db.auth.mfa.unenroll({ factorId });
  if (error) return fail(authFailure(error));
  return ok(null);
}

/** Renames one of the caller's second factors (migration 1331). */
export async function renameSecondFactor(
  db: XosClient,
  factorId: string,
  label: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_auth_factor_label", {
    p_factor_id: factorId,
    p_label: label,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Passkeys -------------------------------------------------------------------------------------------------------------

export interface Passkey {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export async function listPasskeys(db: XosClient): Promise<Result<Passkey[]>> {
  const { data, error } = await db.auth.passkey.list();
  if (error) return fail(authFailure(error));
  return ok(
    data.map((p) => ({
      id: p.id,
      label: p.friendly_name ?? "",
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at ?? null,
    })),
  );
}

export interface PasskeyChallenge<O> {
  readonly challengeId: string;
  readonly options: O;
}

/** Starts registering a passkey for the signed-in person; the browser then creates the credential. */
export async function startPasskeyRegistration(
  db: XosClient,
): Promise<Result<PasskeyChallenge<CreationOptionsJSON>>> {
  const { data, error } = await db.auth.passkey.startRegistration();
  if (error) return fail(authFailure(error));
  return ok({
    challengeId: data.challenge_id,
    options: binaryToJson(data.options) as CreationOptionsJSON,
  });
}

export async function finishPasskeyRegistration(
  db: XosClient,
  challengeId: string,
  credential: CredentialJSON,
  label: string | null,
): Promise<Result<Passkey>> {
  const { data, error } = await db.auth.passkey.verifyRegistration({
    challengeId,
    credential: credential as never,
  });
  if (error) return fail(authFailure(error));
  const name = label?.trim();
  if (name) {
    const renamed = await renamePasskey(db, data.id, name);
    if (!renamed.ok) return renamed;
  }
  return ok({
    id: data.id,
    label: name || (data.friendly_name ?? ""),
    createdAt: data.created_at,
    lastUsedAt: null,
  });
}

export async function renamePasskey(
  db: XosClient,
  passkeyId: string,
  label: string,
): Promise<Result<null>> {
  const { error } = await db.auth.passkey.update({ passkeyId, friendlyName: label.trim() });
  if (error) return fail(authFailure(error));
  return ok(null);
}

export async function removePasskey(db: XosClient, passkeyId: string): Promise<Result<null>> {
  const { error } = await db.auth.passkey.delete({ passkeyId });
  if (error) return fail(authFailure(error));
  return ok(null);
}

/** Starts a passkey sign-in; the browser then signs the challenge with a passkey it holds for this site. */
export async function startPasskeySignIn(
  db: XosClient,
): Promise<Result<PasskeyChallenge<RequestOptionsJSON>>> {
  const { data, error } = await db.auth.passkey.startAuthentication();
  if (error) return fail(authFailure(error));
  return ok({
    challengeId: data.challenge_id,
    options: binaryToJson(data.options) as RequestOptionsJSON,
  });
}

/** Finishes a passkey sign-in: the session is written to the caller's cookies. */
export async function finishPasskeySignIn(
  db: XosClient,
  challengeId: string,
  credential: CredentialJSON,
): Promise<Result<null>> {
  const { data, error } = await db.auth.passkey.verifyAuthentication({
    challengeId,
    credential: credential as never,
  });
  if (error) return fail(authFailure(error));
  if (!data.session)
    return fail({ kind: "refusal", rule: "passkey_failed", message: "No session." });
  return ok(null);
}

// Enterprise single sign-on --------------------------------------------------------------------------------------------

/**
 * Starts SAML single sign-on for the domain of an email address (Supabase Auth SSO, Enterprise plan). Returns the
 * identity provider's URL to send the browser to; `sso_unavailable` when no provider serves the domain.
 */
export async function startSsoSignIn(
  db: XosClient,
  input: { readonly email: string; readonly redirectTo: string },
): Promise<Result<string>> {
  const domain = input.email.trim().toLowerCase().split("@")[1] ?? "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return fail({ kind: "refusal", rule: "sso_unavailable", message: "No domain." });
  }
  const { data, error } = await db.auth.signInWithSSO({
    domain,
    options: { redirectTo: input.redirectTo },
  });
  if (error) return fail(authFailure(error));
  return ok(data.url);
}
