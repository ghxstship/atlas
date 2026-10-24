"use server";

import type { DataError, XosClient } from "@xos/data";
import {
  generateRecoveryCodes,
  looksLikeRecoveryCode,
  redeemRecoveryCode,
  signOutOtherSessions,
  signOutSession,
} from "@xos/data/account-security";
import { requireSecondFactor } from "@xos/data/auth-assurance";
import { revokeConnectedApp } from "@xos/data/oauth";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext } from "@/lib/auth/redirect";
import { createServerSupabase } from "@/lib/supabase/server";
import { observability } from "@/lib/observability";

/**
 * Recovery codes, signed-in sessions and connected apps in Gateway (A99, RRR-144; ADR 0055; Section 4.5.6 personal
 * setting 4): the same sign-in Atlas and Compass use.
 * Every action runs with the caller's session, and the RPCs of migrations 1560, 1561 and 1563 touch only the caller's
 * own codes, sessions and grants. Errors come back as `authSecurity.errors.*` keys.
 */

export interface AccountSecurityState {
  readonly ok?: boolean;
  readonly error?: string;
  /** Codes left after a recovery code was used. */
  readonly remaining?: number;
  /** Sessions signed out by "Sign out all other sessions". */
  readonly count?: number;
  readonly at?: number;
}

export type AccountSecurityResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

const RULES = new Set([
  "step_up_required",
  "recovery_codes_need_factor",
  "no_codes",
  "session_current",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") {
    if (error.rule === "code_invalid") return "recovery_invalid";
    if (error.rule === "rate_limited") return "recovery_rate_limited";
    return RULES.has(error.rule) ? error.rule : "unexpected";
  }
  if (error.kind === "not-found") return "denied";
  if (error.kind === "unexpected")
    observability.logger.error("account security action failed", { error: error });
  return "unexpected";
}

const refused = (error: string): AccountSecurityState => ({ error, at: Date.now() });

async function session(next = "/"): Promise<XosClient> {
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect(`/auth/sign-in?next=${encodeURIComponent(next)}` as Route);
  return db;
}

// Recovery codes -----------------------------------------------------------------------------------------------------------

/**
 * Uses a recovery code at the sign-in challenge (then continues to `next`) or in the step-up dialog (then reports the
 * codes left, and the dialog resumes the action). The database spends the code on this session; the refresh fetches
 * the aal2 token.
 */
export async function redeemRecoveryCodeAction(
  _: AccountSecurityState,
  form: FormData,
): Promise<AccountSecurityState> {
  const code = String(form.get("code") ?? "");
  if (!looksLikeRecoveryCode(code)) return refused("recovery_invalid");
  const next = safeNext(form.get("next"), "/home");
  const db = await session(next);
  const result = await redeemRecoveryCode(db, code);
  if (!result.ok) return refused(errorKey(result.error));
  revalidatePath("/settings/security");
  if (form.get("mode") === "sign-in") redirect(next as Route);
  return { ok: true, remaining: result.data.remaining, at: Date.now() };
}

/** Makes a new set of codes after step-up and returns them once. */
export async function generateRecoveryCodesAction(): Promise<AccountSecurityResult<string[]>> {
  const db = await session();
  const check = await requireSecondFactor(db);
  if (!check.ok) return { ok: false, error: check.rule };
  const result = await generateRecoveryCodes(db);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  // No revalidation here: a refresh would replace the codes on screen before the person saved them.
  return { ok: true, data: result.data };
}

/** Refreshes Security after the person saved their new codes. */
export async function recoveryCodesSavedAction(): Promise<void> {
  revalidatePath("/settings/security");
}

// Sessions ----------------------------------------------------------------------------------------------------------------

export async function signOutSessionAction(
  _: AccountSecurityState,
  form: FormData,
): Promise<AccountSecurityState> {
  const id = z.uuid().safeParse(form.get("sessionId"));
  if (!id.success) return refused("unexpected");
  const db = await session();
  const result = await signOutSession(db, id.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidatePath("/settings/security");
  return { ok: true, at: Date.now() };
}

export async function signOutOtherSessionsAction(): Promise<AccountSecurityState> {
  const db = await session();
  const result = await signOutOtherSessions(db);
  if (!result.ok) return refused(errorKey(result.error));
  revalidatePath("/settings/security");
  return { ok: true, count: result.data, at: Date.now() };
}

// Connected apps ------------------------------------------------------------------------------------------------------------

export async function revokeConnectedAppAction(
  _: AccountSecurityState,
  form: FormData,
): Promise<AccountSecurityState> {
  const id = z.uuid().safeParse(form.get("grantId"));
  if (!id.success) return refused("unexpected");
  const db = await session();
  const result = await revokeConnectedApp(db, id.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidatePath("/settings/connected-apps");
  return { ok: true, at: Date.now() };
}
