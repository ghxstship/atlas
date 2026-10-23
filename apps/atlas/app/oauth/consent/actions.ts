"use server";

import { requireSecondFactor } from "@xos/data/auth-assurance";
import { consentToRequest, declineRequest, getConsentRequest } from "@xos/data/oauth";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Allow or deny an app on the consent page (A99, ADR 0055). Allowing records the grant in the database
 * (app.consent_oauth_request: PKCE S256, step-up for Restricted groups) before Supabase Auth issues the code, then
 * sends the browser back to the app's registered redirect URI with the code and state. Denying sends access_denied.
 */

export interface ConsentState {
  readonly error?: string;
  readonly at?: number;
}

const id = z.string().regex(/^[a-z0-9]{16,64}$/);

const RULES = new Set([
  "step_up_required",
  "oauth_request_expired",
  "oauth_client_unknown",
  "oauth_not_member",
  "oauth_scope_unknown",
  "oauth_pkce_required",
]);

export async function allowAppAction(_: ConsentState, form: FormData): Promise<ConsentState> {
  const authorization = id.safeParse(form.get("authorizationId"));
  if (!authorization.success) return { error: "oauth_request_expired", at: Date.now() };
  const db = await createServerSupabase();
  const request = await getConsentRequest(db, authorization.data);
  if (!request.ok || !request.data) return { error: "oauth_request_expired", at: Date.now() };
  if (request.data.restrictedScopes.length > 0) {
    // Restricted groups ask for step-up; checking first opens the dialog before anything is recorded.
    const check = await requireSecondFactor(db);
    if (!check.ok) return { error: check.rule, at: Date.now() };
  }
  const result = await consentToRequest(db, authorization.data);
  if (!result.ok) {
    const rule = result.error.kind === "refusal" ? result.error.rule : "unexpected";
    return { error: RULES.has(rule) ? rule : "unexpected", at: Date.now() };
  }
  redirect(result.data as Route);
}

export async function denyAppAction(_: ConsentState, form: FormData): Promise<ConsentState> {
  const authorization = id.safeParse(form.get("authorizationId"));
  if (!authorization.success) return { error: "oauth_request_expired", at: Date.now() };
  const db = await createServerSupabase();
  const result = await declineRequest(db, authorization.data);
  if (!result.ok) return { error: "oauth_request_expired", at: Date.now() };
  redirect(result.data as Route);
}
