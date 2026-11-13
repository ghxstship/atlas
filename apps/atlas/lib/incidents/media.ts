import type { XosClient } from "@xos/data";
import { observability } from "@/lib/observability";

/**
 * A photo or video attached to an incident from Atlas (crawl 4.9). Compass uploads its photos to the private
 * field-media bucket as <org_id>/incidents/<incident_id>/<id>.<ext> (0368) before it calls app.add_incident_media; the
 * Atlas peek asked instead for the stored path of a file already uploaded, which nobody at a desk has. Atlas now
 * uploads the chosen file under the same name, which the bucket's policy allows to anyone who writes the incident on
 * its project, and attaches it with the same id. Only the types the bucket accepts for photos and video are uploaded.
 */

const TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** What the file input offers, the same types. */
export const INCIDENT_MEDIA_ACCEPT = Object.keys(TYPES).join(",");

/** The bucket's own limit (0368). */
export const INCIDENT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export type IncidentMediaUpload =
  | { ok: true; id: string; path: string }
  | { ok: false; error: "fileInput" | "mediaType" | "fileSize" | "mediaUpload" };

/** The field-media object name of an incident's photo or video; null for a type the bucket does not take. */
export function incidentMediaPath(
  orgId: string,
  incidentId: string,
  contentType: string,
  id: string,
): string | null {
  const ext = TYPES[contentType];
  return ext ? `${orgId}/incidents/${incidentId}/${id}.${ext}` : null;
}

/** Checks a chosen file and uploads it to field-media; the caller attaches the returned path with the returned id. */
export async function uploadIncidentMedia(
  db: XosClient,
  input: { orgId: string; incidentId: string; file: unknown; id?: string },
): Promise<IncidentMediaUpload> {
  const file = input.file;
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "fileInput" };
  const id = input.id ?? crypto.randomUUID();
  const path = incidentMediaPath(input.orgId, input.incidentId, file.type, id);
  if (path === null) return { ok: false, error: "mediaType" };
  if (file.size > INCIDENT_MEDIA_MAX_BYTES) return { ok: false, error: "fileSize" };
  const { error } = await db.storage
    .from("field-media")
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });
  if (error) {
    observability.logger.error("Incident media upload failed", { error });
    return { ok: false, error: "mediaUpload" };
  }
  return { ok: true, id, path };
}
