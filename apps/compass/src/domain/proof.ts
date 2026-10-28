/**
 * Sponsors' proof-of-performance photos (A140, Section 4.5.7 role table: "Proof-of-performance capture with photos";
 * journey 47: "entitlement fulfillment is captured with photos in Compass"). A sponsor photographs an entitlement
 * being delivered on their own engagement; the photo uploads to field-media under that engagement
 * (<org_id>/proof-of-performance/<engagement_id>/<photo id>.jpg), where upload-scan checks it before anyone else can
 * read it, and app.record_proof_of_performance_photo (2332) records it against the entitlement, once, through the
 * outbox. Capture is open while the engagement's operational area is: Active or Closing (Section 8.7).
 */
import { uuidv7, type MutationInput, type Row } from "@xos/sync";
import type { EngagementSummary } from "./access";

/** The RPC that records a photo, replayed once through app.apply_sync_mutation. */
export const PROOF_PHOTO_RPC = "app.record_proof_of_performance_photo";

/** The local table of the sponsor's proof photos (api_external.proof_of_performance_photos). */
export const PROOF_PHOTOS_TABLE = "proof_of_performance_photos";

/**
 * The sponsor engagement a photo on a project belongs to: the person's Sponsor engagement there whose operational
 * area is open (Active or Closing), or null when they cannot capture on that project.
 */
export function proofEngagement(
  engagements: readonly EngagementSummary[],
  projectId: string | null | undefined,
): EngagementSummary | null {
  if (!projectId) return null;
  return (
    engagements.find(
      (e) =>
        e.roleType === "sponsor" &&
        e.projectId === projectId &&
        (e.state === "Active" || e.state === "Closing"),
    ) ?? null
  );
}

/** The field-media object a proof photo is stored as: under its org and the sponsor's engagement (2332). */
export function proofPhotoPath(
  engagement: Pick<EngagementSummary, "id" | "orgId">,
  photoId: string,
): string {
  return `${engagement.orgId}/proof-of-performance/${engagement.id}/${photoId}.jpg`;
}

export interface ProofPhotoSave {
  readonly entitlementId: string;
  readonly engagement: EngagementSummary;
  /** The compressed photo on the device. */
  readonly localUri: string;
  /** When the photo was taken, by the device clock. */
  readonly capturedAt: string;
}

/**
 * Queues a proof photo. The uploader stores the photo (local_uri, storage_path) before it calls the RPC, so the row
 * never names a file that is not there; the optimistic row shows on the entitlement at once.
 */
export function buildProofPhoto(
  save: ProofPhotoSave,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const path = proofPhotoPath(save.engagement, id);
  return {
    op: "rpc",
    target: PROOF_PHOTO_RPC,
    table: PROOF_PHOTOS_TABLE,
    rowId: id,
    payload: {
      p_id: id,
      p_sponsor_entitlement_id: save.entitlementId,
      p_media_uri: path,
      p_captured_at: save.capturedAt,
      storage_path: path,
      local_uri: save.localUri,
    },
    policy: "append",
    optimistic: {
      id,
      engagement_id: save.engagement.id,
      sponsor_entitlement_id: save.entitlementId,
      project_id: save.engagement.projectId,
      media_uri: path,
      captured_at: save.capturedAt,
      created_at: new Date(nowMs).toISOString(),
    },
  };
}

/** How many photos each entitlement has on the device, by entitlement id. */
export function photoCounts(rows: readonly Row[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = row["sponsor_entitlement_id"];
    if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
