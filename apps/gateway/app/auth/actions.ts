"use server";

import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { authErrorKey } from "@/lib/auth/errors";
import {
  clientIp,
  PENDING_ACCEPTANCES,
  recordPendingAcceptances,
  signUpAcceptances,
} from "@/lib/auth/legal";
import { newPassword, passwordHasContextWords } from "@/lib/auth/password";
import { isOAuthProvider } from "@/lib/auth/providers";
import { safeNext, siteUrl } from "@/lib/auth/redirect";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Gateway auth server actions. The account is the same one Atlas and Compass use (Section 4.4.1):
 * one person, one sign-in. Every action validates its input with Zod, returns a typed form state
 * with catalog keys and keeps what the person typed, so a failed submit loses nothing. Next.js
 * checks the Origin of every server action, and proxy.ts adds the explicit CSRF check.
 */

export interface FormState {
  /** A `gateway.auth.errors.*` key for a form-level error. */
  readonly error?: string;
  /** Field name to `gateway.auth.errors.*` key. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Submitted values, echoed back so inputs keep them after a failed submit. */
  readonly values?: Readonly<Record<string, string>>;
  /** Set when the action finished in place (the session dialog closes on it). */
  readonly ok?: boolean;
}

const email = z.email().max(320);

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    out[field] ??= field;
  }
  return out;
}

const HOME = "/home";

export async function signInWithPassword(_: FormState, form: FormData): Promise<FormState> {
  const values = { email: text(form, "email") };
  const parsed = z
    .object({ email, password: z.string().min(1) })
    .safeParse({ email: values.email, password: form.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signInWithPassword(parsed.data);
  if (error) return { error: authErrorKey(error), values };
  const next = safeNext(form.get("next"), HOME);
  // A person who holds a second factor verifies it before any page (A77). The proxy would ask too, but this
  // response renders its target without passing the proxy, so the address bar would keep the target.
  const holdsFactor = (data.user.factors ?? []).some((f) => f.status === "verified");
  redirect((holdsFactor ? secondFactorRedirect(next, "") : next) as Route);
}

/** The terms box was ticked; account creation needs it (Section 14.4, finding A59-025). */
function acceptedTerms(form: FormData): boolean {
  return form.get("acceptTerms") === "yes";
}

export async function sendMagicLink(_: FormState, form: FormData): Promise<FormState> {
  const signUp = form.get("intent") === "sign-up";
  const values = {
    email: text(form, "email"),
    ...(signUp ? { fullName: text(form, "fullName"), acceptTerms: text(form, "acceptTerms") } : {}),
  };
  const parsed = email.safeParse(values.email);
  const errors: Record<string, string> = {};
  if (signUp && !values.fullName) errors["fullName"] = "fullName";
  if (!parsed.success) errors["email"] = "email";
  if (signUp && !acceptedTerms(form)) errors["acceptTerms"] = "terms";
  if (!parsed.success || Object.keys(errors).length > 0) return { fieldErrors: errors, values };
  const next = safeNext(form.get("next"), HOME);
  const db = await createServerSupabase();
  const { error } = await db.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: signUp,
      emailRedirectTo: siteUrl(env().GATEWAY_SITE_URL, "/auth/callback", next),
      // A new account's name and accepted terms; Supabase applies them only when it creates one.
      ...(signUp
        ? {
            data: {
              ...(values.fullName ? { full_name: values.fullName } : {}),
              [PENDING_ACCEPTANCES]: signUpAcceptances(),
            },
          }
        : {}),
    },
  });
  if (error) return { error: authErrorKey(error), values };
  redirect(`/auth/check-email?email=${encodeURIComponent(parsed.data)}`);
}

export async function signInWithProvider(form: FormData): Promise<void> {
  const provider = form.get("provider");
  if (!isOAuthProvider(provider)) redirect("/auth/sign-in?error=provider_disabled");
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: siteUrl(
        env().GATEWAY_SITE_URL,
        "/auth/callback",
        safeNext(form.get("next"), HOME),
      ),
    },
  });
  if (error || !data.url) redirect("/auth/sign-in?error=provider_disabled");
  redirect(data.url as Route);
}

/** Re-authentication from the session expiry dialog: signs in without leaving the page. */
export async function reauthenticate(_: FormState, form: FormData): Promise<FormState> {
  const values = { email: text(form, "email") };
  const parsed = z
    .object({ email, password: z.string().min(1) })
    .safeParse({ email: values.email, password: form.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  const db = await createServerSupabase();
  const { error } = await db.auth.signInWithPassword(parsed.data);
  if (error) return { error: authErrorKey(error), values };
  return { ok: true };
}

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  const values = {
    fullName: text(form, "fullName"),
    email: text(form, "email"),
    acceptTerms: text(form, "acceptTerms"),
  };
  const parsed = z
    .object({ fullName: z.string().min(1).max(200), email, password: newPassword })
    .safeParse({ ...values, password: form.get("password") });
  const terms = acceptedTerms(form) ? {} : { acceptTerms: "terms" };
  if (!parsed.success) return { fieldErrors: { ...fieldErrors(parsed.error), ...terms }, values };
  if (passwordHasContextWords(parsed.data.password, parsed.data)) {
    return { fieldErrors: { password: "passwordContext", ...terms }, values };
  }
  if (!acceptedTerms(form)) return { fieldErrors: terms, values };
  const next = safeNext(form.get("next"), HOME);
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // private.handle_new_auth_user (0206) copies full_name into app.people; the accepted terms
      // wait in the metadata until a session can write them to the acceptance log.
      data: { full_name: parsed.data.fullName, [PENDING_ACCEPTANCES]: signUpAcceptances() },
      emailRedirectTo: siteUrl(env().GATEWAY_SITE_URL, "/auth/callback", next),
    },
  });
  if (error) return { error: authErrorKey(error), values };
  if (!data.session) redirect(`/auth/check-email?email=${encodeURIComponent(parsed.data.email)}`);
  await recordPendingAcceptances(db, clientIp(await headers()));
  redirect(next as Route);
}
