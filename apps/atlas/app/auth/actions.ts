"use server";

import {
  acceptInvite,
  createOrganization,
  getCurrentPerson,
  isOrgSlug,
  listMyOrganizations,
} from "@xos/data";
import { acceptInviteLink } from "@xos/data/profiles";
import { recordLegalAcceptances } from "@xos/data/settings";
import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
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
  const { error } = await db.auth.signInWithPassword(parsed.data);
  if (error) return { error: authErrorKey(error), values };
  redirect(safeNext(form.get("next")) as Route);
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
  if (form.get("method") === "password") return signUp(state, form);
  const fullName = text(form, "fullName");
  if (fullName === "" || fullName.length > 200) {
    return {
      fieldErrors: { fullName: "fullName" },
      values: { fullName, email: text(form, "email") },
    };
  }
  return sendMagicLink(state, form);
}

export async function sendMagicLink(_: FormState, form: FormData): Promise<FormState> {
  const fullName = text(form, "fullName");
  const values = { email: text(form, "email"), ...(fullName ? { fullName } : {}) };
  const parsed = email.safeParse(values.email);
  if (!parsed.success) return { fieldErrors: { email: "email" }, values };
  const next = safeNext(form.get("next"));
  const signingUp = form.get("intent") === "sign-up";
  const db = await createServerSupabase();
  const { error } = await db.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: signingUp,
      // private.handle_new_auth_user (0206) copies full_name into app.people.
      ...(signingUp && fullName ? { data: { full_name: fullName } } : {}),
      emailRedirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", next),
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
  const values = { fullName: text(form, "fullName"), email: text(form, "email") };
  const parsed = z
    .object({ fullName: z.string().min(1).max(200), email, password: newPassword })
    .safeParse({ ...values, password: form.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  if (passwordHasContextWords(parsed.data.password, parsed.data)) {
    return { fieldErrors: { password: "passwordContext" }, values };
  }
  const next = safeNext(form.get("next"), "/auth/organization");
  const db = await createServerSupabase();
  const { data, error } = await db.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // private.handle_new_auth_user (0206) copies full_name into app.people.
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", next),
    },
  });
  if (error) return { error: authErrorKey(error), values };
  if (!data.session) redirect(`/auth/check-email?email=${encodeURIComponent(parsed.data.email)}`);
  redirect(next as Route);
}

// Organization ------------------------------------------------------------------------------------

export async function createOrganizationAction(_: FormState, form: FormData): Promise<FormState> {
  const values = { orgName: text(form, "orgName"), orgSlug: text(form, "orgSlug").toLowerCase() };
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
