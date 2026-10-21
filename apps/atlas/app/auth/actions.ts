"use server";

import {
  acceptInvite,
  createOrganization,
  getCurrentPerson,
  isOrgSlug,
  listMyOrganizations,
} from "@xos/data";
import { ageMetadata, confirmMinimumAge, minimumAgeConfirmed } from "@xos/data/consent";
import { acceptInviteLink } from "@xos/data/profiles";
import { recordLegalAcceptances } from "@xos/data/settings";
import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { secondFactorRedirect } from "@/lib/auth/assurance";
import { authErrorKey } from "@/lib/auth/errors";
import { newPassword, passwordHasContextWords } from "@/lib/auth/password";
import { clientIp, signupAcceptances } from "@/lib/auth/legal";
import { enabledProviders, isOAuthProvider, providerQueryParams } from "@/lib/auth/providers";
import { safeNext, signInErrorPath, siteUrl } from "@/lib/auth/redirect";
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

/** The "16 or older" box was ticked (Section 14.3, 14.9). */
function ageTicked(form: FormData): boolean {
  return form.get("ageConfirmed") === "16";
}

/**
 * An account that has not confirmed its age yet (a first Google sign-in) confirms it before it
 * creates or joins an org. Answers a field error when the box was needed and not ticked.
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
  redirect((holdsFactor ? secondFactorRedirect(next, "") : next) as Route);
}

export async function sendMagicLink(_: FormState, form: FormData): Promise<FormState> {
  const signUp = form.get("intent") === "sign-up";
  const values = { email: text(form, "email"), ageConfirmed: text(form, "ageConfirmed") };
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
      // Applied only when Supabase creates the account: the ticked "16 or older" box (migration 1381).
      ...(signUp ? { data: ageMetadata("Atlas") } : {}),
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
  const values = {
    orgName: text(form, "orgName"),
    orgSlug: text(form, "orgSlug").toLowerCase(),
    ageConfirmed: text(form, "ageConfirmed"),
  };
  const parsed = z
    .object({
      orgName: z.string().min(1).max(200),
      orgSlug: z.string().refine(isOrgSlug),
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
  });
  if (!created.ok) {
    const error = created.error;
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
  redirect(`/${parsed.data.orgSlug}/home`);
}

// Invitations -------------------------------------------------------------------------------------

/** Invitation link refusals shown as they are; every other link refusal reads as an invalid link. */
const PASSED_LINK_REFUSALS = new Set([
  "invite_rate_limited",
  "seat_limit_reached",
  "seat_limit_upgrade",
]);

export async function acceptInvitation(_: FormState, form: FormData): Promise<FormState> {
  const token = text(form, "token");
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
