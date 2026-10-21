/**
 * Resumable uploads (Section 13 Media: "Upload is resumable"; A65-011 part 4) through Supabase Storage's TUS
 * endpoint (`/storage/v1/upload/resumable`, TUS 1.0.0). Photos, voice notes and documents upload in 6 MB
 * chunks, the size Supabase Storage requires, and the upload's URL and confirmed offset are kept on the
 * device after every chunk. A dropped connection, the app being closed, or the server going away mid-file
 * leaves the upload where it was; the outbox retries the write that owns the file (SupabaseUploader
 * uploads files before their row), and the next attempt asks the server for the offset and sends only what
 * is missing. Supabase keeps an unfinished upload for 24 hours; after that the next attempt starts over.
 *
 * Nothing here imports a native module: the file is read through FileSource and the state kept through
 * UploadStateStore, so the tests run it against a fake TUS server.
 */

export const TUS_VERSION = "1.0.0";
/** Supabase Storage takes TUS chunks of exactly 6 MB (the last one may be shorter). */
export const CHUNK_SIZE = 6 * 1024 * 1024;
/** Supabase keeps an unfinished upload URL for 24 hours; one older than this starts over. */
export const UPLOAD_URL_TTL_MS = 23 * 3600_000;
/** The device-local table that keeps each unfinished upload (never scope-checked, wiped on sign-out). */
export const UPLOADS_TABLE = "_uploads";

export interface UploadState {
  /** The object name in the bucket, which is also the outbox's key for the file. */
  readonly id: string;
  readonly uploadUrl: string;
  readonly size: number;
  /** Bytes the server confirmed. */
  readonly offset: number;
  readonly createdAt: number;
}

export interface UploadStateStore {
  get(path: string): Promise<UploadState | null>;
  put(state: UploadState): Promise<void>;
  remove(path: string): Promise<void>;
}

/** The bytes of one file, read a chunk at a time. */
export interface FileSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ResumableOptions {
  /** `${supabaseUrl}/storage/v1/upload/resumable`. */
  readonly endpoint: string;
  readonly bucket: string;
  /** The project's public anon key, which the API gateway asks for on every request. */
  readonly apiKey: string;
  readonly accessToken: () => Promise<string | null>;
  readonly state: UploadStateStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly chunkSize?: number;
}

export interface UploadError {
  readonly message: string;
  /** The HTTP status; absent when no response came (a dropped connection), which the outbox retries. */
  readonly statusCode?: string;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of a string's UTF-8 bytes, for Upload-Metadata. */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63];
    out += BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }
  return out;
}

/** The TUS Upload-Metadata header Supabase Storage reads. */
export function uploadMetadata(bucket: string, path: string, contentType: string): string {
  return [
    ["bucketName", bucket],
    ["objectName", path],
    ["contentType", contentType],
    ["cacheControl", "3600"],
  ]
    .map(([k, v]) => `${k} ${base64(v ?? "")}`)
    .join(",");
}

function offsetOf(response: Response): number | null {
  const value = Number(response.headers.get("upload-offset"));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function failure(response: Response): Promise<UploadError> {
  const text = await response.text().catch(() => "");
  let message = text || response.statusText || `HTTP ${response.status}`;
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    message = body.message ?? body.error ?? message;
  } catch {
    // Not JSON: the text itself is the message.
  }
  return { message, statusCode: String(response.status) };
}

function dropped(error: unknown): UploadError {
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * Uploads a file to `bucket/path`, resuming an unfinished upload of the same object. Never overwrites: an
 * object that already exists answers 409, which the outbox takes as done (a retake is a new object name).
 */
export async function resumableUpload(
  path: string,
  file: FileSource,
  contentType: string,
  options: ResumableOptions,
): Promise<{ readonly error: UploadError | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const chunk = options.chunkSize ?? CHUNK_SIZE;
  const token = await options.accessToken();
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    "tus-resumable": TUS_VERSION,
    apikey: options.apiKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  try {
    let state = await options.state.get(path);
    if (state && (state.size !== file.size || now() - state.createdAt > UPLOAD_URL_TTL_MS)) {
      await options.state.remove(path);
      state = null;
    }
    // Resume: the server's offset is the truth, whatever the device last recorded.
    if (state) {
      const head = await fetchImpl(state.uploadUrl, { method: "HEAD", headers: headers() });
      const offset = head.ok ? offsetOf(head) : null;
      if (offset === null) {
        await options.state.remove(path);
        state = null;
      } else state = { ...state, offset };
    }
    if (!state) {
      const created = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: headers({
          "upload-length": String(file.size),
          "upload-metadata": uploadMetadata(options.bucket, path, contentType),
          "x-upsert": "false",
        }),
      });
      if (created.status === 409)
        return { error: { message: "The object already exists.", statusCode: "409" } };
      if (!created.ok) return { error: await failure(created) };
      const location = created.headers.get("location");
      if (!location)
        return { error: { message: "The upload server gave no upload URL.", statusCode: "502" } };
      state = {
        id: path,
        uploadUrl: new URL(location, options.endpoint).toString(),
        size: file.size,
        offset: 0,
        createdAt: now(),
      };
      await options.state.put(state);
    }
    while (state.offset < file.size) {
      const length: number = Math.min(chunk, file.size - state.offset);
      const bytes: Uint8Array = await file.read(state.offset, length);
      const patched: Response = await fetchImpl(state.uploadUrl, {
        method: "PATCH",
        headers: headers({
          "upload-offset": String(state.offset),
          "content-type": "application/offset+octet-stream",
        }),
        body: bytes as unknown as BodyInit,
      });
      if (patched.status === 409) {
        // The server holds a different offset (an earlier chunk landed after all): ask and go on from there.
        const head: Response = await fetchImpl(state.uploadUrl, {
          method: "HEAD",
          headers: headers(),
        });
        const offset: number | null = head.ok ? offsetOf(head) : null;
        if (offset === null) return { error: await failure(patched) };
        state = { ...state, offset };
        await options.state.put(state);
        continue;
      }
      if (!patched.ok) return { error: await failure(patched) };
      state = { ...state, offset: offsetOf(patched) ?? state.offset + length };
      await options.state.put(state);
    }
    await options.state.remove(path);
    return { error: null };
  } catch (error) {
    // No response at all: the state stays, and the next attempt resumes from the server's offset.
    return { error: dropped(error) };
  }
}

/** A file already in memory (a drawn signature rendered to PNG), as a FileSource. */
export function memorySource(bytes: Uint8Array): FileSource {
  return {
    size: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

/** The local files a queued write uploads, by the payload fields SupabaseUploader reads. */
export function queuedMediaUris(payload: Readonly<Record<string, unknown>>): string[] {
  const uris: string[] = [];
  if (typeof payload["local_uri"] === "string" && typeof payload["storage_path"] === "string")
    uris.push(payload["local_uri"]);
  const list = payload["device_media"];
  if (Array.isArray(list)) {
    for (const item of list as { local_uri?: unknown; storage_path?: unknown }[]) {
      if (typeof item.local_uri === "string" && typeof item.storage_path === "string")
        uris.push(item.local_uri);
    }
  }
  return uris.filter((uri) => uri.startsWith("file://"));
}

/** The payload with its local file URIs replaced (each queued file moved somewhere durable). */
export function withMediaUris(
  payload: Readonly<Record<string, unknown>>,
  moved: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const swap = (uri: unknown) => (typeof uri === "string" ? (moved.get(uri) ?? uri) : uri);
  const out: Record<string, unknown> = { ...payload };
  if ("local_uri" in payload) out["local_uri"] = swap(payload["local_uri"]);
  const list = payload["device_media"];
  if (Array.isArray(list)) {
    out["device_media"] = (list as Record<string, unknown>[]).map((item) => ({
      ...item,
      local_uri: swap(item["local_uri"]),
    }));
  }
  return out;
}
