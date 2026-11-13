"use server";

import {
  acceptInvite,
  createOrganization,
  getCurrentPerson,
  isOrgSlug,
  listMyOrganizations,
} from "@xos/data";
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
import { acceptInviteLink } from "@xos/data/profiles";
import { untyped } from "@xos/data/untyped";
import { recordLegalAcceptances, setSetting } from "@xos/data/settings";
import { isCountryCode } from "@xos/i18n/formats";
import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { authErrorKey } from "@/lib/auth/errors";
import { newPassword, passwordHasContextWords } from "@/lib/auth/password";
import { clientIp, signupAcceptances } from "@/lib/auth/legal";
import { enabledProviders, isOAuthProvider, providerQueryParams } from "@/lib/auth/providers";
import { notOfferedValues } from "@/lib/auth/territory";
import { safeNext, signInErrorPath, siteUrl } from "@/lib/auth/redirect";
import { ssoLanding } from "@/lib/auth/sso-landing";
import { signupTimeZone } from "@/lib/auth/time-zone";
import { env } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Auth server actions. Every action validates its input with Zod, returns a typed form state with
 * catalog keys (never raw messages) and keeps what the person typed so a failed submit loses
 * nothing. Next.js checks the Origin of every server action against the host, and proxy.ts adds
 * the explicit CSRF check (Section 9).
 */

export interface FormState {
  /** A `shell.auth.errors.*` key for a form-level error. */
  readonly error?: string;
  /** Values for a form-level error's sentence. */
  readonly errorValues?: Readonly<Record<string, string>>;
  /** Field name to `shell.auth.errors.*` key. */
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

/** The person answered 18 or older (Section 14.3, 14.9, migration 6840). */
function ageTicked(form: FormData): boolean {
  return form.get("ageConfirmed") === AGE_OLD_ENOUGH;
}

/**
 * An answer of under 18 on a sign-up form ends here: no account is created, nothing typed is kept and
 * the refusal is counted with nothing that identifies the person. Answers only when it was not that.
 */
async function stopSignUpIfUnderAge(form: FormData): Promise<void> {
  if (form.get("ageConfirmed") !== AGE_UNDER) return;
  await recordAgeRefusal(await createServerSupabase(), "Atlas");
  redirect("/auth/age-refused");
}

/**
 * An answer of under 18 from someone already signed in, whose account a provider, single sign-on or an earlier rule made.
 * It closes the account, so one radio button never does that alone: /auth/age says what closing means and asks them to
 * confirm (closeUnderAgeAccount), and lets them go back to `back`.
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
  const refused = await refuseMinimumAge(untyped(db), "Atlas");
  if (!refused.ok) return { error: "unexpected" };
  const held = refused.data.outcome === "Account Held";
  await db.auth.signOut({ scope: held ? "global" : "local" });
  redirect(`/auth/age-refused?outcome=${held ? "held" : "closed"}`);
}

/**
 * An account that has not confirmed its age yet (a first Google sign-in) confirms it before it
 * creates or joins an org. Answers a field error when the question was needed and not answered.
 */
async function requireAge(
  db: Awaited<ReturnType<typeof createServerSupabase>>,
  form: FormData,
): Promise<Record<string, string> | null> {
  const confirmed = await minimumAgeConfirmed(db);
  if (confirmed.ok && confirmed.data) return null;
  if (!ageTicked(form)) return { ageConfirmed: "age" };
  const recorded = await confirmMinimumAge(db, "Atlas", clientIp(await headers()));
  if (!recorded.ok)
    throw new Error(`Age confirmation was not recorded: ${JSON.stringify(recorded.error)}`);
  return null;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    out[field] ??= field;
  }
  return out;
}

// Sign in -----------------------------------------------------------------------------------------

export async function signInWithPassword(_: FormState, form: FormData): Promise<FormState> {
  const values = { email: text(form, "email") };
  const parsed = z.object({ email, password: z.string().min(1) }).safeParse({
    email: values.email,
    password: form.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signInWithPassword(parsed.data);
  if (error) return { error: authErrorKey(error), values };
  const next = safeNext(form.get("next"));
  // A person who holds a second factor verifies it before any page (A77). The proxy would ask too, but this
  // response renders its target without passing the proxy, so the address bar would keep the target.
  const holdsFactor = (data.user.factors ?? []).some((f) => f.status === "verified");
  if (holdsFactor) redirect(secondFactorRedirect(next, "") as Route);
  // Likewise anyone who has not answered at 18: an earlier 16, a provider's account or one made by an org (ADR 0156). The
  // pages that create or join an org ask themselves.
  const path = next.split("?")[0] ?? "";
  const asksItself = path === "/auth/organization" || path.startsWith("/auth/invite/");
  redirect(
    (!asksItself && (await owesAgeAnswer(db))
      ? `/auth/age?next=${encodeURIComponent(next)}`
      : next) as Route,
  );
}

/**
 * Sign in with the one Email field (A59-025): its form has two submit buttons, "Email me a sign-in
 * link" (method=link) and "Sign in with password" (method=password).
 */
export async function signInWithEmail(state: FormState, form: FormData): Promise<FormState> {
  return form.get("method") === "password"
    ? signInWithPassword(state, form)
    : sendMagicLink(state, form);
}

/**
 * Create an account with the one Email field (A59-025): "Email me a sign-up link" (method=link)
 * or "Create account" with a password (method=password). Both keep the full name.
 */
export async function signUpWithEmail(state: FormState, form: FormData): Promise<FormState> {
  await stopSignUpIfUnderAge(form);
  if (form.get("method") === "password") return signUp(state, form);
  const fullName = text(form, "fullName");
  if (fullName === "" || fullName.length > 200) {
    return {
      fieldErrors: { fullName: "fullName", ...(ageTicked(form) ? {} : { ageConfirmed: "age" }) },
      values: { fullName, email: text(form, "email"), ageConfirmed: text(form, "ageConfirmed") },
    };
  }
  return sendMagicLink(state, form);
}

export async function sendMagicLink(_: FormState, form: FormData): Promise<FormState> {
  const fullName = text(form, "fullName");
  const signUp = form.get("intent") === "sign-up";
  if (signUp) await stopSignUpIfUnderAge(form);
  const values = {
    email: text(form, "email"),
    ageConfirmed: text(form, "ageConfirmed"),
    ...(fullName ? { fullName } : {}),
  };
  const parsed = email.safeParse(values.email);
  const errors: Record<string, string> = {};
  if (!parsed.success) errors["email"] = "email";
  if (signUp && !ageTicked(form)) errors["ageConfirmed"] = "age";
  if (!parsed.success || Object.keys(errors).length > 0) return { fieldErrors: errors, values };
  const next = safeNext(form.get("next"));
  const db = await createServerSupabase();
  const { error } = await db.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: signUp,
      emailRedirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", next),
      // Applied only when Supabase creates the account: private.handle_new_auth_user (0206) copies
      // full_name into app.people, and the answer of 18 or older is recorded (migration 6840).
      ...(signUp
        ? { data: { ...(fullName ? { full_name: fullName } : {}), ...ageMetadata("Atlas") } }
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
 * carries `next` (an invitation or an org page, kept on this site by safeNext) and the provider.
 * Signing up and signing in are the same step: a new Google account is created on first use.
 */
export async function signInWithProvider(form: FormData): Promise<void> {
  const next = safeNext(form.get("next"));
  const provider = form.get("provider");
  const refused = signInErrorPath("provider_disabled", next) as Route;
  if (!isOAuthProvider(provider) || !(await enabledProviders()).includes(provider)) {
    redirect(refused);
  }
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", next, { provider }),
      queryParams: providerQueryParams(provider),
    },
  });
  if (error || !data.url) redirect(refused);
  redirect(data.url as Route);
}

/** Re-authentication from the session expiry dialog: signs in without leaving the page. */
export async function reauthenticate(_: FormState, form: FormData): Promise<FormState> {
  const values = { email: text(form, "email") };
  const parsed = z.object({ email, password: z.string().min(1) }).safeParse({
    email: values.email,
    password: form.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  const db = await createServerSupabase();
  const { error } = await db.auth.signInWithPassword(parsed.data);
  if (error) return { error: authErrorKey(error), values };
  return { ok: true };
}

// Sign up -----------------------------------------------------------------------------------------

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  await stopSignUpIfUnderAge(form);
  const values = {
    fullName: text(form, "fullName"),
    email: text(form, "email"),
    ageConfirmed: text(form, "ageConfirmed"),
  };
  const parsed = z
    .object({ fullName: z.string().min(1).max(200), email, password: newPassword })
    .safeParse({ ...values, password: form.get("password") });
  const age = ageTicked(form) ? {} : { ageConfirmed: "age" };
  if (!parsed.success) return { fieldErrors: { ...fieldErrors(parsed.error), ...age }, values };
  if (passwordHasContextWords(parsed.data.password, parsed.data)) {
    return { fieldErrors: { password: "passwordContext", ...age }, values };
  }
  if (!ageTicked(form)) return { fieldErrors: age, values };
  const next = safeNext(form.get("next"), "/auth/organization");
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // private.handle_new_auth_user (0206) copies full_name into app.people; the ticked "16 or
      // older" box is recorded by private.record_signup_age_confirmation (1381).
      data: { full_name: parsed.data.fullName, ...ageMetadata("Atlas") },
      emailRedirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", next),
    },
  });
  if (error) return { error: authErrorKey(error), values };
  if (!data.session) redirect(`/auth/check-email?email=${encodeURIComponent(parsed.data.email)}`);
  redirect(next as Route);
}

// Organization ------------------------------------------------------------------------------------

export async function createOrganizationAction(_: FormState, form: FormData): Promise<FormState> {
  await stopAccountIfUnderAge(form, "/auth/organization");
  const values = {
    orgName: text(form, "orgName"),
    orgSlug: text(form, "orgSlug").toLowerCase(),
    orgCountry: text(form, "orgCountry"),
    ageConfirmed: text(form, "ageConfirmed"),
  };
  const parsed = z
    .object({
      orgName: z.string().min(1).max(200),
      orgSlug: z.string().refine(isOrgSlug),
      orgCountry: z.string().refine(isCountryCode),
      accept: z.literal("on"),
    })
    .safeParse({ ...values, accept: form.get("accept") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const db = await createServerSupabase();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) redirect("/auth/sign-in?next=%2Fauth%2Forganization");
  const ageError = await requireAge(db, form);
  if (ageError) return { fieldErrors: ageError, values };
  const created = await createOrganization(db, {
    name: parsed.data.orgName,
    slug: parsed.data.orgSlug,
    countryCode: parsed.data.orgCountry,
  });
  if (!created.ok) {
    const error = created.error;
    // Nothing was created. The person reads why, and what still works for them (ADR 0160).
    if (error.kind === "refusal" && error.rule === "territory_not_offered") {
      return {
        error: "territory_not_offered",
        errorValues: await notOfferedValues(parsed.data.orgCountry),
        values,
      };
    }
    if (
      error.kind === "refusal" &&
      (error.rule === "slug_taken" || error.rule === "slug_reserved")
    ) {
      return { fieldErrors: { orgSlug: error.rule }, values };
    }
    if (error.kind === "conflict") return { fieldErrors: { orgSlug: "slug_taken" }, values };
    return { error: "unexpected", values };
  }

  const recorded = await recordLegalAcceptances(db, {
    orgId: created.data.orgId,
    documents: signupAcceptances(),
    clientIp: clientIp(await headers()),
  });
  if (!recorded.ok) {
    throw new Error(`Legal acceptance was not recorded: ${JSON.stringify(recorded.error)}`);
  }
  // The org's calendar starts in the creator's zone, not UTC (crawl 4.9). Best effort: the org exists either way, and
  // the Owner can set the zone in Settings, Localization.
  const zone = signupTimeZone(form.get("orgTimeZone"));
  if (zone !== null) {
    await setSetting(db, {
      orgId: created.data.orgId,
      key: "locale.time_zone",
      scopeKind: "Organization",
      scopeId: created.data.orgId,
      value: zone,
    });
  }
  redirect(`/${parsed.data.orgSlug}/home`);
}

// Invitations -------------------------------------------------------------------------------------

/** Invitation link refusals shown as they are; every other link refusal reads as an invalid link. */
const PASSED_LINK_REFUSALS = new Set([
  "invite_rate_limited",
  "seat_limit_reached",
  "seat_limit_upgrade",
  // The org's blocklist (B16, 6050): a generic sentence that does not say why.
  "member_blocked",
]);

/**
 * The age question on its own (/auth/age), for anyone who has not answered at 18. They answer once, and go on to where
 * they were going. A single sign-on joins its org here when the question stopped it in the callback.
 */
export async function answerAgeQuestion(_: FormState, form: FormData): Promise<FormState> {
  const next = safeNext(form.get("next"));
  await stopAccountIfUnderAge(form, next);
  const db = await createServerSupabase();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  const ageError = await requireAge(db, form);
  if (ageError) return { fieldErrors: ageError };
  const landing = await ssoLanding(db, auth.user.app_metadata["provider"], next);
  redirect((landing ?? signInErrorPath("member_blocked", next)) as Route);
}

export async function acceptInvitation(_: FormState, form: FormData): Promise<FormState> {
  const token = text(form, "token");
  await stopAccountIfUnderAge(form, `/auth/invite/${encodeURIComponent(token)}`);
  const db = await createServerSupabase();
  const ageError = await requireAge(db, form);
  if (ageError) return { fieldErrors: ageError };
  // Invitation links (xlnk_, migration 0861) are not tied to an email address; their refusals map to
  // the invitation messages. A full org says so either way (seat refusals, ADR 0035).
  const accepted = token.startsWith("xlnk_")
    ? await acceptInviteLink(db, token).then((r) =>
        r.ok || r.error.kind !== "refusal" || PASSED_LINK_REFUSALS.has(r.error.rule)
          ? r
          : { ok: false as const, error: { ...r.error, rule: "invite_invalid" } },
      )
    : await acceptInvite(db, token);
  if (!accepted.ok) {
    const error = accepted.error;
    return { error: error.kind === "refusal" ? `invite.${error.rule}` : "unexpected" };
  }
  const { data: auth } = await db.auth.getUser();
  const person = auth.user ? await getCurrentPerson(db, auth.user.id) : null;
  const orgs = person?.ok ? await listMyOrganizations(db, person.data.id) : null;
  const org = orgs?.ok
    ? orgs.data.find((o) => o.membershipId === accepted.data.membershipId)
    : undefined;
  redirect(org ? `/${org.slug}/home` : "/");
}
