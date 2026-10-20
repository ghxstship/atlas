"use server";

import type { DataError, XosClient } from "@xos/data";
import {
  finishPasskeyRegistration,
  finishPasskeySignIn,
  getSecondFactorStatus,
  listSecondFactors,
  removePasskey,
  removeSecondFactor,
  renamePasskey,
  renameSecondFactor,
  startPasskeyRegistration,
  startPasskeySignIn,
  startSecurityKeyChallenge,
  startSecurityKeyEnrollment,
  startTotpEnrollment,
  verifySecurityKey,
  verifyTotp,
  type SecondFactorType,
  type SecurityKeyChallenge,
} from "@xos/data/auth-assurance";
import type {
  CreationOptionsJSON,
  CredentialJSON,
  RequestOptionsJSON,
} from "@xos/data/webauthn-json";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { relyingPartyFrom } from "@/lib/auth/assurance";
import { safeNext } from "@/lib/auth/redirect";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Second factors, passkeys and step-up in Gateway (Section 9, A77): the same sign-in Atlas and Compass use, so a
 * factor enrolled here is asked for in all three. Every action runs with the caller's session, so Supabase Auth
 * only ever touches the caller's own factors and passkeys. Errors come back as
 * `authSecurity.errors.*` keys. Removing a second factor, and adding or removing a passkey once the person holds
 * a second factor, need step-up: a second factor passed in the last 15 minutes (migration 1330).
 */

export interface SecurityState {
  readonly ok?: boolean;
  readonly error?: string;
  /** Increments on every completed submit, so forms react to repeated outcomes. */
  readonly at?: number;
}

export type ActionResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

/** Refusal rules with copy under authSecurity.errors; anything else reads as unexpected. */
const KNOWN = new Set([
  "code_invalid",
  "code_expired",
  "step_up_required",
  "factor_limit",
  "factor_name_taken",
  "factor_label_length",
  "passkey_failed",
  "sso_unavailable",
  "rate_limited",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "invalid") return "invalid";
  if (error.kind === "unexpected") console.error("security action failed", error);
  return "unexpected";
}

const done = (): SecurityState => ({ ok: true, at: Date.now() });
const refused = (error: string): SecurityState => ({ error, at: Date.now() });

/** The caller's client, or the sign-in page when the session is gone. */
async function session(next = "/"): Promise<XosClient> {
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  return db;
}

function revalidateSecurity() {
  revalidatePath("/settings/security");
}

/** Null when the caller may change sensitive security settings now, else the refusal to show. */
async function stepUpGate(db: XosClient, always: boolean): Promise<string | null> {
  if (!always) {
    const factors = await listSecondFactors(db);
    if (!factors.ok) return errorKey(factors.error);
    if (!factors.data.some((f) => f.verified)) return null;
  }
  const status = await getSecondFactorStatus(db);
  if (!status.ok) return errorKey(status.error);
  return status.data.recent ? null : "step_up_required";
}

const id = z.uuid();
const code = z
  .string()
  .transform((s) => s.replace(/\s/g, ""))
  .pipe(z.string().regex(/^\d{6}$/));
const label = z.string().trim().min(1).max(80);

// Challenge: at sign-in, for step-up and to finish an enrollment ------------------------------------------------

/** Verifies an authenticator app code. At sign-in it continues to `next`; otherwise it reports success. */
export async function verifyCodeAction(_: SecurityState, form: FormData): Promise<SecurityState> {
  const factorId = id.safeParse(form.get("factorId"));
  const parsed = code.safeParse(form.get("code"));
  if (!factorId.success) return refused("unexpected");
  if (!parsed.success) return refused("code_invalid");
  const next = safeNext(form.get("next"), "/home");
  const db = await session(next);
  const result = await verifyTotp(db, factorId.data, parsed.data);
  if (!result.ok) return refused(errorKey(result.error));
  if (form.get("mode") === "sign-in") redirect(next as Route);
  revalidateSecurity();
  return done();
}

export interface StepUpOptions {
  readonly factors: readonly { id: string; type: SecondFactorType; label: string }[];
  /** Whether security keys work here (the relying party is configured). */
  readonly securityKeys: boolean;
}

/** Whether the session is stepped up now, so a link can ask for step-up before it navigates. */
export async function stepUpStatusAction(): Promise<ActionResult<{ steppedUp: boolean }>> {
  const db = await session();
  const status = await getSecondFactorStatus(db);
  if (!status.ok) return { ok: false, error: errorKey(status.error) };
  return { ok: true, data: { steppedUp: status.data.steppedUp } };
}

/** The caller's verified second factors, for the sign-in challenge and the step-up dialog. */
export async function stepUpOptionsAction(): Promise<ActionResult<StepUpOptions>> {
  const db = await session();
  const factors = await listSecondFactors(db);
  if (!factors.ok) return { ok: false, error: errorKey(factors.error) };
  return {
    ok: true,
    data: {
      factors: factors.data
        .filter((f) => f.verified)
        .map((f) => ({ id: f.id, type: f.type, label: f.label })),
      securityKeys: relyingPartyFrom(env()) !== null,
    },
  };
}

/** Starts a security-key challenge for a verified factor (sign-in or step-up). */
export async function securityKeyChallengeAction(
  factorId: string,
): Promise<ActionResult<SecurityKeyChallenge>> {
  const rp = relyingPartyFrom(env());
  const parsed = id.safeParse(factorId);
  if (!rp || !parsed.success) return { ok: false, error: "unsupported" };
  const db = await session();
  const result = await startSecurityKeyChallenge(db, parsed.data, rp);
  return result.ok ? result : { ok: false, error: errorKey(result.error) };
}

/** Verifies the credential the browser returned for a security-key challenge or enrollment. */
export async function securityKeyVerifyAction(input: {
  readonly factorId: string;
  readonly challengeId: string;
  readonly kind: "create" | "request";
  readonly credential: CredentialJSON;
}): Promise<ActionResult<null>> {
  const rp = relyingPartyFrom(env());
  if (!rp || !id.safeParse(input.factorId).success || !id.safeParse(input.challengeId).success) {
    return { ok: false, error: "unsupported" };
  }
  const db = await session();
  const result = await verifySecurityKey(db, { ...input, rp });
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidateSecurity();
  return { ok: true, data: null };
}

// Enrollment -----------------------------------------------------------------------------------------------------

export interface TotpSetup {
  readonly factorId: string;
  readonly qrCode: string;
  readonly secret: string;
}

/** Starts enrolling an authenticator app: the QR code (re-encoded as a safe data URI) and the setup key. */
export async function startTotpAction(name: string): Promise<ActionResult<TotpSetup>> {
  const parsed = label.safeParse(name);
  if (!parsed.success) return { ok: false, error: "factor_label_length" };
  const db = await session();
  const result = await startTotpEnrollment(db, parsed.data);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  const svg = result.data.qrCode.replace(/^data:image\/svg\+xml;[^,]*,/, "");
  return {
    ok: true,
    data: {
      factorId: result.data.factorId,
      qrCode: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      secret: result.data.secret,
    },
  };
}

/** Abandons an enrollment the person did not finish. A verified factor is never removed here. */
export async function cancelEnrollmentAction(factorId: string): Promise<void> {
  if (!id.safeParse(factorId).success) return;
  const db = await session();
  const factors = await listSecondFactors(db);
  if (!factors.ok) return;
  if (factors.data.some((f) => f.id === factorId && !f.verified)) {
    await removeSecondFactor(db, factorId);
  }
}

/** Starts enrolling a security key or passkey as a second factor; the browser creates the credential. */
export async function startSecurityKeyEnrollmentAction(
  name: string,
): Promise<ActionResult<SecurityKeyChallenge>> {
  const rp = relyingPartyFrom(env());
  if (!rp) return { ok: false, error: "unsupported" };
  const parsed = label.safeParse(name);
  if (!parsed.success) return { ok: false, error: "factor_label_length" };
  const db = await session();
  const result = await startSecurityKeyEnrollment(db, parsed.data, rp);
  return result.ok ? result : { ok: false, error: errorKey(result.error) };
}

// Managing second factors -----------------------------------------------------------------------------------------

export async function renameFactorAction(_: SecurityState, form: FormData): Promise<SecurityState> {
  const factorId = id.safeParse(form.get("factorId"));
  const parsed = label.safeParse(form.get("label"));
  if (!factorId.success) return refused("unexpected");
  if (!parsed.success) return refused("factor_label_length");
  const db = await session();
  const result = await renameSecondFactor(db, factorId.data, parsed.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidateSecurity();
  return done();
}

/** Removes a second factor after step-up. */
export async function removeFactorAction(_: SecurityState, form: FormData): Promise<SecurityState> {
  const factorId = id.safeParse(form.get("factorId"));
  if (!factorId.success) return refused("unexpected");
  const db = await session();
  const gate = await stepUpGate(db, true);
  if (gate) return refused(gate);
  const result = await removeSecondFactor(db, factorId.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidateSecurity();
  return done();
}

// Passkeys -----------------------------------------------------------------------------------------------------------

export async function startPasskeyRegistrationAction(): Promise<
  ActionResult<{ challengeId: string; options: CreationOptionsJSON }>
> {
  const db = await session();
  const gate = await stepUpGate(db, false);
  if (gate) return { ok: false, error: gate };
  const result = await startPasskeyRegistration(db);
  return result.ok ? result : { ok: false, error: errorKey(result.error) };
}

export async function finishPasskeyRegistrationAction(input: {
  readonly challengeId: string;
  readonly credential: CredentialJSON;
  readonly label: string;
}): Promise<ActionResult<null>> {
  const name = label.safeParse(input.label);
  const db = await session();
  const result = await finishPasskeyRegistration(
    db,
    input.challengeId,
    input.credential,
    name.success ? name.data : null,
  );
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidateSecurity();
  return { ok: true, data: null };
}

export async function renamePasskeyAction(
  _: SecurityState,
  form: FormData,
): Promise<SecurityState> {
  const passkeyId = id.safeParse(form.get("passkeyId"));
  const parsed = label.safeParse(form.get("label"));
  if (!passkeyId.success) return refused("unexpected");
  if (!parsed.success) return refused("factor_label_length");
  const db = await session();
  const result = await renamePasskey(db, passkeyId.data, parsed.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidateSecurity();
  return done();
}

export async function removePasskeyAction(
  _: SecurityState,
  form: FormData,
): Promise<SecurityState> {
  const passkeyId = id.safeParse(form.get("passkeyId"));
  if (!passkeyId.success) return refused("unexpected");
  const db = await session();
  const gate = await stepUpGate(db, false);
  if (gate) return refused(gate);
  const result = await removePasskey(db, passkeyId.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidateSecurity();
  return done();
}

// Signing in with a passkey or single sign-on ---------------------------------------------------------------------

export async function startPasskeySignInAction(): Promise<
  ActionResult<{ challengeId: string; options: RequestOptionsJSON }>
> {
  const db = await createServerSupabase();
  const result = await startPasskeySignIn(db);
  return result.ok ? result : { ok: false, error: errorKey(result.error) };
}

/** Finishes a passkey sign-in and continues to `next` (the proxy then asks for a second factor if one is owed). */
export async function finishPasskeySignInAction(input: {
  readonly challengeId: string;
  readonly credential: CredentialJSON;
  readonly next: string;
}): Promise<ActionResult<null>> {
  const db = await createServerSupabase();
  const result = await finishPasskeySignIn(db, input.challengeId, input.credential);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  redirect(safeNext(input.next, "/home") as Route);
}
