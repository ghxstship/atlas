"use server";

import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Second factor (A59-019, Section 8.4 step-up): verify an enrolled authenticator app, or enrol one,
 * through Supabase Auth MFA with the request's session cookies. A successful verification raises the
 * session to aal2 and writes the new session cookies, so the action that asked for step-up (emergency
 * access, a Restricted export) succeeds when retried. The secret and QR code of a new factor are shown
 * once, to the person enrolling, and never stored by Atlas.
 */

export interface SecondFactorStatus {
  /** Verified authenticator apps the person can verify with. */
  readonly factors: readonly { readonly id: string; readonly name: string | null }[];
  /** True when the session already passed a second factor. */
  readonly verified: boolean;
}

export type SecondFactorResult =
  { readonly ok: true } | { readonly ok: false; readonly error: "code" | "expired" | "unexpected" };

export interface Enrollment {
  readonly factorId: string;
  /** SVG data URL of the QR code to scan. */
  readonly qrCode: string;
  /** The same secret as text, for apps that cannot scan. */
  readonly secret: string;
}

export async function secondFactorStatus(): Promise<SecondFactorStatus> {
  const db = await createServerSupabase();
  const [factors, level] = await Promise.all([
    db.auth.mfa.listFactors(),
    db.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  const totp = factors.data?.totp ?? [];
  return {
    factors: totp
      .filter((f) => f.status === "verified")
      .map((f) => ({ id: f.id, name: f.friendly_name ?? null })),
    verified: level.data?.currentLevel === "aal2",
  };
}

const code = z.string().regex(/^\d{6}$/);
const factorId = z.uuid();

/** Verifies a six-digit code from an enrolled (or just enrolled) authenticator app. */
export async function verifySecondFactor(input: {
  factorId: string;
  code: string;
}): Promise<SecondFactorResult> {
  const parsed = z
    .object({ factorId, code })
    .safeParse({ factorId: input.factorId, code: input.code.replace(/\s/g, "") });
  if (!parsed.success) return { ok: false, error: "code" };
  const db = await createServerSupabase();
  const { error } = await db.auth.mfa.challengeAndVerify(parsed.data);
  if (!error) return { ok: true };
  if (error.code === "mfa_verification_failed" || error.code === "mfa_challenge_expired") {
    return { ok: false, error: error.code === "mfa_challenge_expired" ? "expired" : "code" };
  }
  return { ok: false, error: /code|invalid/i.test(error.message) ? "code" : "unexpected" };
}

/** Starts enrolling an authenticator app; the person confirms it with verifySecondFactor. */
export async function enrollAuthenticator(): Promise<Enrollment | null> {
  const db = await createServerSupabase();
  // A previous enrolment the person never confirmed would block a new one with the same name.
  const existing = await db.auth.mfa.listFactors();
  for (const f of existing.data?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified") {
      await db.auth.mfa.unenroll({ factorId: f.id });
    }
  }
  const { data, error } = await db.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
  });
  if (error || !data) return null;
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}
