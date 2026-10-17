/**
 * Account deletion (SIM-004, journey 38; App Store guideline 5.1.1(v)): the signed-in person deletes their
 * own account from Compass or Gateway. Shared by both apps so the contract is called one way.
 *
 * The flow: read the preview (blockers, and what is kept and why), confirm with the sign-in email, remove the
 * person's own profile media while they can still reach it, then call app.delete_my_account. A refusal
 * (legal hold, on shift, sole owner, wrong email) deletes nothing and comes back as a typed refusal.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fail, ok, toDataError, type Result } from "./result.ts";

export type AccountDeletionBlockerCode =
  "account_delete_legal_hold" | "account_delete_on_shift" | "account_delete_sole_owner";

export interface AccountDeletionBlocker {
  readonly code: AccountDeletionBlockerCode;
  readonly orgId: string;
  readonly orgName: string;
  /** The legal hold's matter, for account_delete_legal_hold. */
  readonly matter: string | null;
}

export type KeptCategory =
  "time_and_pay" | "tax_forms" | "engagements" | "org_records" | "audit_trail" | "erasure_request";

export interface KeptRecord {
  readonly category: KeptCategory;
  /** "7 years", or "org" when the org keeps the record as its own. */
  readonly retention: string;
}

export interface AccountDeletionPreview {
  readonly personId: string;
  readonly email: string;
  readonly blockers: readonly AccountDeletionBlocker[];
  readonly kept: readonly KeptRecord[];
}

export interface AccountDeletionResult {
  readonly deletedAt: string;
  readonly replayed: boolean;
  readonly kept: readonly KeptRecord[];
  readonly membershipsEnded: number;
  readonly engagementsCanceled: number;
  readonly orgsNotified: number;
}

/** The bucket and folder of the person's own profile media (0860: paths start with the person id). */
export const PROFILE_MEDIA_BUCKET = "profile-media";

function kept(value: unknown): KeptRecord[] {
  return (Array.isArray(value) ? value : []).map((k: Record<string, unknown>) => ({
    category: String(k["category"]) as KeptCategory,
    retention: String(k["retention"]),
  }));
}

export function parsePreview(raw: Record<string, unknown>): AccountDeletionPreview {
  const blockers = (Array.isArray(raw["blockers"]) ? raw["blockers"] : []).map(
    (b: Record<string, unknown>) => ({
      code: String(b["code"]) as AccountDeletionBlockerCode,
      orgId: String(b["org_id"]),
      orgName: String(b["org_name"]),
      matter: b["matter"] === null || b["matter"] === undefined ? null : String(b["matter"]),
    }),
  );
  return {
    personId: String(raw["person_id"]),
    email: String(raw["email"] ?? ""),
    blockers,
    kept: kept(raw["kept"]),
  };
}

export function parseResult(raw: Record<string, unknown>): AccountDeletionResult {
  return {
    deletedAt: String(raw["deleted_at"]),
    replayed: raw["replayed"] === true,
    kept: kept(raw["kept"]),
    membershipsEnded: Number(raw["memberships_ended"] ?? 0),
    engagementsCanceled: Number(raw["engagements_canceled"] ?? 0),
    orgsNotified: Number(raw["orgs_notified"] ?? 0),
  };
}

/** What deleting the account would do now. Changes nothing. */
export async function previewAccountDeletion(
  client: SupabaseClient,
): Promise<Result<AccountDeletionPreview>> {
  const { data, error } = await client.rpc("account_deletion_preview");
  if (error) return fail(toDataError(error));
  return ok(parsePreview((data ?? {}) as Record<string, unknown>));
}

/** Removes every object in the person's own profile media folder. Returns how many it removed. */
export async function removeProfileMedia(
  client: SupabaseClient,
  personId: string,
): Promise<Result<number>> {
  const bucket = client.storage.from(PROFILE_MEDIA_BUCKET);
  // Folders list with a null id; walk them so nested media (portfolio, certificates) goes too.
  const files: string[] = [];
  const folders = [personId];
  while (folders.length > 0) {
    const folder = folders.pop() as string;
    const listed = await bucket.list(folder, { limit: 1000 });
    if (listed.error) return fail({ kind: "unexpected", message: listed.error.message });
    for (const o of listed.data) {
      (o.id === null ? folders : files).push(`${folder}/${o.name}`);
    }
  }
  let removed = 0;
  for (let i = 0; i < files.length; i += 100) {
    const gone = await bucket.remove(files.slice(i, i + 100));
    if (gone.error) return fail({ kind: "unexpected", message: gone.error.message });
    removed += gone.data.length;
  }
  return ok(removed);
}

/**
 * Deletes the signed-in person's account: checks the preview, removes their profile media, then calls
 * app.delete_my_account with the typed email. Blockers come back as the database's refusal before anything
 * is removed.
 */
export async function deleteMyAccount(
  client: SupabaseClient,
  confirmEmail: string,
): Promise<Result<AccountDeletionResult>> {
  const preview = await previewAccountDeletion(client);
  if (!preview.ok) return preview;
  if (
    preview.data.blockers.length === 0 &&
    confirmEmail.trim().toLowerCase() === preview.data.email
  ) {
    const media = await removeProfileMedia(client, preview.data.personId);
    if (!media.ok) return media;
  }
  const { data, error } = await client.rpc("delete_my_account", { p_confirm_email: confirmEmail });
  if (error) return fail(toDataError(error));
  return ok(parseResult((data ?? {}) as Record<string, unknown>));
}
