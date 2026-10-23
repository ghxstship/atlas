"use server";

import { listSecondFactors, startTotpEnrollment, verifyTotp } from "@xos/data/auth-assurance";
import { getOperator } from "@xos/data/console";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env, passwordSignIn } from "@/lib/env";
import { secondFactorErrorKey, signInErrorKey, type SignInErrorKey } from "@/lib/auth/errors";
import { safeNext, siteUrl } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Console sign-in (A90, ADR 0046). The account is the platform team member's own XOS account; the console keeps
 * its own session cookie on its own host. A sign-in that is not a live operator is signed out at once and told so.
 * Every operator then passes a second factor (A77) before any page: an authenticator app code, set up here when
 * the account has none.
 */

const HOME = "/tenants";

export interface SignInState {
  readonly error?: SignInErrorKey;
  readonly email?: string;
}

export async function signInWithPasswordAction(
  _: SignInState,
  form: FormData,
): Promise<SignInState> {
  const email = typeof form.get("email") === "string" ? String(form.get("email")).trim() : "";
  const parsed = z
    .object({ email: z.email().max(320), password: z.string().min(1).max(1000) })
    .safeParse({ email, password: form.get("password") });
  if (!passwordSignIn(env())) return { error: "provider_disabled", email };
  if (!parsed.success) return { error: "invalid_credentials", email };
  const db = await createServerSupabase();
  const { error } = await db.auth.signInWithPassword(parsed.data);
  if (error) return { error: signInErrorKey(error), email };
  const operator = await getOperator(db);
  if (!operator.ok || !operator.data) {
    await db.auth.signOut({ scope: "local" });
    return { error: "not_operator", email };
  }
  const next = safeNext(form.get("next"), HOME);
  redirect(`/auth/second-factor?next=${encodeURIComponent(next)}` as Route);
}

/** Starts Sign in with Google (ADR 0036) with PKCE; the return leg is /auth/callback. */
export async function signInWithGoogleAction(form: FormData): Promise<void> {
  const next = safeNext(form.get("next"), HOME);
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: siteUrl(env().CONSOLE_SITE_URL, "/auth/callback", next),
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data.url) redirect("/auth/sign-in?error=provider_error" as Route);
  redirect(data.url as Route);
}

// Second factor ------------------------------------------------------------------------------------------------------

export interface EnrollState {
  readonly factorId?: string;
  readonly qrCode?: string;
  readonly secret?: string;
  readonly error?: string;
}

/** Starts enrolling an authenticator app for an operator who holds no second factor yet. */
export async function startEnrollmentAction(_: EnrollState, form: FormData): Promise<EnrollState> {
  const label = typeof form.get("label") === "string" ? String(form.get("label")).trim() : "";
  if (label.length < 1 || label.length > 60) return { error: "unexpected" };
  const db = await createServerSupabase();
  const operator = await getOperator(db);
  if (!operator.ok || !operator.data) redirect("/auth/refused" as Route);
  const factors = await listSecondFactors(db);
  if (factors.ok && factors.data.some((f) => f.verified)) return { error: "unexpected" };
  const result = await startTotpEnrollment(db, label);
  if (!result.ok) return { error: secondFactorErrorKey(result.error) };
  return { factorId: result.data.factorId, qrCode: result.data.qrCode, secret: result.data.secret };
}

export interface VerifyState {
  readonly error?: string;
}

/** Verifies an authenticator code: finishes an enrollment or steps the session up to aal2. */
export async function verifySecondFactorAction(
  _: VerifyState,
  form: FormData,
): Promise<VerifyState> {
  const factorId = typeof form.get("factorId") === "string" ? String(form.get("factorId")) : "";
  const code =
    typeof form.get("code") === "string" ? String(form.get("code")).replace(/\s/g, "") : "";
  if (!z.uuid().safeParse(factorId).success || !/^\d{6}$/.test(code)) {
    return { error: "code_invalid" };
  }
  const db = await createServerSupabase();
  const operator = await getOperator(db);
  if (!operator.ok || !operator.data) redirect("/auth/refused" as Route);
  const result = await verifyTotp(db, factorId, code);
  if (!result.ok) return { error: secondFactorErrorKey(result.error) };
  redirect(safeNext(form.get("next"), HOME) as Route);
}
