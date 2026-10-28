"use server";

import { deleteMyAccount, type KeptCategory } from "@xos/data/account-deletion";
import { untyped } from "@xos/data/untyped";
import { createServerSupabase } from "@/lib/supabase/server";
import { observability } from "@/lib/observability";

/** What the delete account form shows after a submit. */
export interface DeleteAccountState {
  /** The account is deleted: who was told and what is kept. */
  readonly deleted?: { readonly orgsNotified: number; readonly kept: readonly KeptCategory[] };
  /** The database refused (legal hold, on shift, sole owner, wrong email); nothing was deleted. */
  readonly refused?: string;
  /** The call failed for another reason; nothing was deleted. */
  readonly failed?: string;
}

/**
 * Deletes the signed-in person's account (ADR 0028, journey 38) through the one client Compass
 * uses, @xos/data/account-deletion: the preview, the profile media, then app.delete_my_account
 * confirmed with the typed sign-in email. Online only; the confirmation then signs the session
 * out, because the sign-in no longer exists.
 */
export async function deleteAccountAction(
  _: DeleteAccountState,
  form: FormData,
): Promise<DeleteAccountState> {
  const email = String(form.get("email") ?? "");
  const db = await createServerSupabase();
  const result = await deleteMyAccount(untyped(db), email);
  if (!result.ok) {
    const error = result.error;
    if (error.kind === "refusal") return { refused: error.message };
    observability.logger.error("delete_my_account failed", { error: error });
    return { failed: "message" in error ? error.message : error.kind };
  }
  // The confirmation shows first; its Done button posts to /auth/sign-out, which ends this
  // session (the sign-in itself no longer exists), as Compass's Done does.
  return {
    deleted: {
      orgsNotified: result.data.orgsNotified,
      kept: result.data.kept.map((k) => k.category),
    },
  };
}
