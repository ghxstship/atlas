"use server";

import { signOutOtherSessions } from "@xos/data/account-security";
import { tokenAal } from "@xos/data/auth-assurance";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/auth/actions";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { newPassword, passwordHasContextWords } from "@/lib/auth/password";
import {
  newPasswordError,
  recoveryIsFresh,
  resetRequestOutcome,
  RESET_PASSWORD_PATH,
} from "@/lib/auth/recovery";
import { siteUrl } from "@/lib/auth/redirect";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Forgot password (lib/auth/recovery.ts). Both actions validate with Zod and answer with catalog keys under
 * `shell.auth.errors`, like the other auth actions; the proxy's CSRF check covers them.
 */

const email = z.email().max(320);

/**
 * Emails a reset link. The answer is the same for an address with an account and one without: `ok`, and the page
 * says a link is on its way if an account uses the address. Only a malformed address and the request rate limit,
 * which do not depend on any account, read differently. The link returns to this site's /auth/callback: the address
 * is built from ATLAS_SITE_URL, never from the request, and the callback sends a reset to /auth/reset-password.
 */
export async function requestPasswordReset(_: FormState, form: FormData): Promise<FormState> {
  const typed = form.get("email");
  const values = { email: typeof typed === "string" ? typed.trim() : "" };
  const parsed = email.safeParse(values.email);
  if (!parsed.success) return { fieldErrors: { email: "email" }, values };
  const db = await createServerSupabase();
  const { error } = await db.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", RESET_PASSWORD_PATH),
  });
  if (resetRequestOutcome(error) === "rate_limited") {
    return { error: "over_request_rate_limit", values };
  }
  // Told to operators, never to the person asking: the code only, no address.
  if (error) {
    observability.logger.warn("password reset email was not sent", {
      code: error.code ?? "",
      status: error.status ?? 0,
    });
  }
  return { ok: true, values };
}

/**
 * Sets the new password on a session that came from a reset link, then ends every other session of the account.
 * A person who holds a second factor passes it first; an `insufficient_aal` refusal from Supabase Auth leads there too.
 */
export async function setNewPassword(_: FormState, form: FormData): Promise<FormState> {
  const db = await createServerSupabase();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return { error: "reset_link_invalid" };
  const { data: current } = await db.auth.getSession();
  const token = current.session?.access_token;
  const holdsFactor = (auth.user.factors ?? []).some((f) => f.status === "verified");
  if (holdsFactor && tokenAal(token) === "aal1") {
    redirect(secondFactorRedirect(RESET_PASSWORD_PATH, "") as Route);
  }
  if (!recoveryIsFresh(token, Date.now())) return { error: "reset_link_invalid" };

  const password = form.get("password");
  const parsed = newPassword.safeParse(password);
  if (!parsed.success) return { fieldErrors: { password: "password" } };
  const fullName: unknown = auth.user.user_metadata["full_name"];
  const details = {
    ...(auth.user.email ? { email: auth.user.email } : {}),
    ...(typeof fullName === "string" ? { fullName } : {}),
  };
  if (passwordHasContextWords(parsed.data, details)) {
    return { fieldErrors: { password: "passwordContext" } };
  }
  if (form.get("confirm") !== parsed.data) return { fieldErrors: { confirm: "passwordConfirm" } };

  const { error } = await db.auth.updateUser({ password: parsed.data });
  if (error) {
    const key = newPasswordError(error);
    if (key === "second_factor") redirect(secondFactorRedirect(RESET_PASSWORD_PATH, "") as Route);
    if (key === "unexpected") {
      observability.logger.error("new password was not saved", {
        code: error.code ?? "",
        status: error.status ?? 0,
      });
    }
    return key === "weak_password" || key === "same_password"
      ? { fieldErrors: { password: key } }
      : { error: key };
  }
  // Every other session of the account ends (app.sign_out_my_other_sessions, migration 1561), so a person who had
  // the old password is out everywhere. The password is already changed, so a failure here is logged, not shown.
  const ended = await signOutOtherSessions(db);
  if (!ended.ok) {
    observability.logger.error("other sessions were not ended after a password reset", {
      error: ended.error,
    });
  }
  redirect(`${RESET_PASSWORD_PATH}?done=1` as Route);
}
