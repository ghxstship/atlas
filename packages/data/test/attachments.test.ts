import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  beginUpload,
  completeUpload,
  downloadUrl,
  listAttachments,
  removeAttachment,
  sha256Hex,
  uploadAttachment,
  type AttachmentVersion,
} from "../src/attachments.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

const subject = { table: "app.documents", id: "doc-1" };

/** Adds a recording storage stand-in to the fake database client. */
function withStorage(
  queues: Record<string, Response[]>,
  storage: {
    upload?: { error: { message: string } | null };
    signed?: { data: { signedUrl: string } | null; error: { message: string } | null };
  } = {},
) {
  const fake = fakeClient(queues);
  const uploads: { bucket: string; path: string; options: unknown }[] = [];
  const db = {
    ...(fake.db as unknown as Record<string, unknown>),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _body: ArrayBuffer, options: unknown) => {
          uploads.push({ bucket, path, options });
          return storage.upload ?? { error: null };
        },
        createSignedUrl: async () =>
          storage.signed ?? { data: { signedUrl: "https://storage.test/signed" }, error: null },
      }),
    },
  } as unknown as XosClient;
  return { db, calls: fake.calls, uploads };
}

const versionRow = (n: number, status: string, deleted: string | null = null) => ({
  id: `v${n}`,
  version_number: n,
  object_name: `org/a1/v${n}/plot.pdf`,
  filename: "plot.pdf",
  content_type: "application/pdf",
  size_bytes: 900 + n,
  scan_status: status,
  uploaded_by: "p-dave",
  uploaded_at: "2026-10-14T00:00:00Z",
  deleted_at: deleted,
});

describe("listAttachments", () => {
  it("orders versions newest first, drops removed ones and picks the newest clean version as current", async () => {
    const { db, calls } = withStorage({
      "from:attachments": [
        okResponse([
          {
            id: "a1",
            title: "plot.pdf",
            created_by: "p-dave",
            created_at: "2026-10-14T00:00:00Z",
            classification: "Confidential",
            attachment_versions: [
              versionRow(1, "Clean"),
              versionRow(3, "Infected"),
              versionRow(2, "Clean"),
              versionRow(4, "Clean", "2026-10-14T01:00:00Z"),
            ],
          },
          {
            id: "a2",
            title: "new.pdf",
            created_by: "p-dave",
            created_at: "2026-10-13T00:00:00Z",
            classification: "Internal",
            attachment_versions: null,
          },
        ]),
      ],
    });
    const result = await listAttachments(db, subject);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(result.data[0]?.current?.versionNumber).toBe(2);
    expect(result.data[1]?.current).toBeNull();
    // Each version carries its file's classification, which decides how it downloads (Section 8.6).
    expect(result.data[0]?.classification).toBe("Confidential");
    expect(result.data[0]?.current?.classification).toBe("Confidential");
    expect(calls[0]?.steps.filter(([m]) => m === "eq")).toEqual([
      ["eq", ["subject_table", "app.documents"]],
      ["eq", ["subject_id", "doc-1"]],
    ]);
  });

  it("maps a database error", async () => {
    const { db } = withStorage({ "from:attachments": [errorResponse("08006", "down")] });
    expect((await listAttachments(db, subject)).ok).toBe(false);
  });
});

describe("uploads", () => {
  it("begins with the declared type and size, uploads to the issued name and completes with the SHA-256", async () => {
    const { db, calls, uploads } = withStorage({
      "rpc:begin_attachment_upload": [
        okResponse([
          { attachment_id: "a1", attachment_version_id: "v1", object_name: "org/a1/v1/plot.pdf" },
        ]),
      ],
      "rpc:complete_attachment_upload": [okResponse("Scanning")],
    });
    const file = new Blob(["stage plot"], { type: "application/pdf" });
    const result = await uploadAttachment(db, {
      subject,
      file,
      filename: "plot.pdf",
      attachmentId: "a1",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        attachmentId: "a1",
        versionId: "v1",
        objectName: "org/a1/v1/plot.pdf",
        scanStatus: "Scanning",
      },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_subject_table: "app.documents",
          p_subject_id: "doc-1",
          p_filename: "plot.pdf",
          p_content_type: "application/pdf",
          p_size_bytes: 10,
          p_attachment_id: "a1",
        },
      ],
    ]);
    expect(uploads).toEqual([
      {
        bucket: "attachments",
        path: "org/a1/v1/plot.pdf",
        options: { contentType: "application/pdf", upsert: false },
      },
    ]);
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [
        {
          p_attachment_version_id: "v1",
          p_checksum_sha256: await sha256Hex(await file.arrayBuffer()),
        },
      ],
    ]);
  });

  it("stops at a refused begin, a failed upload or a refused completion", async () => {
    const refused = withStorage({
      "rpc:begin_attachment_upload": [
        errorResponse(
          "XR001",
          "attachment_type: image/svg+xml files cannot be attached.",
          "attachment_type",
        ),
      ],
    });
    const svg = new Blob(["<svg/>"], { type: "image/svg+xml" });
    expect(
      await uploadAttachment(refused.db, { subject, file: svg, filename: "logo.svg" }),
    ).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "attachment_type",
        message: "image/svg+xml files cannot be attached.",
      },
    });
    expect(refused.uploads).toEqual([]);

    const ticket = okResponse([
      { attachment_id: "a1", attachment_version_id: "v1", object_name: "n" },
    ]);
    const failed = withStorage(
      { "rpc:begin_attachment_upload": [ticket] },
      { upload: { error: { message: "network down" } } },
    );
    expect(
      await uploadAttachment(failed.db, {
        subject,
        file: new Blob(["x"], { type: "text/plain" }),
        filename: "a.txt",
      }),
    ).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "Upload failed: network down" },
    });

    const incomplete = withStorage({
      "rpc:begin_attachment_upload": [
        okResponse([{ attachment_id: "a1", attachment_version_id: "v1", object_name: "n" }]),
      ],
      "rpc:complete_attachment_upload": [
        errorResponse(
          "XR001",
          "attachment_size_mismatch: The stored file is not the size that was declared.",
          "attachment_size_mismatch",
        ),
      ],
    });
    const done = await uploadAttachment(incomplete.db, {
      subject,
      file: new Blob(["x"], { type: "text/plain" }),
      filename: "a.txt",
    });
    expect(done.ok).toBe(false);
  });

  it("reports an empty ticket and errors of each step", async () => {
    const { db } = withStorage({
      "rpc:begin_attachment_upload": [okResponse([]), errorResponse("42501", "denied")],
      "rpc:complete_attachment_upload": [errorResponse("42501", "denied")],
    });
    expect(
      await beginUpload(db, { subject, filename: "a", contentType: "text/plain", sizeBytes: 1 }),
    ).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "begin_attachment_upload returned no ticket" },
    });
    expect(
      await beginUpload(db, { subject, filename: "a", contentType: "text/plain", sizeBytes: 1 }),
    ).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await completeUpload(db, "v1", "ab")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("hashes with SHA-256 in lowercase hex", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc").buffer as ArrayBuffer)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("downloads and removal", () => {
  const version = (
    status: AttachmentVersion["scanStatus"],
    classification: AttachmentVersion["classification"] = "Internal",
  ): AttachmentVersion => ({
    id: "v1",
    versionNumber: 1,
    objectName: "org/a1/v1/plot.pdf",
    filename: "plot.pdf",
    contentType: "application/pdf",
    sizeBytes: 9,
    scanStatus: status,
    uploadedBy: null,
    uploadedAt: null,
    classification,
  });

  it("sends Confidential and Restricted files through the watermarking route, never a signed URL", async () => {
    const { db } = withStorage({});
    expect(await downloadUrl(db, version("Clean", "Confidential"))).toEqual({
      ok: true,
      data: "/files/v1",
    });
    expect(await downloadUrl(db, version("Clean", "Restricted"))).toEqual({
      ok: true,
      data: "/files/v1",
    });
    expect(await downloadUrl(db, version("Scanning", "Confidential"))).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("signs links for clean versions only", async () => {
    const { db } = withStorage({});
    expect(await downloadUrl(db, version("Clean"))).toEqual({
      ok: true,
      data: "https://storage.test/signed",
    });
    expect(await downloadUrl(db, version("Scanning"))).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const denied = withStorage(
      {},
      { signed: { data: null, error: { message: "Object not found" } } },
    );
    expect(await downloadUrl(denied.db, version("Clean"))).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("removes the caller's attachment softly", async () => {
    const { db, calls } = withStorage({
      "from:attachments": [
        okResponse([{ id: "a1" }]),
        okResponse([]),
        errorResponse("08006", "down"),
      ],
    });
    expect(await removeAttachment(db, "a1", new Date("2026-10-14T12:00:00Z"))).toEqual({
      ok: true,
      data: undefined,
    });
    expect(calls[0]?.steps[0]).toEqual(["update", [{ deleted_at: "2026-10-14T12:00:00.000Z" }]]);
    expect(await removeAttachment(db, "a2")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await removeAttachment(db, "a1")).ok).toBe(false);
  });
});
