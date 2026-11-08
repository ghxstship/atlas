"use server";

import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  AGE_OLD_ENOUGH,
  AGE_UNDER,
  ageMetadata,
  confirmMinimumAge,
  minimumAgeConfirmed,
  owesAgeAnswer,
  recordAgeRefusal,
} from "@xos/data/consent";
import { refuseMinimumAge } from "@xos/data/account-deletion";
import { recordLegalAcceptances } from "@xos/data/settings";
import { untyped } from "@xos/data/untyped";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { authErrorKey } from "@/lib/auth/errors";
import {
  clientIp,
  PENDING_ACCEPTANCES,
  recordPendingAcceptances,
  signUpAcceptances,
  skipsTermsStep,
} from "@/lib/auth/legal";
import { newPassword, passwordHasContextWords } from "@/lib/auth/password";
import {
  enabledProviders,
  isOAuthProvider,
  offersProviders,
  providerQueryParams,
} from "@/lib/auth/providers";
import { safeNext, signInErrorPath, siteUrl } from "@/lib/auth/redirect";
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
  if (holdsFactor) redirect(secondFactorRedirect(next, "") as Route);
  // Likewise anyone who has not answered at 18: an earlier 16, or a provider's account (ADR 0156). The terms page asks itself.
  const asksItself = next.split("?")[0] === "/auth/terms" || skipsTermsStep(next);
  redirect(
    (!asksItself && (await owesAgeAnswer(db))
      ? `/auth/age?next=${encodeURIComponent(next)}`
      : next) as Route,
  );
}

/** The terms box was ticked; account creation needs it (Section 14.4, finding A59-025). */
function acceptedTerms(form: FormData): boolean {
  return form.get("acceptTerms") === "yes";
}

/** The person answered 18 or older; account creation needs it (Section 14.3, 14.9, migration 6840). */
function ageTicked(form: FormData): boolean {
  return form.get("ageConfirmed") === AGE_OLD_ENOUGH;
}

/**
 * An answer of under 18 on a sign-up form ends here: no account is created, nothing typed is kept and
 * the refusal is counted with nothing that identifies the person. Answers only when it was not that.
 */
async function stopSignUpIfUnderAge(form: FormData): Promise<void> {
  if (form.get("ageConfirmed") !== AGE_UNDER) return;
  await recordAgeRefusal(await createServerSupabase(), "Gateway");
  redirect("/auth/age-refused");
}

/**
 * An answer of under 18 from someone already signed in, whose account a provider or an earlier rule made. It closes the
 * account, so one radio button never does that alone: /auth/age says what closing means and asks them to confirm
 * (closeUnderAgeAccount), and lets them go back to `back`.
 */
async function stopAccountIfUnderAge(form: FormData, back: string): Promise<void> {
  if (form.get("ageConfirmed") !== AGE_UNDER) return;
  redirect(`/auth/age?under=1&next=${encodeURIComponent(back)}` as Route);
}

/**
 * The person confirmed they are under 18: the account closes (app.refuse_minimum_age) and the session goes with it. An
 * account that cannot close yet stays, so every session it has ends, and it is asked again at its next sign-in.
 */
export async function closeUnderAgeAccount(): Promise<FormState> {
  const db = await createServerSupabase();
  const refused = await refuseMinimumAge(untyped(db), "Gateway");
  // A sign-in that holds a second factor passes it before this can close the account (Section 9); nothing was removed.
  if (!refused.ok && refused.error.kind === "refusal" && refused.error.rule === "age_second_factor")
    redirect(secondFactorRedirect("/auth/age", "?under=1") as Route);
  if (!refused.ok) return { error: "unexpected" };
  const held = refused.data.outcome === "Account Held";
  await db.auth.signOut({ scope: held ? "global" : "local" });
  redirect(`/auth/age-refused?outcome=${held ? "held" : "closed"}`);
}

export async function sendMagicLink(_: FormState, form: FormData): Promise<FormState> {
  const signUp = form.get("intent") === "sign-up";
  if (signUp) await stopSignUpIfUnderAge(form);
  const values = {
    email: text(form, "email"),
    ...(signUp
      ? {
          fullName: text(form, "fullName"),
          acceptTerms: text(form, "acceptTerms"),
          ageConfirmed: text(form, "ageConfirmed"),
        }
      : {}),
  };
  const parsed = email.safeParse(values.email);
  const errors: Record<string, string> = {};
  if (signUp && !values.fullName) errors["fullName"] = "fullName";
  if (!parsed.success) errors["email"] = "email";
  if (signUp && !acceptedTerms(form)) errors["acceptTerms"] = "terms";
  if (signUp && !ageTicked(form)) errors["ageConfirmed"] = "age";
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
              ...ageMetadata("Gateway"),
            },
          }
        : {}),
    },
  });
  if (error) return { error: authErrorKey(error), values };
  redirect(`/auth/check-email?email=${encodeURIComponent(parsed.data)}`);
}

/**
 * Starts an OAuth sign-in (Sign in with Google, ADR 0036). The server client from @supabase/ssr
 * uses the PKCE flow: signInWithOAuth stores the code verifier in an httpOnly cookie and returns
 * Supabase Auth's /authorize URL with the code challenge. The return leg is /auth/callback, which
 * carries `next` (kept on this site by safeNext) and the provider. Providers are offered on the
 * platform hosts only: the return leg is GATEWAY_SITE_URL, where a custom domain's verifier cookie
 * does not reach. Signing up and signing in are the same step.
 */
export async function signInWithProvider(form: FormData): Promise<void> {
  const next = safeNext(form.get("next"), HOME);
  const provider = form.get("provider");
  const refused = signInErrorPath("provider_disabled", next, HOME) as Route;
  if (
    !isOAuthProvider(provider) ||
    !(await offersProviders()) ||
    !(await enabledProviders()).includes(provider)
  ) {
    redirect(refused);
  }
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: siteUrl(env().GATEWAY_SITE_URL, "/auth/callback", next, { provider }),
      queryParams: providerQueryParams(provider),
    },
  });
  if (error || !data.url) redirect(refused);
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
  await stopSignUpIfUnderAge(form);
  const values = {
    fullName: text(form, "fullName"),
    email: text(form, "email"),
    acceptTerms: text(form, "acceptTerms"),
    ageConfirmed: text(form, "ageConfirmed"),
  };
  const parsed = z
    .object({ fullName: z.string().min(1).max(200), email, password: newPassword })
    .safeParse({ ...values, password: form.get("password") });
  const terms = {
    ...(acceptedTerms(form) ? {} : { acceptTerms: "terms" }),
    ...(ageTicked(form) ? {} : { ageConfirmed: "age" }),
  };
  if (!parsed.success) return { fieldErrors: { ...fieldErrors(parsed.error), ...terms }, values };
  if (passwordHasContextWords(parsed.data.password, parsed.data)) {
    return { fieldErrors: { password: "passwordContext", ...terms }, values };
  }
  if (Object.keys(terms).length > 0) return { fieldErrors: terms, values };
  const next = safeNext(form.get("next"), HOME);
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // private.handle_new_auth_user (0206) copies full_name into app.people; the accepted terms
      // wait in the metadata until a session can write them to the acceptance log.
      data: {
        full_name: parsed.data.fullName,
        [PENDING_ACCEPTANCES]: signUpAcceptances(),
        ...ageMetadata("Gateway"),
      },
      emailRedirectTo: siteUrl(env().GATEWAY_SITE_URL, "/auth/callback", next),
    },
  });
  if (error) return { error: authErrorKey(error), values };
  if (!data.session) redirect(`/auth/check-email?email=${encodeURIComponent(parsed.data.email)}`);
  await recordPendingAcceptances(db, clientIp(await headers()));
  redirect(next as Route);
}

/**
 * Accepts the Worker Terms for an account a provider created (Sign in with Google, ADR 0036, and
 * finding A59-025). The account exists already, so the acceptance goes straight to the log.
 */
export async function acceptSignUpTerms(_: FormState, form: FormData): Promise<FormState> {
  const next = safeNext(form.get("next"), HOME);
  await stopAccountIfUnderAge(form, `/auth/terms?next=${encodeURIComponent(next)}`);
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  const age = await minimumAgeConfirmed(db);
  const needsAge = !(age.ok && age.data);
  const errors = {
    ...(acceptedTerms(form) ? {} : { acceptTerms: "terms" }),
    ...(needsAge && !ageTicked(form) ? { ageConfirmed: "age" } : {}),
  };
  if (Object.keys(errors).length > 0) return { fieldErrors: errors };
  if (needsAge) {
    const confirmed = await confirmMinimumAge(db, "Gateway", clientIp(await headers()));
    if (!confirmed.ok) return { error: "unexpected", values: { acceptTerms: "yes" } };
  }
  const recorded = await recordLegalAcceptances(db, {
    orgId: null,
    documents: signUpAcceptances(),
    clientIp: clientIp(await headers()),
  });
  if (!recorded.ok) return { error: "unexpected", values: { acceptTerms: "yes" } };
  redirect(next as Route);
}

/**
 * The age question on its own (/auth/age), for anyone who has not answered at 18. They answer once,
 * and go on to where they were going.
 */
export async function answerAgeQuestion(_: FormState, form: FormData): Promise<FormState> {
  const next = safeNext(form.get("next"), HOME);
  await stopAccountIfUnderAge(form, next);
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  if (!ageTicked(form)) return { fieldErrors: { ageConfirmed: "age" } };
  const confirmed = await confirmMinimumAge(db, "Gateway", clientIp(await headers()));
  if (!confirmed.ok) return { error: "unexpected" };
  redirect(next as Route);
}
