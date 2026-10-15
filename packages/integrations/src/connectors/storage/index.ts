import type { ProviderCode } from "../../framework/catalog.ts";
import { ItemTally, type Connector, type SyncContext } from "../../framework/connector.ts";
import { StoreError, unwrap, type DbClient } from "../../framework/db.ts";
import { errorForStatus, IntegrationError } from "../../framework/errors.ts";
import { callJson, type HttpRequest } from "../../framework/http.ts";
import { sha256Hex } from "../../framework/support.ts";

/** The attachments bucket cap (migration 0590): imports larger than this are refused before download. */
export const MAX_IMPORT_BYTES = 52_428_800;

export interface FileLink {
  readonly id: string;
  readonly documentId: string;
  readonly mode: "Link" | "Import";
  readonly externalFileId: string;
  readonly externalVersion: string | null;
  readonly importedVersion: string | null;
}

/** File metadata as a provider reports it, normalized. */
export interface FileMeta {
  readonly externalFileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly webUrl: string | null;
  readonly version: string;
  readonly modifiedAt: string | null;
  readonly folder: boolean;
  /** The provider-native type a file is exported from (Google Docs), when it has no bytes of its own. */
  readonly exportedFrom?: string;
}

export interface StorageSource {
  links(connectionId: string): Promise<readonly FileLink[]>;
  refresh(linkId: string, meta: FileMeta): Promise<void>;
  beginImport(linkId: string): Promise<{ readonly objectName: string }>;
  finishImport(linkId: string, checksum: string, version: string): Promise<string>;
}

/** Where imported bytes are stored: the private attachments bucket (Supabase Storage in production). */
export interface BlobStore {
  put(bucket: string, objectName: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface StorageProvider {
  readonly provider: ProviderCode;
  readonly label: string;
  /** Null when the file no longer exists or is in the trash. */
  metadata(context: SyncContext, externalFileId: string): Promise<FileMeta | null>;
  download(context: SyncContext, file: FileMeta): Promise<Uint8Array>;
  /** Files and folders inside a folder, for the link picker. */
  listFolder(context: SyncContext, folderId: string | null): Promise<readonly FileMeta[]>;
}

function token(context: SyncContext): string {
  if (context.credential === null) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  return context.credential.token;
}

const TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  zip: "application/zip",
  svg: "image/svg+xml",
};

/** MIME type from a file name's extension, for providers that do not report one. */
export function mimeFromName(name: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (extension && TYPES[extension]) ?? "application/octet-stream";
}

async function bytesOf(
  context: SyncContext,
  provider: string,
  request: HttpRequest,
): Promise<Uint8Array> {
  const response = await context.http({ ...request, responseType: "bytes" });
  if (response.status === 302 || response.status === 301 || response.status === 307) {
    const location = response.headers["location"];
    if (location === undefined || !location.startsWith("https://")) {
      throw new IntegrationError(
        "provider_malformed_response",
        `${provider} redirected the download somewhere other than HTTPS.`,
      );
    }
    // The download URL is pre-authorized; the bearer token is not sent to another host.
    return bytesOf(context, provider, { method: "GET", url: location });
  }
  const failure = errorForStatus(provider, response.status, response.body);
  if (failure) throw failure;
  if (response.bytes === undefined)
    throw new IntegrationError("provider_malformed_response", `${provider} sent no file content.`);
  return response.bytes;
}

// Google Drive ----------------------------------------------------------------------------------------------------------

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_FIELDS = "id,name,mimeType,size,webViewLink,version,modifiedTime,trashed";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  version?: string;
  modifiedTime?: string;
  trashed?: boolean;
}

/** Google-native documents have no bytes of their own; they are exported to these types. */
const DRIVE_EXPORTS: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "application/pdf",
  "application/vnd.google-apps.spreadsheet":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.presentation": "application/pdf",
  "application/vnd.google-apps.drawing": "application/pdf",
};

function driveMeta(file: DriveFile): FileMeta {
  const exported = DRIVE_EXPORTS[file.mimeType];
  return {
    externalFileId: file.id,
    name:
      exported === "application/pdf" && !file.name.endsWith(".pdf")
        ? `${file.name}.pdf`
        : file.name,
    mimeType: exported ?? file.mimeType,
    sizeBytes: file.size === undefined ? null : Number(file.size),
    webUrl: file.webViewLink ?? null,
    version: file.version ?? file.modifiedTime ?? file.id,
    modifiedAt: file.modifiedTime ?? null,
    folder: file.mimeType === "application/vnd.google-apps.folder",
    ...(exported ? { exportedFrom: file.mimeType } : {}),
  };
}

export const googleDriveProvider: StorageProvider = {
  provider: "google_drive",
  label: "Google Drive",
  async metadata(context, externalFileId) {
    try {
      const file = await callJson<DriveFile>(context.http, "Google Drive", {
        method: "GET",
        url: `${DRIVE}/files/${encodeURIComponent(externalFileId)}?fields=${DRIVE_FIELDS}&supportsAllDrives=true`,
        token: token(context),
      });
      return file.trashed ? null : driveMeta(file);
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "provider_not_found") return null;
      throw error;
    }
  },
  async download(context, file) {
    const url =
      file.exportedFrom !== undefined
        ? `${DRIVE}/files/${encodeURIComponent(file.externalFileId)}/export?mimeType=${encodeURIComponent(file.mimeType)}`
        : `${DRIVE}/files/${encodeURIComponent(file.externalFileId)}?alt=media&supportsAllDrives=true`;
    return bytesOf(context, "Google Drive", {
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token(context)}` },
    });
  },
  async listFolder(context, folderId) {
    const q = `'${(folderId ?? "root").replace(/'/g, "\\'")}' in parents and trashed = false`;
    const page = await callJson<{ files: DriveFile[] }>(context.http, "Google Drive", {
      method: "GET",
      url: `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${DRIVE_FIELDS})`)}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      token: token(context),
    });
    return page.files.map(driveMeta);
  },
};

// OneDrive and SharePoint ---------------------------------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { driveId?: string };
}

/** OneDrive and SharePoint files are addressed as "<drive id>/<item id>". */
function splitItem(externalFileId: string): { drive: string; item: string } {
  const [drive, item] = externalFileId.split("/");
  if (!drive || !item)
    throw new IntegrationError(
      "file_id_malformed",
      `${externalFileId} is not a <drive>/<item> id.`,
    );
  return { drive, item };
}

function graphMeta(item: DriveItem, drive: string): FileMeta {
  return {
    externalFileId: `${item.parentReference?.driveId ?? drive}/${item.id}`,
    name: item.name,
    mimeType: item.file?.mimeType ?? mimeFromName(item.name),
    sizeBytes: item.size ?? null,
    webUrl: item.webUrl ?? null,
    version: item.cTag ?? item.eTag ?? item.lastModifiedDateTime ?? item.id,
    modifiedAt: item.lastModifiedDateTime ?? null,
    folder: item.folder !== undefined,
  };
}

export const oneDriveProvider: StorageProvider = {
  provider: "onedrive_sharepoint",
  label: "OneDrive and SharePoint",
  async metadata(context, externalFileId) {
    const { drive, item } = splitItem(externalFileId);
    try {
      const found = await callJson<DriveItem>(context.http, "Microsoft OneDrive", {
        method: "GET",
        url: `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}`,
        token: token(context),
      });
      return found.deleted !== undefined ? null : graphMeta(found, drive);
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "provider_not_found") return null;
      throw error;
    }
  },
  async download(context, file) {
    const { drive, item } = splitItem(file.externalFileId);
    return bytesOf(context, "Microsoft OneDrive", {
      method: "GET",
      url: `${GRAPH}/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}/content`,
      headers: { authorization: `Bearer ${token(context)}` },
    });
  },
  async listFolder(context, folderId) {
    const drive = context.connection.settings["drive_id"];
    if (typeof drive !== "string" || drive.length === 0) {
      throw new IntegrationError("setting_missing", "The connection needs the drive_id setting.");
    }
    const path =
      folderId === null ? "root" : `items/${encodeURIComponent(splitItem(folderId).item)}`;
    const page = await callJson<{ value: DriveItem[] }>(context.http, "Microsoft OneDrive", {
      method: "GET",
      url: `${GRAPH}/drives/${encodeURIComponent(drive)}/${path}/children?$top=200`,
      token: token(context),
    });
    return page.value.map((i) => graphMeta(i, drive));
  },
};

// Dropbox ---------------------------------------------------------------------------------------------------------------

interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  id?: string;
  name: string;
  size?: number;
  rev?: string;
  content_hash?: string;
  server_modified?: string;
  path_display?: string;
}

function dropboxMeta(entry: DropboxEntry): FileMeta {
  return {
    externalFileId: entry.id ?? entry.path_display ?? entry.name,
    name: entry.name,
    mimeType: mimeFromName(entry.name),
    sizeBytes: entry.size ?? null,
    webUrl: entry.path_display
      ? `https://www.dropbox.com/home${entry.path_display.split("/").slice(0, -1).map(encodeURIComponent).join("/")}?preview=${encodeURIComponent(entry.name)}`
      : null,
    version: entry.content_hash ?? entry.rev ?? entry.name,
    modifiedAt: entry.server_modified ?? null,
    folder: entry[".tag"] === "folder",
  };
}

export const dropboxProvider: StorageProvider = {
  provider: "dropbox",
  label: "Dropbox",
  async metadata(context, externalFileId) {
    try {
      const entry = await callJson<DropboxEntry>(context.http, "Dropbox", {
        method: "POST",
        url: "https://api.dropboxapi.com/2/files/get_metadata",
        token: token(context),
        json: { path: externalFileId, include_deleted: true },
      });
      return entry[".tag"] === "deleted" ? null : dropboxMeta(entry);
    } catch (error) {
      // Dropbox answers 409 path/not_found for a file that is gone.
      if (
        error instanceof IntegrationError &&
        error.status === 409 &&
        error.message.includes("not_found")
      )
        return null;
      throw error;
    }
  },
  async download(context, file) {
    return bytesOf(context, "Dropbox", {
      method: "POST",
      url: "https://content.dropboxapi.com/2/files/download",
      headers: {
        authorization: `Bearer ${token(context)}`,
        "dropbox-api-arg": JSON.stringify({ path: file.externalFileId }),
      },
    });
  },
  async listFolder(context, folderId) {
    const page = await callJson<{ entries: DropboxEntry[] }>(context.http, "Dropbox", {
      method: "POST",
      url: "https://api.dropboxapi.com/2/files/list_folder",
      token: token(context),
      json: { path: folderId ?? "", limit: 200 },
    });
    return page.entries.filter((e) => e[".tag"] !== "deleted").map(dropboxMeta);
  },
};

// Connector ------------------------------------------------------------------------------------------------------------------

/** Keeps linked files current and imports new revisions of Import links through the scanned attachment pipeline. */
export function storageConnector(
  provider: StorageProvider,
  source: StorageSource,
  blobs: BlobStore,
): Connector {
  return {
    provider: provider.provider,
    scopes: ["File Import"],
    async sync(context) {
      const tally = new ItemTally(context);
      for (const link of await source.links(context.connection.id)) {
        tally.read += 1;
        const ref = {
          entity: "Document" as const,
          localId: link.documentId,
          externalId: link.externalFileId,
        };
        const meta = await provider.metadata(context, link.externalFileId);
        if (meta === null) {
          await tally.fail(
            "provider_file_missing",
            `${provider.label} no longer has this file.`,
            ref,
          );
          continue;
        }
        const needsImport = link.mode === "Import" && link.importedVersion !== meta.version;
        if (meta.version === link.externalVersion && !needsImport) {
          tally.skipped += 1;
          continue;
        }
        await source.refresh(link.id, meta);
        if (needsImport) {
          if (meta.folder) {
            await tally.fail(
              "file_is_folder",
              "A folder cannot be imported as a document version.",
              ref,
            );
            continue;
          }
          if (meta.sizeBytes !== null && meta.sizeBytes > MAX_IMPORT_BYTES) {
            await tally.fail(
              "file_too_large",
              "The file is larger than the 50 MiB attachment limit.",
              ref,
            );
            continue;
          }
          let objectName: string;
          try {
            ({ objectName } = await source.beginImport(link.id));
          } catch (error) {
            if (!(error instanceof StoreError && error.error.kind === "refusal")) throw error;
            await tally.fail(error.error.rule, error.error.message, ref);
            continue;
          }
          const bytes = await provider.download(context, meta);
          if (bytes.byteLength > MAX_IMPORT_BYTES) {
            await tally.fail(
              "file_too_large",
              "The file is larger than the 50 MiB attachment limit.",
              ref,
            );
            continue;
          }
          await blobs.put("attachments", objectName, bytes, meta.mimeType);
          await source.finishImport(link.id, sha256Hex(bytes), meta.version);
        }
        tally.written += 1;
      }
      return { counts: tally.counts(), cursorAfter: null };
    },
  };
}

export function storageConnectors(source: StorageSource, blobs: BlobStore): Connector[] {
  return [googleDriveProvider, oneDriveProvider, dropboxProvider].map((p) =>
    storageConnector(p, source, blobs),
  );
}

interface LinkRow {
  id: string;
  document_id: string;
  link_mode: "Link" | "Import";
  external_file_id: string;
  external_version: string | null;
  imported_version: string | null;
}

export function supabaseStorageSource(db: DbClient): StorageSource {
  return {
    async links(connectionId) {
      const rows = await unwrap<LinkRow[]>(
        db
          .from("integration_file_links")
          .select(
            "id, document_id, link_mode, external_file_id, external_version, imported_version",
          )
          .eq("integration_connection_id", connectionId)
          .is("deleted_at", null)
          .order("created_at"),
      );
      return rows.map((r) => ({
        id: r.id,
        documentId: r.document_id,
        mode: r.link_mode,
        externalFileId: r.external_file_id,
        externalVersion: r.external_version,
        importedVersion: r.imported_version,
      }));
    },
    async refresh(linkId, meta) {
      await unwrap(
        db.rpc("refresh_file_link", {
          p_link_id: linkId,
          p_file_name: meta.name,
          p_mime_type: meta.mimeType,
          p_size_bytes: meta.sizeBytes,
          p_web_url: meta.webUrl,
          p_external_version: meta.version,
          p_external_modified_at: meta.modifiedAt,
        }),
      );
    },
    async beginImport(linkId) {
      const rows = await unwrap<{ object_name: string }[]>(
        db.rpc("begin_file_import", { p_link_id: linkId }),
      );
      const row = rows[0];
      if (row === undefined)
        throw new IntegrationError(
          "file_import_not_started",
          "The import did not return an object name.",
        );
      return { objectName: row.object_name };
    },
    async finishImport(linkId, checksum, version) {
      return unwrap<string>(
        db.rpc("finish_file_import", {
          p_link_id: linkId,
          p_checksum_sha256: checksum,
          p_imported_version: version,
        }),
      );
    },
  };
}

/** Stores imported bytes through a Supabase Storage client (service role, so the issued object name is writable). */
export function supabaseBlobStore(storage: {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array,
      options: { contentType: string; upsert: boolean },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}): BlobStore {
  return {
    async put(bucket, objectName, bytes, contentType) {
      const { error } = await storage
        .from(bucket)
        .upload(objectName, bytes, { contentType, upsert: false });
      if (error)
        throw new IntegrationError(
          "blob_store_failed",
          `Storing the file failed: ${error.message}`,
          { retryable: true },
        );
    },
  };
}
