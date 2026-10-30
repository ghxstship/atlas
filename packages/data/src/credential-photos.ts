import type { XosClient } from "./client.ts";
import { isEmbeddableImage } from "./documents/render.ts";
import type { BadgePhoto } from "./documents/templates.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Badge photos (P5, G-144, migrations 2820 to 2822, ADR 0031 amendment). An issuer asks credential holders for a
 * photo; the holder gives one in Gateway, from an upload or their profile photo, with a consent record, and
 * withdraws it there. Every badge reads the photo it prints from app.credential_photo_states, in resolution order:
 * the org's badge photo once it scanned Clean, else a profile photo the caller may see, else none.
 */

export const CREDENTIAL_PHOTOS_BUCKET = "credential-photos";

/** The notice version the Gateway page shows, recorded on the holder's consent (2822). */
export const CREDENTIAL_PHOTO_NOTICE_VERSION = "credential-photo-2026-11";

/** The largest photo a badge embeds, the bucket's limit too: 2 MiB. */
export const BADGE_PHOTO_MAX_BYTES = 2_097_152;

export type CredentialPhotoState =
  "Provided" | "Scanning" | "Refused" | "Profile" | "Requested" | "Missing";

export const CREDENTIAL_PHOTO_STATES: readonly CredentialPhotoState[] = [
  "Provided",
  "Scanning",
  "Refused",
  "Profile",
  "Requested",
  "Missing",
];

export type CredentialPhotoSource = "Holder Upload" | "Holder Profile Photo";

export interface BadgePhotoRow {
  readonly credentialId: string;
  readonly holderPersonId: string;
  readonly state: CredentialPhotoState;
  /** Set for Provided and Profile only: where the badge reads the photo from. */
  readonly bucketId: "credential-photos" | "profile-media" | null;
  readonly photoPath: string | null;
  readonly requestedAt: string | null;
  readonly providedAt: string | null;
  readonly source: CredentialPhotoSource | null;
}

interface BadgePhotoRecord {
  credential_id: string;
  holder_person_id: string;
  photo_state: CredentialPhotoState;
  bucket_id: string | null;
  photo_path: string | null;
  requested_at: string | null;
  provided_at: string | null;
  source: CredentialPhotoSource | null;
}

function toRow(r: BadgePhotoRecord): BadgePhotoRow {
  const bucket =
    r.bucket_id === CREDENTIAL_PHOTOS_BUCKET || r.bucket_id === "profile-media"
      ? r.bucket_id
      : null;
  return {
    credentialId: r.credential_id,
    holderPersonId: r.holder_person_id,
    state: r.photo_state,
    bucketId: bucket,
    photoPath: bucket ? r.photo_path : null,
    requestedAt: r.requested_at,
    providedAt: r.provided_at,
    source: r.source,
  };
}

/** The photo each of up to 100 live credentials the caller reads prints (app.credential_badge_photos). */
export async function badgePhotos(
  db: XosClient,
  credentialIds: readonly string[],
): Promise<Result<BadgePhotoRow[]>> {
  if (credentialIds.length === 0) return ok([]);
  const { data, error } = await db.rpc("credential_badge_photos", {
    p_credential_ids: [...credentialIds],
  });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as BadgePhotoRecord[]).map(toRow));
}

/** The photo state of live credentials the caller reads, for the list and the print panel. */
export async function credentialPhotoStates(
  db: XosClient,
  credentialIds: readonly string[],
): Promise<Result<ReadonlyMap<string, CredentialPhotoState>>> {
  if (credentialIds.length === 0) return ok(new Map());
  const { data, error } = await db
    .from("credential_photo_states")
    .select("credential_id, photo_state")
    .in("credential_id", [...credentialIds]);
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      ((data ?? []) as { credential_id: string | null; photo_state: CredentialPhotoState | null }[])
        .filter((r) => r.credential_id && r.photo_state)
        .map((r) => [r.credential_id as string, r.photo_state as CredentialPhotoState]),
    ),
  );
}

/**
 * Bytes a badge may embed: a JPEG or PNG (its signature, not its declared type) of at most 2 MiB. Anything else
 * prints the placeholder.
 */
export function isBadgePhotoBytes(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes.length <= BADGE_PHOTO_MAX_BYTES && isEmbeddableImage(bytes);
}

/** The extension of an embeddable photo, from its signature. */
export function badgePhotoExtension(bytes: Uint8Array): "jpg" | "png" | null {
  if (!isBadgePhotoBytes(bytes)) return null;
  return bytes[0] === 0x89 ? "png" : "jpg";
}

/**
 * A profile photo's bytes. profile-media is a public bucket with no select policy (0860), so a signed-in download
 * is refused: the bytes come from the object's public URL on the same Supabase project, and nowhere else.
 */
export async function fetchProfilePhoto(
  db: XosClient,
  photoPath: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array | null> {
  const { data } = db.storage.from("profile-media").getPublicUrl(photoPath);
  if (!data?.publicUrl) return null;
  try {
    const response = await fetcher(data.publicUrl);
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > BADGE_PHOTO_MAX_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return isBadgePhotoBytes(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** One photo's bytes: the badge photo read as the caller, or the profile photo from its public URL. */
async function photoBytes(
  db: XosClient,
  row: BadgePhotoRow,
  fetcher: typeof fetch,
): Promise<BadgePhoto | null> {
  if (!row.photoPath || !row.bucketId) return null;
  if (row.bucketId === "profile-media") {
    const bytes = await fetchProfilePhoto(db, row.photoPath, fetcher);
    return bytes ? { bytes, source: "Profile" } : null;
  }
  const { data } = await db.storage.from(CREDENTIAL_PHOTOS_BUCKET).download(row.photoPath);
  if (!data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  return isBadgePhotoBytes(bytes) ? { bytes, source: "Badge" } : null;
}

/**
 * The photo bytes of each row that has one, by credential id, eight downloads at a time. A row whose photo cannot
 * be read or is not an embeddable image is left out, so its badge prints the placeholder.
 */
export async function loadBadgePhotoBytes(
  db: XosClient,
  rows: readonly BadgePhotoRow[],
  fetcher: typeof fetch = fetch,
): Promise<ReadonlyMap<string, BadgePhoto>> {
  const out = new Map<string, BadgePhoto>();
  const queue = rows.filter((r) => r.photoPath && r.bucketId);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const row = queue[next++] as BadgePhotoRow;
      const photo = await photoBytes(db, row, fetcher);
      if (photo) out.set(row.credentialId, photo);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  return out;
}

/** A new badge photo's object name, in the holder's own folder of the org: <org>/<person>/<uuid>.jpg or .png. */
export function credentialPhotoPath(
  orgId: string,
  personId: string,
  extension: "jpg" | "png" = "jpg",
  id: string = crypto.randomUUID(),
): string {
  return `${orgId}/${personId}/${id}.${extension}`;
}

export type RequestOutcome =
  | "requested"
  | "not_notified"
  | "already_provided"
  | "recently_requested"
  | "no_sign_in"
  | "not_allowed";

export const REQUEST_OUTCOMES: readonly RequestOutcome[] = [
  "requested",
  "not_notified",
  "already_provided",
  "recently_requested",
  "no_sign_in",
  "not_allowed",
];

/** Asks the holders of 1 to 100 credentials for a badge photo; one outcome per credential (2822). */
export async function requestCredentialPhotos(
  db: XosClient,
  credentialIds: readonly string[],
): Promise<Result<{ readonly credentialId: string; readonly outcome: RequestOutcome }[]>> {
  const { data, error } = await db.rpc("request_credential_photos", {
    p_credential_ids: [...credentialIds],
  });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as { credential_id: string; outcome: RequestOutcome }[]).map((r) => ({
      credentialId: r.credential_id,
      outcome: r.outcome,
    })),
  );
}

/** How many credentials had each outcome. */
export function countOutcomes(
  outcomes: readonly { readonly outcome: RequestOutcome }[],
): Readonly<Partial<Record<RequestOutcome, number>>> {
  const counts: Partial<Record<RequestOutcome, number>> = {};
  for (const o of outcomes) counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
  return counts;
}

/** The holder records a photo they uploaded to their own folder; returns the object it replaced, to remove. */
export async function recordCredentialPhoto(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly photoPath: string;
    readonly source: CredentialPhotoSource;
    readonly noticeVersion?: string;
  },
): Promise<Result<{ readonly id: string; readonly replacedPath: string | null }>> {
  const { data, error } = await db.rpc("record_credential_photo", {
    p_org_id: input.orgId,
    p_photo_path: input.photoPath,
    p_source: input.source,
    p_notice_version: input.noticeVersion ?? CREDENTIAL_PHOTO_NOTICE_VERSION,
  });
  if (error) return fail(toDataError(error));
  const row = ((data ?? []) as { credential_photo_id: string; replaced_path: string | null }[])[0];
  if (!row) return fail({ kind: "unexpected", message: "record_credential_photo returned no row" });
  return ok({ id: row.credential_photo_id, replacedPath: row.replaced_path });
}

/** An issuer removes a holder's badge photo; returns the object to delete, or null when there was none. */
export async function removeCredentialPhoto(
  db: XosClient,
  orgId: string,
  personId: string,
): Promise<Result<string | null>> {
  const { data, error } = await db.rpc("remove_credential_photo", {
    p_org_id: orgId,
    p_person_id: personId,
  });
  if (error) return fail(toDataError(error));
  return ok((data as string | null) ?? null);
}

/**
 * The holder withdraws their badge photos and consent in one org, or every org with null, and gets every object of
 * theirs still stored there, to remove.
 */
export async function withdrawMyCredentialPhotos(
  db: XosClient,
  orgId: string | null,
): Promise<Result<{ readonly orgId: string; readonly photoPath: string }[]>> {
  const { data, error } = await db.rpc(
    "withdraw_my_credential_photos",
    orgId ? { p_org_id: orgId } : {},
  );
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as { org_id: string; photo_path: string }[]).map((r) => ({
      orgId: r.org_id,
      photoPath: r.photo_path,
    })),
  );
}

/**
 * Deletes badge photo objects. Storage answers a delete the caller may not make with no error and nothing removed,
 * so every name must come back as removed; otherwise this fails and says how many were left.
 */
export async function removeCredentialPhotoObjects(
  db: Pick<XosClient, "storage">,
  paths: readonly string[],
): Promise<Result<number>> {
  const wanted = [...new Set(paths.filter(Boolean))];
  let removed = 0;
  for (let i = 0; i < wanted.length; i += 100) {
    const batch = wanted.slice(i, i + 100);
    const { data, error } = await db.storage.from(CREDENTIAL_PHOTOS_BUCKET).remove(batch);
    if (error) return fail({ kind: "unexpected", message: error.message });
    const gone = new Set((data ?? []).map((o) => o.name));
    const left = batch.filter((p) => !gone.has(p));
    if (left.length > 0) {
      return fail({
        kind: "unexpected",
        message: `${left.length} badge photo object(s) could not be removed.`,
      });
    }
    removed += batch.length;
  }
  return ok(removed);
}

export interface MyCredentialPhoto {
  readonly orgId: string;
  readonly orgName: string;
  readonly state: CredentialPhotoState;
  readonly source: CredentialPhotoSource | null;
  readonly providedAt: string | null;
  /** The holder's badge photo in credential-photos, for their own thumbnail. */
  readonly photoPath: string | null;
  /** True when their profile photo can stand in: a JPEG or PNG of at most 2 MiB. */
  readonly hasProfilePhoto: boolean;
}

/** The signed-in person's badge photo in each org where they hold a live credential. */
export async function myCredentialPhotos(db: XosClient): Promise<Result<MyCredentialPhoto[]>> {
  const { data, error } = await db.rpc("my_credential_photos");
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as {
        org_id: string;
        org_name: string;
        photo_state: CredentialPhotoState;
        source: CredentialPhotoSource | null;
        provided_at: string | null;
        photo_path: string | null;
        has_profile_photo: boolean;
      }[]
    ).map((r) => ({
      orgId: r.org_id,
      orgName: r.org_name,
      state: r.photo_state,
      source: r.source,
      providedAt: r.provided_at,
      photoPath: r.photo_path,
      hasProfilePhoto: r.has_profile_photo === true,
    })),
  );
}

/**
 * A thumbnail link for the photo a badge prints: a 60-second signed link to a badge photo, or the public link of a
 * profile photo (profile-media is public, 0860). Null when the badge prints none.
 */
export async function badgePhotoThumbnail(
  db: XosClient,
  row: Pick<BadgePhotoRow, "bucketId" | "photoPath">,
): Promise<string | null> {
  if (!row.photoPath || !row.bucketId) return null;
  if (row.bucketId === "profile-media") {
    return db.storage.from("profile-media").getPublicUrl(row.photoPath).data?.publicUrl ?? null;
  }
  return badgePhotoUrl(db, row.photoPath);
}

/** A short-lived link to a badge photo the caller may read, for a thumbnail: 60 seconds. */
export async function badgePhotoUrl(db: XosClient, photoPath: string): Promise<string | null> {
  const { data } = await db.storage.from(CREDENTIAL_PHOTOS_BUCKET).createSignedUrl(photoPath, 60);
  return data?.signedUrl ?? null;
}
