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
import { clientIp, signupAcceptances } from "@/lib/auth/legal";
import { isOAuthProvider } from "@/lib/auth/providers";
import { safeNext, siteUrl } from "@/lib/auth/redirect";
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
const password = z.string().min(8).max(256);

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

export async function sendMagicLink(_: FormState, form: FormData): Promise<FormState> {
  const values = { email: text(form, "email") };
  const parsed = email.safeParse(values.email);
  if (!parsed.success) return { fieldErrors: { email: "email" }, values };
  const next = safeNext(form.get("next"));
  const db = await createServerSupabase();
  const { error } = await db.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: form.get("intent") === "sign-up",
      emailRedirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", next),
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
      redirectTo: siteUrl(env().ATLAS_SITE_URL, "/auth/callback", safeNext(form.get("next"))),
    },
  });
  if (error || !data.url) redirect("/auth/sign-in?error=provider_disabled");
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
    .object({ fullName: z.string().min(1).max(200), email, password })
    .safeParse({ ...values, password: form.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
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

export async function acceptInvitation(_: FormState, form: FormData): Promise<FormState> {
  const token = text(form, "token");
  const db = await createServerSupabase();
  // Invitation links (xlnk_, migration 0861) are not tied to an email address; their refusals map to
  // the invitation messages.
  const accepted = token.startsWith("xlnk_")
    ? await acceptInviteLink(db, token).then((r) =>
        r.ok || r.error.kind !== "refusal" || r.error.rule === "invite_rate_limited"
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
