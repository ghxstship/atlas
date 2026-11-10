import { describe, expect, it } from "vitest";
import {
  dropboxProvider,
  googleDriveProvider,
  MAX_IMPORT_BYTES,
  mimeFromName,
  oneDriveProvider,
  storageConnector,
  storageConnectors,
  supabaseBlobStore,
  supabaseStorageSource,
  type BlobStore,
  type FileLink,
  type FileMeta,
  type StorageSource,
} from "../src/connectors/storage/index.ts";
import { StoreError } from "../src/framework/db.ts";
import { sha256Hex } from "../src/framework/support.ts";
import { bodyOf, contextFor, memoryStore, okData, recordingDb, scriptedHttp } from "./doubles.ts";

const run = { scope: "File Import" as const, direction: "Inbound" as const };
const fileBytes = new TextEncoder().encode("%PDF-1.7 stage plot");

const link = (overrides: Partial<FileLink> = {}): FileLink => ({
  id: "link-1",
  documentId: "doc-1",
  mode: "Import",
  externalFileId: "drv-1",
  externalVersion: null,
  importedVersion: null,
  ...overrides,
});

function source(links: FileLink[], overrides: Partial<StorageSource> = {}) {
  const refreshed: FileMeta[] = [];
  const finished: unknown[][] = [];
  const value: StorageSource = {
    links: async () => links,
    refresh: async (_id, meta) => {
      refreshed.push(meta);
    },
    beginImport: async () => ({ objectName: "org/att/ver/Stage Plot.pdf" }),
    finishImport: async (...args) => {
      finished.push(args);
      return "Scanning";
    },
    storeCredential: async () => undefined,
    ...overrides,
  };
  return { value, refreshed, finished };
}

function blobs() {
  const stored: { bucket: string; objectName: string; size: number; type: string }[] = [];
  const store: BlobStore = {
    put: async (bucket, objectName, bytes, type) => {
      stored.push({ bucket, objectName, size: bytes.byteLength, type });
    },
  };
  return { store, stored };
}

const driveFile = (overrides: Record<string, unknown> = {}) => ({
  id: "drv-1",
  name: "Stage Plot.pdf",
  mimeType: "application/pdf",
  size: String(fileBytes.byteLength),
  webViewLink: "https://drive.google.com/file/d/drv-1",
  version: "7",
  modifiedTime: "2027-05-01T10:00:00Z",
  ...overrides,
});

describe("Google Drive", () => {
  it("refreshes metadata and imports a new revision through the attachment pipeline", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://www.googleapis.com/drive/v3/files/drv-1?alt=media",
        respond: () => ({ bytes: fileBytes }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/drv-1?fields",
        respond: () => ({ json: driveFile() }),
      },
    ]);
    const s = source([link()]);
    const b = blobs();
    const outcome = await storageConnector(googleDriveProvider, s.value, b.store).sync(
      contextFor("google_drive", { http, store: memoryStore().store, run }),
    );
    expect(s.refreshed[0]).toMatchObject({
      name: "Stage Plot.pdf",
      mimeType: "application/pdf",
      sizeBytes: fileBytes.byteLength,
      version: "7",
      folder: false,
    });
    expect(requests[1]?.responseType).toBe("bytes");
    expect(b.stored).toEqual([
      {
        bucket: "attachments",
        objectName: "org/att/ver/Stage Plot.pdf",
        size: fileBytes.byteLength,
        type: "application/pdf",
      },
    ]);
    expect(s.finished).toEqual([["link-1", sha256Hex(fileBytes), "7"]]);
    expect(outcome).toEqual({
      counts: { read: 1, written: 1, skipped: 0, failed: 0 },
      cursorAfter: null,
    });
  });

  it("exports Google-native documents to PDF and skips unchanged links", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://www.googleapis.com/drive/v3/files/doc-9/export",
        respond: () => ({ bytes: fileBytes }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/doc-9?fields",
        respond: () => ({
          json: driveFile({
            id: "doc-9",
            name: "Run of Show",
            mimeType: "application/vnd.google-apps.document",
            size: undefined,
          }),
        }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/drv-1?fields",
        respond: () => ({ json: driveFile() }),
      },
    ]);
    const s = source([
      link({ externalFileId: "doc-9" }),
      link({ id: "link-2", mode: "Link", externalVersion: "7" }),
      link({ id: "link-3", externalVersion: "7", importedVersion: "7" }),
    ]);
    const outcome = await storageConnector(googleDriveProvider, s.value, blobs().store).sync(
      contextFor("google_drive", { http, store: memoryStore().store, run }),
    );
    expect(requests.find((r) => r.url.includes("/export"))?.url).toContain(
      "mimeType=application%2Fpdf",
    );
    expect(s.refreshed[0]).toMatchObject({
      name: "Run of Show.pdf",
      mimeType: "application/pdf",
      exportedFrom: "application/vnd.google-apps.document",
    });
    expect(outcome.counts).toEqual({ read: 3, written: 1, skipped: 2, failed: 0 });
  });

  it("records missing, oversized, folder and refused files as item errors", async () => {
    const { http } = scriptedHttp([
      {
        match: "GET https://www.googleapis.com/drive/v3/files/gone",
        respond: () => ({ status: 404 }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/trashed",
        respond: () => ({ json: driveFile({ id: "trashed", trashed: true }) }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/big",
        respond: () => ({ json: driveFile({ id: "big", size: String(MAX_IMPORT_BYTES + 1) }) }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/folder",
        respond: () => ({
          json: driveFile({
            id: "folder",
            mimeType: "application/vnd.google-apps.folder",
            size: undefined,
          }),
        }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/svg",
        respond: () => ({
          json: driveFile({ id: "svg", name: "Logo.svg", mimeType: "image/svg+xml" }),
        }),
      },
    ]);
    const s = source(
      ["gone", "trashed", "big", "folder", "svg"].map((id) => link({ id, externalFileId: id })),
      {
        beginImport: () =>
          Promise.reject(
            new StoreError({
              kind: "refusal",
              rule: "attachment_type",
              message: "The bucket does not accept this type.",
            }),
          ),
      },
    );
    const memory = memoryStore();
    const outcome = await storageConnector(googleDriveProvider, s.value, blobs().store).sync(
      contextFor("google_drive", { http, store: memory.store, run }),
    );
    expect(memory.itemErrors.map((e) => e.code)).toEqual([
      "provider_file_missing",
      "provider_file_missing",
      "file_too_large",
      "file_is_folder",
      "attachment_type",
    ]);
    expect(memory.itemErrors[0]?.ref).toEqual({
      entity: "Document",
      localId: "doc-1",
      externalId: "gone",
    });
    expect(outcome.counts.failed).toBe(5);
    const broken = source([link()], { beginImport: () => Promise.reject(new Error("db down")) });
    const ok = scriptedHttp([
      { match: "GET https://www.googleapis.com", respond: () => ({ json: driveFile() }) },
    ]);
    await expect(
      storageConnector(googleDriveProvider, broken.value, blobs().store).sync(
        contextFor("google_drive", { http: ok.http, store: memory.store, run }),
      ),
    ).rejects.toThrow("db down");
    const denied = scriptedHttp([
      { match: "GET https://www.googleapis.com", respond: () => ({ status: 401 }) },
    ]);
    await expect(
      storageConnector(googleDriveProvider, source([link()]).value, blobs().store).sync(
        contextFor("google_drive", { http: denied.http, store: memory.store, run }),
      ),
    ).rejects.toMatchObject({ code: "credential_refused" });
  });

  it("refuses a download larger than the cap even when the provider understated it", async () => {
    const huge = new Uint8Array(MAX_IMPORT_BYTES + 1);
    const { http } = scriptedHttp([
      {
        match: "GET https://www.googleapis.com/drive/v3/files/drv-1?alt=media",
        respond: () => ({ bytes: huge }),
      },
      {
        match: "GET https://www.googleapis.com/drive/v3/files/drv-1?fields",
        respond: () => ({ json: driveFile({ size: "10" }) }),
      },
    ]);
    const memory = memoryStore();
    const b = blobs();
    await storageConnector(googleDriveProvider, source([link()]).value, b.store).sync(
      contextFor("google_drive", { http, store: memory.store, run }),
    );
    expect(memory.itemErrors[0]?.code).toBe("file_too_large");
    expect(b.stored).toHaveLength(0);
  });

  it("lists a folder for the link picker", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://www.googleapis.com/drive/v3/files?q=",
        respond: () => ({
          json: {
            files: [
              driveFile(),
              driveFile({
                id: "f",
                name: "Plans",
                mimeType: "application/vnd.google-apps.folder",
                size: undefined,
                version: undefined,
                modifiedTime: undefined,
                webViewLink: undefined,
              }),
            ],
          },
        }),
      },
    ]);
    const context = contextFor("google_drive", { http, store: memoryStore().store, run });
    const files = await googleDriveProvider.listFolder(context, "fold'er");
    expect(decodeURIComponent(requests[0]?.url ?? "")).toContain("'fold\\'er' in parents");
    expect(files[1]).toMatchObject({ folder: true, version: "f", sizeBytes: null, webUrl: null });
    await googleDriveProvider.listFolder(context, null);
    expect(decodeURIComponent(requests[1]?.url ?? "")).toContain("'root' in parents");
    await expect(
      googleDriveProvider.listFolder({ ...context, credential: null }, null),
    ).rejects.toMatchObject({ code: "credential_required" });
  });
});

describe("OneDrive and SharePoint", () => {
  it("follows the pre-authorized download redirect without sending the token on", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/b!drive/items/item-1/content",
        respond: () => ({
          status: 302,
          headers: { location: "https://download.sharepoint.example.com/file?sig=1" },
        }),
      },
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/b!drive/items/item-1",
        respond: () => ({
          json: {
            id: "item-1",
            name: "Rigging.docx",
            size: 20,
            webUrl: "https://contoso.sharepoint.com/Rigging.docx",
            cTag: "c1",
            lastModifiedDateTime: "2027-05-01T00:00:00Z",
            file: {},
            parentReference: { driveId: "b!drive" },
          },
        }),
      },
      {
        match: "GET https://download.sharepoint.example.com/file",
        respond: () => ({ bytes: fileBytes }),
      },
    ]);
    const s = source([link({ externalFileId: "b!drive/item-1" })]);
    await storageConnector(oneDriveProvider, s.value, blobs().store).sync(
      contextFor("onedrive_sharepoint", { http, store: memoryStore().store, run }),
    );
    expect(s.refreshed[0]).toMatchObject({
      externalFileId: "b!drive/item-1",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      version: "c1",
    });
    expect(requests[2]?.headers).toBeUndefined();
    expect(s.finished).toHaveLength(1);
  });

  it("treats deleted items as missing and refuses odd ids and redirects", async () => {
    const { http } = scriptedHttp([
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/d/items/gone",
        respond: () => ({ status: 404 }),
      },
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/d/items/deleted",
        respond: () => ({ json: { id: "deleted", name: "x", deleted: {} } }),
      },
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/d/items/bad/content",
        respond: () => ({ status: 302, headers: { location: "http://insecure.example.com" } }),
      },
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/d/items/nobytes/content",
        respond: () => ({ status: 200 }),
      },
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/d/items/",
        respond: (r) => ({
          json: { id: r.url.split("/").pop(), name: "a.pdf", size: 3, eTag: "e" },
        }),
      },
    ]);
    const memory = memoryStore();
    await storageConnector(
      oneDriveProvider,
      source([link({ externalFileId: "d/gone" }), link({ externalFileId: "d/deleted" })]).value,
      blobs().store,
    ).sync(contextFor("onedrive_sharepoint", { http, store: memory.store, run }));
    expect(memory.itemErrors.map((e) => e.code)).toEqual([
      "provider_file_missing",
      "provider_file_missing",
    ]);
    await expect(
      storageConnector(
        oneDriveProvider,
        source([link({ externalFileId: "no-slash" })]).value,
        blobs().store,
      ).sync(contextFor("onedrive_sharepoint", { http, store: memory.store, run })),
    ).rejects.toMatchObject({ code: "file_id_malformed" });
    await expect(
      storageConnector(
        oneDriveProvider,
        source([link({ externalFileId: "d/bad" })]).value,
        blobs().store,
      ).sync(contextFor("onedrive_sharepoint", { http, store: memory.store, run })),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
    await expect(
      storageConnector(
        oneDriveProvider,
        source([link({ externalFileId: "d/nobytes" })]).value,
        blobs().store,
      ).sync(contextFor("onedrive_sharepoint", { http, store: memory.store, run })),
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
    const down = scriptedHttp([
      { match: "GET https://graph.microsoft.com", respond: () => ({ status: 503 }) },
    ]);
    await expect(
      storageConnector(
        oneDriveProvider,
        source([link({ externalFileId: "d/x" })]).value,
        blobs().store,
      ).sync(contextFor("onedrive_sharepoint", { http: down.http, store: memory.store, run })),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("lists the configured drive", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://graph.microsoft.com/v1.0/drives/d1/",
        respond: () => ({ json: { value: [{ id: "i1", name: "Plans", folder: {} }] } }),
      },
    ]);
    const context = contextFor("onedrive_sharepoint", {
      http,
      store: memoryStore().store,
      run,
      settings: { drive_id: "d1" },
    });
    expect((await oneDriveProvider.listFolder(context, null))[0]).toMatchObject({
      externalFileId: "d1/i1",
      folder: true,
    });
    await oneDriveProvider.listFolder(context, "d1/i1");
    expect(requests.map((r) => r.url)).toEqual([
      "https://graph.microsoft.com/v1.0/drives/d1/root/children?$top=200",
      "https://graph.microsoft.com/v1.0/drives/d1/items/i1/children?$top=200",
    ]);
    await expect(
      oneDriveProvider.listFolder(
        contextFor("onedrive_sharepoint", { http, store: memoryStore().store, run }),
        null,
      ),
    ).rejects.toMatchObject({ code: "setting_missing" });
  });
});

describe("Dropbox", () => {
  it("reads metadata, downloads with the API argument header and lists folders", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://api.dropboxapi.com/2/files/get_metadata",
        respond: (r) =>
          (bodyOf(r) as { path: string }).path === "id:gone"
            ? { status: 409, body: '{"error_summary":"path/not_found/"}' }
            : {
                json: {
                  ".tag": "file",
                  id: "id:abc",
                  name: "Site Plan.pdf",
                  size: 19,
                  rev: "r1",
                  content_hash: "h1",
                  server_modified: "2027-05-01T00:00:00Z",
                  path_display: "/Shows/Site Plan.pdf",
                },
              },
      },
      {
        match: "POST https://content.dropboxapi.com/2/files/download",
        respond: () => ({ bytes: fileBytes }),
      },
      {
        match: "POST https://api.dropboxapi.com/2/files/list_folder",
        respond: () => ({
          json: {
            entries: [
              { ".tag": "folder", name: "Shows", path_display: "/Shows" },
              { ".tag": "deleted", name: "old" },
            ],
          },
        }),
      },
    ]);
    const s = source([
      link({ externalFileId: "id:abc" }),
      link({ id: "l2", externalFileId: "id:gone" }),
    ]);
    const memory = memoryStore();
    await storageConnector(dropboxProvider, s.value, blobs().store).sync(
      contextFor("dropbox", { http, store: memory.store, run }),
    );
    expect(s.refreshed[0]).toMatchObject({
      mimeType: "application/pdf",
      version: "h1",
      webUrl: "https://www.dropbox.com/home/Shows?preview=Site%20Plan.pdf",
    });
    expect(
      JSON.parse(
        requests.find((r) => r.url.includes("download"))?.headers?.["dropbox-api-arg"] ?? "{}",
      ),
    ).toEqual({ path: "id:abc" });
    expect(memory.itemErrors.map((e) => e.code)).toEqual(["provider_file_missing"]);
    const listed = await dropboxProvider.listFolder(
      contextFor("dropbox", { http, store: memory.store, run }),
      null,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ externalFileId: "/Shows", folder: true, version: "Shows" });
    const deleted = scriptedHttp([
      {
        match: "POST https://api.dropboxapi.com",
        respond: () => ({ json: { ".tag": "deleted", name: "x" } }),
      },
    ]);
    expect(
      await dropboxProvider.metadata(
        contextFor("dropbox", { http: deleted.http, store: memory.store, run }),
        "id:x",
      ),
    ).toBeNull();
    const conflict = scriptedHttp([
      {
        match: "POST https://api.dropboxapi.com",
        respond: () => ({ status: 409, body: "path/malformed_path" }),
      },
    ]);
    await expect(
      dropboxProvider.metadata(
        contextFor("dropbox", { http: conflict.http, store: memory.store, run }),
        "x",
      ),
    ).rejects.toMatchObject({ code: "provider_conflict" });
  });
});

describe("storage support", () => {
  it("guesses types from names", () => {
    expect(mimeFromName("Budget.XLSX")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mimeFromName("noextension")).toBe("application/octet-stream");
    expect(mimeFromName("thing.weird")).toBe("application/octet-stream");
  });

  it("reads links and calls the import RPCs", async () => {
    const { db, calls } = recordingDb({
      "from:integration_file_links": [
        okData([
          {
            id: "l",
            document_id: "d",
            link_mode: "Import",
            external_file_id: "f",
            external_version: null,
            imported_version: null,
          },
        ]),
      ],
      "rpc:refresh_file_link": [okData(null)],
      "rpc:begin_file_import": [okData([{ object_name: "o" }]), okData([])],
      "rpc:finish_file_import": [okData("Scanning")],
    });
    const s = supabaseStorageSource(db);
    expect(await s.links("c")).toEqual([
      {
        id: "l",
        documentId: "d",
        mode: "Import",
        externalFileId: "f",
        externalVersion: null,
        importedVersion: null,
      },
    ]);
    await s.refresh("l", {
      externalFileId: "f",
      name: "n",
      mimeType: "m",
      sizeBytes: 1,
      webUrl: null,
      version: "v",
      modifiedAt: null,
      folder: false,
    });
    expect(await s.beginImport("l")).toEqual({ objectName: "o" });
    await expect(s.beginImport("l")).rejects.toMatchObject({ code: "file_import_not_started" });
    expect(await s.finishImport("l", "c", "v")).toBe("Scanning");
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        p_link_id: "l",
        p_file_name: "n",
        p_mime_type: "m",
        p_size_bytes: 1,
        p_web_url: null,
        p_external_version: "v",
        p_external_modified_at: null,
      },
    ]);
    expect(storageConnectors(s, blobs().store).map((c) => c.provider)).toEqual([
      "google_drive",
      "onedrive_sharepoint",
      "dropbox",
    ]);
  });

  it("stores bytes through a storage client and reports failures", async () => {
    const uploads: unknown[] = [];
    let fail = false;
    const store = supabaseBlobStore({
      from: (bucket) => ({
        upload: async (path, body, options) => {
          uploads.push([bucket, path, body.byteLength, options]);
          return { error: fail ? { message: "quota" } : null };
        },
      }),
    });
    await store.put("attachments", "o", fileBytes, "application/pdf");
    expect(uploads).toEqual([
      ["attachments", "o", fileBytes.byteLength, { contentType: "application/pdf", upsert: false }],
    ]);
    fail = true;
    await expect(store.put("attachments", "o", fileBytes, "application/pdf")).rejects.toMatchObject(
      { code: "blob_store_failed", retryable: true },
    );
  });
});
