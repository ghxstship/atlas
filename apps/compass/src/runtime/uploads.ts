/**
 * Resumable uploads on the device (Section 13 Media: "Upload is resumable"; A65-011 part 4). Photos, voice
 * notes and documents that queued writes name go to field-media through Supabase Storage's TUS endpoint in
 * chunks (src/data/resumable.ts), with each unfinished upload's state in the encrypted local store's
 * device-local `_uploads` table.
 *
 * A queued file is first copied out of the caches into the app's documents (persistQueuedMedia), where the
 * system never clears it, so it is still there to upload after the app restarts; the copy is removed once
 * the upload is done. The outbox owns the retries: SupabaseUploader uploads a write's files before its row,
 * a dropped connection is transient, and each attempt resumes from the server's offset.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LocalStore, MutationInput } from "@xos/sync";
import { Directory, File, Paths } from "expo-file-system";
import {
  memorySource,
  queuedMediaUris,
  resumableUpload,
  UPLOADS_TABLE,
  withMediaUris,
  type FileSource,
  type UploadState,
  type UploadStateStore,
} from "../data/resumable";
import { decodeBase64 } from "../workforce/writes";
import { contentTypeFor } from "./media";

/** A device file read a chunk at a time, so a long voice note or document never sits in memory whole. */
function deviceSource(uri: string): FileSource {
  const file = new File(uri);
  if (!file.exists) throw new Error(`The file to upload is no longer on this device: ${file.name}`);
  return {
    size: file.size,
    read: (offset, length) => {
      const handle = file.open();
      try {
        handle.offset = offset;
        return Promise.resolve(handle.readBytes(length));
      } finally {
        handle.close();
      }
    },
  };
}

/** Unfinished uploads in the device-local table of the encrypted store. */
export function uploadStateStore(store: LocalStore): UploadStateStore {
  return {
    get: async (path) =>
      ((await store.get(UPLOADS_TABLE, path)) as UploadState | undefined) ?? null,
    put: (state) =>
      store.transaction((tx) => {
        tx.put(UPLOADS_TABLE, { ...state });
      }),
    remove: (path) =>
      store.transaction((tx) => {
        tx.remove(UPLOADS_TABLE, path);
      }),
  };
}

/** Where queued files wait until they upload. */
function queueDirectory(): Directory {
  return new Directory(Paths.document, "outbox-media");
}

/**
 * Copies every cached file a write names into the app's documents and points the write at the copy. A file
 * that cannot be copied keeps its original URI and uploads from there while it lasts.
 */
export function persistQueuedMedia(input: MutationInput): MutationInput {
  const uris = queuedMediaUris(input.payload);
  if (uris.length === 0) return input;
  const moved = new Map<string, string>();
  try {
    const dir = queueDirectory();
    for (const uri of uris) {
      if (uri.startsWith(dir.uri)) continue;
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const source = new File(uri);
      const target = new File(dir, `${Date.now().toString(36)}-${source.name}`);
      source.copySync(target);
      moved.set(uri, target.uri);
    }
  } catch {
    // Whatever was copied is used; the rest keep their original URIs.
  }
  return moved.size === 0 ? input : { ...input, payload: withMediaUris(input.payload, moved) };
}

/** Removes a queued file's durable copy once it has uploaded. */
function forgetQueuedCopy(uri: string): void {
  try {
    if (!uri.startsWith(queueDirectory().uri)) return;
    new File(uri).delete();
  } catch {
    // Already gone.
  }
}

export interface ResumableMediaOptions {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly store: LocalStore;
}

/** Uploads a local file to field-media, resumably; never overwrites, so a retake is a new object. */
export function resumableMediaUploader(client: SupabaseClient, options: ResumableMediaOptions) {
  const state = uploadStateStore(options.store);
  const endpoint = `${options.supabaseUrl.replace(/\/+$/, "")}/storage/v1/upload/resumable`;
  return async (
    path: string,
    localUri: string,
  ): Promise<{ error: { message: string; statusCode?: string } | null }> => {
    const data = /^data:([^;,]+);base64,(.*)$/.exec(localUri);
    let source: FileSource;
    try {
      source = data ? memorySource(decodeBase64(data[2] ?? "")) : deviceSource(localUri);
    } catch (error) {
      // The file is gone (the person deleted it, or a restore dropped it): a refusal the person sees in
      // the offline queue, never a retry that cannot succeed.
      return {
        error: {
          message: error instanceof Error ? error.message : String(error),
          statusCode: "410",
        },
      };
    }
    const result = await resumableUpload(path, source, data?.[1] ?? contentTypeFor(path), {
      endpoint,
      bucket: "field-media",
      apiKey: options.anonKey,
      accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
      state,
    });
    if (!result.error || result.error.statusCode === "409") forgetQueuedCopy(localUri);
    return result;
  };
}
