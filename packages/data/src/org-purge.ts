import type { SupabaseClient } from "@supabase/supabase-js";
import { deletionCertificateFileName } from "./documents/deletion-certificate-name.ts";
import type { DeletionCertificateData } from "./documents/deletion-certificate.ts";
import { DELETION_CERTIFICATES_BUCKET } from "./org-lifecycle.ts";
import type { ReportMailer } from "./report-deliveries.ts";

/**
 * The org-lifecycle worker's share of the day-90 deletion (A79, migration 1351; Section 14.7). The lifecycle
 * job writes a certificate for each org due and deletes its rows once its storage is clear; this worker does
 * what SQL cannot:
 *   1. deletes the org's storage objects through the Storage API (SQL deletes of storage.objects are refused),
 *      in batches of 100 names per bucket, as the demo removal does (infra/production/src/storage.ts), and
 *      records that none remain;
 *   2. once the rows are purged, renders the certificate PDF (ADR 0031), stores it in the private
 *      deletion-certificates bucket and records its SHA-256;
 *   3. emails it to the former Owner.
 * Every step is idempotent: a certificate claimed again resumes where it stopped. Every outside call goes
 * through a port, so the tests use fakes.
 */

export { DELETION_CERTIFICATES_BUCKET };
export const STORAGE_BATCH = 100;

export interface ClaimedCertificate extends DeletionCertificateData {
  readonly ownerEmail: string | null;
  readonly locale: string;
  readonly storageClearedAt: string | null;
  readonly issuedAt: string | null;
  readonly documentObject: string | null;
  readonly deliveredAt: string | null;
  /** True once every row of the org was deleted. */
  readonly purged: boolean;
}

export interface StorageObjectRef {
  readonly bucket: string;
  readonly name: string;
}

export interface PurgeStore {
  claim(worker: string, limit: number): Promise<readonly ClaimedCertificate[]>;
  storageObjects(certificateId: string): Promise<readonly StorageObjectRef[]>;
  recordStorageCleared(certificateId: string, deleted: number): Promise<boolean>;
  recordIssued(certificateId: string, objectName: string, sha256: string): Promise<void>;
  recordDelivered(certificateId: string, messageId: string): Promise<void>;
  release(certificateId: string, error: string): Promise<void>;
}

export interface PurgeStorage {
  /** Deletes objects of one bucket through the Storage API; returns how many it deleted. */
  remove(bucket: string, names: readonly string[]): Promise<number>;
  upload(bucket: string, name: string, bytes: Uint8Array, contentType: string): Promise<void>;
  download(bucket: string, name: string): Promise<Uint8Array>;
}

export type CertificateRenderer = (
  certificate: ClaimedCertificate,
) => Promise<{ readonly bytes: Uint8Array; readonly fileName: string }>;

export interface CertificateEmailCopy {
  subject(input: { readonly org: string }): string;
  text(input: { readonly org: string; readonly date: string; readonly id: string }): string;
  /** An instant as a date on the deleted org's calendar. */
  date(iso: string, timeZone: string): string;
}

export type CertificateCopy = (locale: string) => CertificateEmailCopy;

export type CertificateOutcome =
  "storage-cleared" | "storage-pending" | "issued" | "delivered" | "no-address" | "failed";

export interface CertificateResult {
  readonly id: string;
  readonly outcome: CertificateOutcome;
  readonly deleted?: number;
  readonly error?: string;
}

/** Groups objects by bucket into requests of at most `size` names. */
export function batchObjects(
  objects: readonly StorageObjectRef[],
  size = STORAGE_BATCH,
): StorageObjectRef[][] {
  const byBucket = new Map<string, StorageObjectRef[]>();
  for (const o of objects) {
    const group = byBucket.get(o.bucket) ?? [];
    group.push(o);
    byBucket.set(o.bucket, group);
  }
  const batches: StorageObjectRef[][] = [];
  for (const bucket of [...byBucket.keys()].sort()) {
    const group = byBucket.get(bucket) ?? [];
    for (let i = 0; i < group.length; i += size) batches.push(group.slice(i, i + size));
  }
  return batches;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Object name of a certificate PDF in the bucket. */
export function certificateObjectName(certificateId: string): string {
  return `${certificateId}.pdf`;
}

/** Deletes the org's storage objects through the Storage API until none are listed, or no progress is made. */
async function clearStorage(
  store: PurgeStore,
  storage: PurgeStorage,
  id: string,
): Promise<{ deleted: number; clear: boolean }> {
  let deleted = 0;
  for (let round = 0; round < 50; round += 1) {
    const objects = await store.storageObjects(id);
    if (objects.length === 0) break;
    let removed = 0;
    for (const batch of batchObjects(objects)) {
      removed += await storage.remove(
        batch[0]?.bucket ?? "",
        batch.map((o) => o.name),
      );
    }
    deleted += removed;
    if (removed === 0) break;
  }
  return { deleted, clear: await store.recordStorageCleared(id, deleted) };
}

/** One pass of the worker over the certificates with work. */
export async function runDeletionCertificates(options: {
  readonly store: PurgeStore;
  readonly storage: PurgeStorage;
  readonly render: CertificateRenderer;
  readonly mailer: ReportMailer;
  readonly copy: CertificateCopy;
  readonly worker: string;
  readonly limit?: number;
}): Promise<CertificateResult[]> {
  const { store, storage } = options;
  const results: CertificateResult[] = [];
  for (const cert of await store.claim(options.worker, options.limit ?? 5)) {
    try {
      if (!cert.purged) {
        const { deleted, clear } = await clearStorage(store, storage, cert.id);
        results.push({
          id: cert.id,
          outcome: clear ? "storage-cleared" : "storage-pending",
          deleted,
        });
        continue;
      }
      let bytes: Uint8Array | null = null;
      let fileName = "";
      const objectName = cert.documentObject ?? certificateObjectName(cert.id);
      if (!cert.issuedAt) {
        const rendered = await options.render(cert);
        bytes = rendered.bytes;
        fileName = rendered.fileName;
        await storage.upload(DELETION_CERTIFICATES_BUCKET, objectName, bytes, "application/pdf");
        await store.recordIssued(cert.id, objectName, await sha256Hex(bytes));
      }
      if (cert.deliveredAt) {
        results.push({ id: cert.id, outcome: "issued" });
        continue;
      }
      if (!cert.ownerEmail) {
        await store.release(
          cert.id,
          "The former Owner has no email address; the certificate waits in Atlas.",
        );
        results.push({ id: cert.id, outcome: "no-address" });
        continue;
      }
      if (!bytes) {
        bytes = await storage.download(DELETION_CERTIFICATES_BUCKET, objectName);
        fileName = deletionCertificateFileName(cert);
      }
      const copy = options.copy(cert.locale);
      const values = {
        org: cert.orgName,
        date: copy.date(cert.purgedAt, cert.timeZone),
        id: cert.id,
      };
      const text = copy.text(values);
      const sent = await options.mailer.send({
        to: cert.ownerEmail,
        toName: cert.ownerName,
        subject: copy.subject(values),
        text,
        html: text
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join(""),
        attachment: { filename: fileName, contentType: "application/pdf", content: bytes },
      });
      await store.recordDelivered(cert.id, sent.messageId);
      results.push({ id: cert.id, outcome: "delivered" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.release(cert.id, message);
      results.push({ id: cert.id, outcome: "failed", error: message });
    }
  }
  return results;
}

// Supabase adapters -----------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const text = (r: Row, k: string): string => (typeof r[k] === "string" ? (r[k] as string) : "");
const textOrNull = (r: Row, k: string): string | null =>
  typeof r[k] === "string" ? (r[k] as string) : null;
const count = (r: Row, k: string): number =>
  typeof r[k] === "number" ? (r[k] as number) : Number(r[k] ?? 0);

export function toClaimedCertificate(r: Row): ClaimedCertificate {
  return {
    id: text(r, "id"),
    deletedOrgId: text(r, "deleted_org_id"),
    orgName: text(r, "org_name"),
    orgSlug: text(r, "org_slug"),
    basis: text(r, "basis") === "deletion_request" ? "deletion_request" : "cancellation",
    requestedAt: text(r, "requested_at"),
    dueAt: text(r, "due_at"),
    purgedAt: text(r, "purged_at"),
    tablesPurged: count(r, "tables_purged"),
    rowsPurged: count(r, "rows_purged"),
    storageObjectsDeleted: count(r, "storage_objects_deleted"),
    ownerName: textOrNull(r, "owner_name"),
    timeZone: text(r, "time_zone") || "UTC",
    ownerEmail: textOrNull(r, "owner_email"),
    locale: text(r, "locale") || "en-US",
    storageClearedAt: textOrNull(r, "storage_cleared_at"),
    issuedAt: textOrNull(r, "issued_at"),
    documentObject: textOrNull(r, "document_object"),
    deliveredAt: textOrNull(r, "delivered_at"),
    purged: textOrNull(r, "purged_at") !== null,
  };
}

/** PurgeStore over the service-role client: the 1351 worker RPCs. */
export function supabasePurgeStore(client: SupabaseClient): PurgeStore {
  const app = client.schema("app");
  const check = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    async claim(worker, limit) {
      const { data, error } = await app.rpc("claim_deletion_certificates", {
        p_worker: worker,
        p_limit: limit,
      });
      check(error, "claim_deletion_certificates");
      return ((data as Row[] | null) ?? []).map(toClaimedCertificate);
    },
    async storageObjects(certificateId) {
      const { data, error } = await app.rpc("deletion_storage_objects", {
        p_certificate_id: certificateId,
      });
      check(error, "deletion_storage_objects");
      return ((data as Row[] | null) ?? []).map((r) => ({
        bucket: text(r, "bucket_id"),
        name: text(r, "name"),
      }));
    },
    async recordStorageCleared(certificateId, deleted) {
      const { data, error } = await app.rpc("record_deletion_storage_cleared", {
        p_certificate_id: certificateId,
        p_deleted: deleted,
      });
      check(error, "record_deletion_storage_cleared");
      return data === true;
    },
    async recordIssued(certificateId, objectName, sha256) {
      const { error } = await app.rpc("record_deletion_certificate_issued", {
        p_certificate_id: certificateId,
        p_document_object: objectName,
        p_document_sha256: sha256,
      });
      check(error, "record_deletion_certificate_issued");
    },
    async recordDelivered(certificateId, messageId) {
      const { error } = await app.rpc("record_deletion_certificate_delivered", {
        p_certificate_id: certificateId,
        p_message_id: messageId,
      });
      check(error, "record_deletion_certificate_delivered");
    },
    async release(certificateId, message) {
      const { error } = await app.rpc("release_deletion_certificate", {
        p_certificate_id: certificateId,
        p_error: message.slice(0, 2000),
      });
      check(error, "release_deletion_certificate");
    },
  };
}

/** PurgeStorage over the service-role client's Storage API. */
export function supabasePurgeStorage(client: SupabaseClient): PurgeStorage {
  return {
    async remove(bucket, names) {
      const { data, error } = await client.storage.from(bucket).remove([...names]);
      if (error)
        throw new Error(
          `Storage API refused deleting ${names.length} objects in ${bucket}: ${error.message}`,
        );
      return Array.isArray(data) ? data.length : 0;
    },
    async upload(bucket, name, bytes, contentType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(name, bytes, { contentType, upsert: true });
      if (error)
        throw new Error(`Storage API refused storing ${name} in ${bucket}: ${error.message}`);
    },
    async download(bucket, name) {
      const { data, error } = await client.storage.from(bucket).download(name);
      if (error || !data) throw new Error(`Storage API could not read ${name} in ${bucket}.`);
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
