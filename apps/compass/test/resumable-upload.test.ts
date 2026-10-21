/**
 * Resumable uploads (Section 13 Media, A65-011 part 4): TUS against a fake Supabase Storage, across dropped
 * connections and app restarts, and wired through the outbox so a write's row lands once its file is whole.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MemoryStore, SyncEngine, ONLINE, type Mutation } from "@xos/sync";
import { describe, expect, it } from "vitest";
import {
  base64,
  memorySource,
  queuedMediaUris,
  resumableUpload,
  TUS_VERSION,
  UPLOAD_URL_TTL_MS,
  uploadMetadata,
  withMediaUris,
  type ResumableOptions,
  type UploadState,
  type UploadStateStore,
} from "../src/data/resumable";
import { SupabaseUploader } from "../src/data/uploader";

const ENDPOINT = "https://api.example.test/storage/v1/upload/resumable";

interface FakeUpload {
  readonly length: number;
  readonly metadata: string;
  bytes: number[];
}

/**
 * A TUS server as Supabase Storage runs it: POST creates (409 when the object exists), HEAD reports the
 * offset, PATCH appends at the offset it is told. `failOn` drops the connection on chosen requests.
 */
function tusServer(options: { failOn?: (method: string, n: number) => boolean } = {}) {
  const uploads = new Map<string, FakeUpload>();
  const objects = new Map<string, Uint8Array>();
  const log: { method: string; headers: Record<string, string> }[] = [];
  let next = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    log.push({ method, headers });
    const n = log.filter((l) => l.method === method).length;
    if (options.failOn?.(method, n)) throw new TypeError("Network request failed");
    if (method === "POST") {
      const objectName = /objectName (\S+?)(,|$)/.exec(headers["upload-metadata"] ?? "")?.[1] ?? "";
      if (objects.has(objectName)) return new Response("exists", { status: 409 });
      next += 1;
      const id = `upload-${next}`;
      uploads.set(id, {
        length: Number(headers["upload-length"]),
        metadata: headers["upload-metadata"] ?? "",
        bytes: [],
      });
      return new Response(null, {
        status: 201,
        headers: { location: `/storage/v1/upload/resumable/${id}` },
      });
    }
    const id = url.split("/").pop() ?? "";
    const upload = uploads.get(id);
    if (!upload) return new Response("not found", { status: 404 });
    if (method === "HEAD")
      return new Response(null, {
        status: 200,
        headers: { "upload-offset": String(upload.bytes.length) },
      });
    if (Number(headers["upload-offset"]) !== upload.bytes.length)
      return new Response("offset", { status: 409 });
    upload.bytes.push(...(init.body as Uint8Array));
    if (upload.bytes.length === upload.length) {
      const objectName = /objectName (\S+?)(,|$)/.exec(upload.metadata)?.[1] ?? "";
      objects.set(objectName, Uint8Array.from(upload.bytes));
      uploads.delete(id);
    }
    return new Response(null, {
      status: 204,
      headers: { "upload-offset": String(upload.bytes.length) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, uploads, objects, log };
}

/** Upload state kept across "app restarts": a new store object over the same saved rows. */
function savedState(
  rows = new Map<string, UploadState>(),
): UploadStateStore & { rows: Map<string, UploadState> } {
  return {
    rows,
    get: (path) => Promise.resolve(rows.get(path) ?? null),
    put: (state) => {
      rows.set(state.id, state);
      return Promise.resolve();
    },
    remove: (path) => {
      rows.delete(path);
      return Promise.resolve();
    },
  };
}

const FILE = Uint8Array.from({ length: 2600 }, (_, i) => i % 251);
const PATH = "org-1/incidents/inc-1/photo-1.jpg";
const objectKey = base64(PATH);

function options(
  server: ReturnType<typeof tusServer>,
  state: UploadStateStore,
  now = () => 1_000,
): ResumableOptions {
  return {
    endpoint: ENDPOINT,
    bucket: "field-media",
    apiKey: "public-anon-key",
    accessToken: () => Promise.resolve("session-token"),
    state,
    fetchImpl: server.fetchImpl,
    now,
    chunkSize: 1024,
  };
}

describe("TUS uploads to Supabase Storage", () => {
  it("creates the upload with the bucket, object and type, then sends 6 MB-style chunks in order", async () => {
    const server = tusServer();
    const state = savedState();
    expect(
      await resumableUpload(PATH, memorySource(FILE), "image/jpeg", options(server, state)),
    ).toEqual({ error: null });
    expect(server.objects.get(objectKey)).toEqual(FILE);
    expect(server.log.map((l) => l.method)).toEqual(["POST", "PATCH", "PATCH", "PATCH"]);
    const create = server.log[0]?.headers ?? {};
    expect(create).toMatchObject({
      "tus-resumable": TUS_VERSION,
      apikey: "public-anon-key",
      authorization: "Bearer session-token",
      "upload-length": "2600",
      "x-upsert": "false",
    });
    expect(create["upload-metadata"]).toBe(uploadMetadata("field-media", PATH, "image/jpeg"));
    expect(server.log[2]?.headers).toMatchObject({
      "upload-offset": "1024",
      "content-type": "application/offset+octet-stream",
    });
    // Done: nothing is left to resume.
    expect(state.rows.size).toBe(0);
  });

  it("survives a dropped connection and an app restart, sending only what the server lacks", async () => {
    // The connection drops on the second chunk.
    const server = tusServer({ failOn: (method, n) => method === "PATCH" && n === 2 });
    const rows = new Map<string, UploadState>();
    const first = await resumableUpload(
      PATH,
      memorySource(FILE),
      "image/jpeg",
      options(server, savedState(rows)),
    );
    expect(first.error?.message).toBe("Network request failed");
    // No status: the outbox takes it as transient and retries.
    expect(first.error?.statusCode).toBeUndefined();
    expect(rows.get(PATH)).toMatchObject({ offset: 1024, size: 2600 });
    // The app restarts: a new state store over the same saved rows, a new upload attempt.
    const second = await resumableUpload(
      PATH,
      memorySource(FILE),
      "image/jpeg",
      options(server, savedState(rows)),
    );
    expect(second).toEqual({ error: null });
    expect(server.objects.get(objectKey)).toEqual(FILE);
    // One upload created; the retry asked for the offset and sent the last two chunks only.
    expect(server.log.map((l) => l.method)).toEqual([
      "POST",
      "PATCH",
      "PATCH",
      "HEAD",
      "PATCH",
      "PATCH",
    ]);
    expect(rows.size).toBe(0);
  });

  it("starts over when the server forgot the upload or it is older than Supabase keeps it", async () => {
    const server = tusServer();
    const rows = new Map<string, UploadState>([
      [
        PATH,
        {
          id: PATH,
          uploadUrl: `${ENDPOINT}/gone`,
          size: FILE.length,
          offset: 1024,
          createdAt: 900,
        },
      ],
    ]);
    expect(
      await resumableUpload(
        PATH,
        memorySource(FILE),
        "image/jpeg",
        options(server, savedState(rows)),
      ),
    ).toEqual({ error: null });
    expect(server.log.map((l) => l.method).slice(0, 2)).toEqual(["HEAD", "POST"]);
    const stale = tusServer();
    const old = new Map<string, UploadState>([
      [
        PATH,
        { id: PATH, uploadUrl: `${ENDPOINT}/upload-1`, size: FILE.length, offset: 0, createdAt: 0 },
      ],
    ]);
    await resumableUpload(
      PATH,
      memorySource(FILE),
      "image/jpeg",
      options(stale, savedState(old), () => UPLOAD_URL_TTL_MS + 1),
    );
    expect(stale.log[0]?.method).toBe("POST");
    // A file of another size under the same name is a different file.
    const resized = tusServer();
    const other = new Map<string, UploadState>([
      [
        PATH,
        { id: PATH, uploadUrl: `${ENDPOINT}/upload-1`, size: 10, offset: 0, createdAt: 1_000 },
      ],
    ]);
    await resumableUpload(
      PATH,
      memorySource(FILE),
      "image/jpeg",
      options(resized, savedState(other)),
    );
    expect(resized.log[0]?.method).toBe("POST");
  });

  it("never overwrites: an object that exists answers 409, which the outbox takes as done", async () => {
    const server = tusServer();
    await resumableUpload(PATH, memorySource(FILE), "image/jpeg", options(server, savedState()));
    const again = await resumableUpload(
      PATH,
      memorySource(FILE),
      "image/jpeg",
      options(server, savedState()),
    );
    expect(again.error).toEqual({ message: "The object already exists.", statusCode: "409" });
  });

  it("realigns on an offset mismatch and reports a server refusal with its status", async () => {
    // A chunk landed although its answer was lost: the next PATCH is told the old offset and gets 409.
    const server = tusServer();
    const rows = new Map<string, UploadState>();
    const state = savedState(rows);
    await resumableUpload(PATH, memorySource(FILE.subarray(0, 1024)), "image/jpeg", {
      ...options(server, state),
      chunkSize: 2048,
    });
    expect(server.objects.size).toBe(1);
    const lagging = tusServer();
    const lagRows = new Map<string, UploadState>();
    const created = await resumableUpload(PATH, memorySource(FILE), "image/jpeg", {
      ...options(lagging, savedState(lagRows)),
      fetchImpl: (async (url: string, init: RequestInit = {}) => {
        const res = await lagging.fetchImpl(url, init);
        // The first chunk's answer is lost on the way back.
        if (init.method === "PATCH" && lagging.log.filter((l) => l.method === "PATCH").length === 1)
          throw new TypeError("Network request failed");
        return res;
      }) as unknown as typeof fetch,
    });
    expect(created.error).not.toBeNull();
    expect(lagRows.get(PATH)?.offset).toBe(0);
    expect(
      await resumableUpload(
        PATH,
        memorySource(FILE),
        "image/jpeg",
        options(lagging, savedState(lagRows)),
      ),
    ).toEqual({ error: null });
    expect(lagging.objects.get(objectKey)).toEqual(FILE);
    // A refusal keeps its status, so the outbox parks it for the person.
    const refusing = (async () =>
      new Response(JSON.stringify({ message: "new row violates row-level security policy" }), {
        status: 403,
      })) as unknown as typeof fetch;
    const refused = await resumableUpload(PATH, memorySource(FILE), "image/jpeg", {
      ...options(server, savedState()),
      fetchImpl: refusing,
    });
    expect(refused.error).toEqual({
      message: "new row violates row-level security policy",
      statusCode: "403",
    });
  });
});

describe("resumable uploads through the outbox", () => {
  it("retries the write until its file is whole, then inserts its row once", async () => {
    const server = tusServer({ failOn: (method, n) => method === "PATCH" && n === 2 });
    const state = savedState();
    const inserts: unknown[] = [];
    const client = {
      from: () => {
        const chain = {
          insert: (row: unknown) => (inserts.push(row), chain),
          select: () => chain,
          maybeSingle: () => Promise.resolve({ data: { id: "media-1" }, error: null, status: 201 }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    const uploader = new SupabaseUploader({
      client,
      functionsUrl: "https://api.example.test",
      accessToken: () => Promise.resolve(null),
      orgId: () => null,
      deviceId: "device-1",
      clock: { wallNow: () => 0, monotonicNow: () => 0, bootId: () => "boot" },
      uploadFile: (path) =>
        resumableUpload(path, memorySource(FILE), "image/jpeg", options(server, state)),
    });
    let clock = 0;
    const store = new MemoryStore();
    const engine = new SyncEngine({
      store,
      uploader,
      network: ONLINE,
      now: () => clock,
      random: () => 0,
      schedule: () => () => undefined,
    });
    await engine.outbox.enqueue({
      op: "insert",
      table: "incident_media",
      rowId: "media-1",
      payload: {
        id: "media-1",
        storage_path: PATH,
        local_uri: "file:///docs/outbox-media/photo-1.jpg",
        device_org_id: null,
      },
    });
    const first = await engine.drain();
    expect(first).toMatchObject({ uploaded: 0, stoppedBy: "transient" });
    expect(inserts).toHaveLength(0);
    clock += 60_000;
    expect(await engine.drain()).toMatchObject({ uploaded: 1, stoppedBy: "empty" });
    expect(inserts).toEqual([{ id: "media-1" }]);
    expect(server.objects.get(objectKey)).toEqual(FILE);
    expect((await engine.outbox.all()) as Mutation[]).toEqual([]);
  });
});

describe("queued files", () => {
  it("finds the files a write uploads and points the write at their durable copies", () => {
    const payload = {
      storage_path: "a.jpg",
      local_uri: "file:///cache/a.jpg",
      device_media: [
        { storage_path: "b.png", local_uri: "file:///cache/b.png" },
        { storage_path: "sig.png", local_uri: "data:image/png;base64,AAAA" },
        { local_uri: "file:///cache/no-path.jpg" },
      ],
    };
    expect(queuedMediaUris(payload)).toEqual(["file:///cache/a.jpg", "file:///cache/b.png"]);
    const moved = new Map([
      ["file:///cache/a.jpg", "file:///docs/outbox-media/a.jpg"],
      ["file:///cache/b.png", "file:///docs/outbox-media/b.png"],
    ]);
    expect(withMediaUris(payload, moved)).toEqual({
      ...payload,
      local_uri: "file:///docs/outbox-media/a.jpg",
      device_media: [
        { storage_path: "b.png", local_uri: "file:///docs/outbox-media/b.png" },
        { storage_path: "sig.png", local_uri: "data:image/png;base64,AAAA" },
        { local_uri: "file:///cache/no-path.jpg" },
      ],
    });
    expect(queuedMediaUris({ note: "no files" })).toEqual([]);
    expect(withMediaUris({ id: "x" }, moved)).toEqual({ id: "x" });
  });

  it("encodes Upload-Metadata as Supabase reads it", () => {
    expect(base64("field-media")).toBe(Buffer.from("field-media").toString("base64"));
    expect(base64("añ/ü.jpg")).toBe(Buffer.from("añ/ü.jpg").toString("base64"));
    expect(base64("ab")).toBe("YWI=");
    expect(uploadMetadata("b", "o", "image/png")).toBe(
      `bucketName ${base64("b")},objectName ${base64("o")},contentType ${base64("image/png")},cacheControl ${base64("3600")}`,
    );
  });
});
