import type { XosClient } from "@xos/data";
import { observability } from "@/lib/observability";

/**
 * Uploads a form photo or signature to the private field-media bucket under the submitter's own
 * folder, <org_id>/forms/<person_id>/<random>.<ext> (0808), and returns the object name to store in
 * the answers. Only images the bucket accepts are uploaded; anything else is refused before upload.
 */

const TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};
const MAX_BYTES = 50 * 1024 * 1024;

export type MediaResult =
  { ok: true; path: string } | { ok: false; error: "fileType" | "fileSize" | "uploadFailed" };

export function formMediaPath(
  orgId: string,
  personId: string,
  contentType: string,
  id: string = crypto.randomUUID(),
): string | null {
  const ext = TYPES[contentType];
  return ext ? `${orgId}/forms/${personId}/${id}.${ext}` : null;
}

export async function uploadFormMedia(
  db: XosClient,
  orgId: string,
  personId: string,
  file: File,
): Promise<MediaResult> {
  const path = formMediaPath(orgId, personId, file.type);
  if (path === null) return { ok: false, error: "fileType" };
  if (file.size > MAX_BYTES) return { ok: false, error: "fileSize" };
  const { error } = await db.storage
    .from("field-media")
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });
  if (error) {
    observability.logger.error("Form media upload failed", { error });
    return { ok: false, error: "uploadFailed" };
  }
  return { ok: true, path };
}
