/**
 * A22-011: the upload scan pipeline with scripted fakes. A scripted clamd speaks the INSTREAM
 * protocol and reports the EICAR test file as infected; a scripted store and storage stand in for
 * Postgres (migrations 0510, 0590, 1041) and Supabase Storage.
 */
import { describe, expect, it } from "vitest";
import {
  PlatformDbError,
  ScannerUnavailableError,
  UPLOAD_STAGING_BUCKET,
  ZIP_LIMITS,
  checkContent,
  clamavScanner,
  parseClamdReply,
  runUploadScans,
  scanStore,
  sniffFamilies,
  stagedUploadTarget,
  supabaseStorage,
  type ClamdConnection,
  type ObjectStorage,
  type PlatformDb,
  type ScanStore,
} from "../src/index.ts";

// The EICAR antivirus test file, assembled at run time so the source file itself never matches.
const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
  "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!",
  "$H+H*",
].join("");
const encode = (value: string) => new TextEncoder().encode(value);

/** A clamd that parses INSTREAM chunks and reports EICAR the way ClamAV does. */
function scriptedClamd(options: { reply?: string; failConnect?: boolean } = {}) {
  const sessions: Uint8Array[] = [];
  const connect = async (): Promise<ClamdConnection> => {
    if (options.failConnect === true) throw new Error("ECONNREFUSED");
    const written: number[] = [];
    let closed = false;
    return {
      async write(bytes) {
        written.push(...bytes);
      },
      async readReply() {
        const all = Uint8Array.from(written);
        const command = new TextDecoder().decode(all.subarray(0, 10));
        if (command !== "zINSTREAM\0") return encode("UNKNOWN COMMAND\0");
        const view = new DataView(all.buffer);
        const body: number[] = [];
        let at = 10;
        for (;;) {
          const length = view.getUint32(at, false);
          at += 4;
          if (length === 0) break;
          body.push(...all.subarray(at, at + length));
          at += length;
        }
        const stream = Uint8Array.from(body);
        sessions.push(stream);
        if (options.reply !== undefined) return encode(options.reply);
        return new TextDecoder().decode(stream).includes(EICAR)
          ? encode("stream: Eicar-Test-Signature FOUND\0")
          : encode("stream: OK\0");
      },
      close() {
        closed = true;
        expect(closed).toBe(true);
      },
    };
  };
  return { connect, sessions };
}

interface ZipEntrySpec {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly compressedSize?: number;
  readonly uncompressedSize?: number;
  readonly flags?: number;
}

/** A stored (uncompressed) zip, with sizes that may be overridden to model hostile archives. */
function zip(entries: readonly ZipEntrySpec[]): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const u16 = (out: number[], v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (out: number[], v: number) =>
    out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  for (const entry of entries) {
    const name = encode(entry.name);
    const data = entry.data ?? encode("x");
    const offset = parts.length;
    u32(parts, 0x04034b50);
    u16(parts, 20);
    u16(parts, entry.flags ?? 0);
    u16(parts, 0);
    u32(parts, 0);
    u32(parts, 0);
    u32(parts, entry.compressedSize ?? data.length);
    u32(parts, entry.uncompressedSize ?? data.length);
    u16(parts, name.length);
    u16(parts, 0);
    parts.push(...name, ...data);
    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, entry.flags ?? 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, 0);
    u32(central, entry.compressedSize ?? data.length);
    u32(central, entry.uncompressedSize ?? data.length);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name);
  }
  const directoryOffset = parts.length;
  parts.push(...central);
  u32(parts, 0x06054b50);
  u16(parts, 0);
  u16(parts, 0);
  u16(parts, entries.length);
  u16(parts, entries.length);
  u32(parts, central.length);
  u32(parts, directoryOffset);
  u16(parts, 0);
  return Uint8Array.from(parts);
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = encode("%PDF-1.7\n1 0 obj\n");

describe("clamd adapter (INSTREAM)", () => {
  it("reports the EICAR test file as infected and a clean file as clean", async () => {
    const clamd = scriptedClamd();
    const scanner = clamavScanner({ connect: clamd.connect, chunkSize: 16 });
    expect(await scanner.scan(encode(EICAR))).toEqual({
      clean: false,
      signature: "Eicar-Test-Signature",
    });
    expect(await scanner.scan(encode("Load-in starts at 06:00."))).toEqual({ clean: true });
    // Chunking reassembles to the exact bytes sent.
    expect(new TextDecoder().decode(clamd.sessions[0])).toBe(EICAR);
  });

  it("treats an unreachable or confused clamd as unavailable, never as clean", async () => {
    const down = clamavScanner({ connect: scriptedClamd({ failConnect: true }).connect });
    await expect(down.scan(encode("a"))).rejects.toBeInstanceOf(ScannerUnavailableError);
    const limit = clamavScanner({
      connect: scriptedClamd({ reply: "INSTREAM size limit exceeded. ERROR\0" }).connect,
    });
    await expect(limit.scan(encode("a"))).rejects.toThrow(/no verdict/);
    const broken = clamavScanner({
      connect: async () => ({
        write: async () => {
          throw new Error("EPIPE");
        },
        readReply: async () => new Uint8Array(),
        close: () => undefined,
      }),
    });
    await expect(broken.scan(encode("a"))).rejects.toThrow(/stopped answering/);
  });

  it("parses clamd replies", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ clean: true });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      clean: false,
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(() => parseClamdReply("")).toThrow(ScannerUnavailableError);
  });
});

describe("content checks (MIME sniffing and archive limits)", () => {
  it("accepts files whose bytes and extension match the declared type", () => {
    expect(checkContent({ bytes: PNG, contentType: "image/png", filename: "logo.png" })).toEqual({
      ok: true,
    });
    expect(
      checkContent({ bytes: PDF, contentType: "application/pdf", filename: "rider.PDF" }),
    ).toEqual({
      ok: true,
    });
    expect(
      checkContent({ bytes: encode("a,b\n1,2\n"), contentType: "text/csv", filename: "crew.csv" }),
    ).toEqual({
      ok: true,
    });
  });

  it("refuses a declared type the bytes do not match, a wrong extension and unknown types", () => {
    const html = encode("<html><script>alert(1)</script></html>");
    expect(checkContent({ bytes: html, contentType: "image/png", filename: "x.png" }).ok).toBe(
      false,
    );
    expect(checkContent({ bytes: PDF, contentType: "image/jpeg", filename: "x.jpg" }).ok).toBe(
      false,
    );
    expect(checkContent({ bytes: PNG, contentType: "image/png", filename: "x.exe" }).ok).toBe(
      false,
    );
    expect(checkContent({ bytes: PNG, contentType: "image/svg+xml", filename: "x.svg" }).ok).toBe(
      false,
    );
    expect(checkContent({ bytes: PNG, contentType: null, filename: "x.png" }).ok).toBe(false);
    expect(
      checkContent({ bytes: new Uint8Array(), contentType: "text/plain", filename: "x.txt" }).ok,
    ).toBe(false);
    expect(
      checkContent({
        bytes: Uint8Array.from([0, 1, 2]),
        contentType: "text/plain",
        filename: "x.txt",
      }).ok,
    ).toBe(false);
  });

  it("sniffs the common signatures", () => {
    expect(sniffFamilies(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toContain("jpeg");
    expect(sniffFamilies(encode("GIF89a...."))).toContain("gif");
    expect(sniffFamilies(encode("RIFF\0\0\0\0WEBPVP8 "))).toContain("webp");
    expect(sniffFamilies(encode("\0\0\0\x18ftypheic"))).toContain("heic");
    expect(sniffFamilies(encode("\0\0\0\x18ftypisom"))).toContain("mp4");
    expect(sniffFamilies(encode("ID3\x04"))).toContain("mp3");
    expect(
      sniffFamilies(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
    ).toContain("ole");
    expect(sniffFamilies(Uint8Array.from([0, 0, 1, 0, 1, 0]))).toContain("ico");
  });

  const asZip = (bytes: Uint8Array) =>
    checkContent({ bytes, contentType: "application/zip", filename: "a.zip" });

  it("accepts a plain zip within the limits", () => {
    expect(asZip(zip([{ name: "a.txt" }, { name: "plots/b.pdf", data: PDF }]))).toEqual({
      ok: true,
    });
  });

  it("refuses nested archives, except inside Office documents", () => {
    expect(asZip(zip([{ name: "inner.zip" }]))).toEqual({
      ok: false,
      reason: "Archives inside archives are not accepted.",
    });
    expect(asZip(zip([{ name: "deep/backup.tar.gz" }])).ok).toBe(false);
    const pptx = zip([{ name: "ppt/embeddings/chart.xlsx" }]);
    expect(
      checkContent({
        bytes: pptx,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename: "deck.pptx",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses archives over the unpacked size, entry count or ratio limits", () => {
    const big = zip([
      {
        name: "a.bin",
        data: encode("x".repeat(1000)),
        uncompressedSize: 60 * 1024 * 1024,
        compressedSize: 1000 * 1000,
      },
      {
        name: "b.bin",
        data: encode("x".repeat(1000)),
        uncompressedSize: 60 * 1024 * 1024,
        compressedSize: 1000 * 1000,
      },
    ]);
    expect(asZip(big)).toEqual({ ok: false, reason: "The archive unpacks to more than 100 MiB." });
    const bomb = zip([
      { name: "bomb.txt", data: encode("x"), compressedSize: 10, uncompressedSize: 10_000 },
    ]);
    expect(asZip(bomb).ok).toBe(false);
    const many = zip(
      Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `f${i}.txt` })),
    );
    expect(asZip(many).ok).toBe(false);
    expect(
      asZip(
        zip([{ name: "x.txt", data: new Uint8Array(), compressedSize: 0, uncompressedSize: 5 }]),
      ).ok,
    ).toBe(false);
  });

  it("refuses encrypted entries, path traversal, ZIP64 and damaged directories", () => {
    expect(asZip(zip([{ name: "secret.txt", flags: 1 }])).ok).toBe(false);
    expect(asZip(zip([{ name: "../etc/passwd" }])).ok).toBe(false);
    expect(asZip(zip([{ name: "/abs.txt" }])).ok).toBe(false);
    expect(asZip(zip([{ name: "big.bin", uncompressedSize: 0xffffffff }]))).toEqual({
      ok: false,
      reason: "ZIP64 archives are not accepted.",
    });
    const truncated = zip([{ name: "a.txt" }]).subarray(0, 40);
    expect(asZip(truncated)).toEqual({ ok: false, reason: "The archive has no zip directory." });
    const damaged = zip([{ name: "a.txt" }]);
    damaged[damaged.length - 6] = 0xfe; // directory offset now points past the end record
    expect(asZip(damaged).ok).toBe(false);
  });
});

/** A scripted database and storage: attachment versions, object scans and stored files. */
function scriptedWorld(files: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const removed: string[] = [];
  const uploaded: { path: string; bytes: Uint8Array; contentType: string | null }[] = [];
  const recorded: { id: string; clean: boolean | null; detail: string | null }[] = [];
  const finished: { jobId: string; succeeded: boolean; error: string | null }[] = [];
  const released: { id: string; error: string }[] = [];
  const versions: Record<
    string,
    {
      objectName: string;
      filename: string;
      contentType: string;
      checksumSha256: string | null;
      scanStatus: string;
    }
  > = {};
  let jobs: { jobId: string; attachmentVersionId: string; attempts: number }[] = [];
  let objects: {
    objectScanId: string;
    bucketId: string;
    objectName: string;
    contentType: string | null;
    attempts: number;
  }[] = [];
  const store: ScanStore = {
    async claimAttachmentScans() {
      const out = jobs;
      jobs = [];
      return out;
    },
    async attachmentVersion(id) {
      return versions[id] ?? null;
    },
    async recordAttachmentScan(id, clean, detail) {
      recorded.push({ id, clean, detail });
      return clean === null ? "Scan Failed" : clean ? "Clean" : "Infected";
    },
    async finishJob(jobId, succeeded, error) {
      finished.push({ jobId, succeeded, error });
      return succeeded ? "Succeeded" : "Queued";
    },
    async claimObjectScans() {
      const out = objects;
      objects = [];
      return out;
    },
    async recordObjectScan(id, clean, detail) {
      recorded.push({ id, clean, detail });
      return clean === null ? "Scan Failed" : clean ? "Clean" : "Infected";
    },
    async releaseObjectScan(id, error) {
      released.push({ id, error });
      return id === "exhausted" ? "Scan Failed" : "Scanning";
    },
  };
  const storage: ObjectStorage = {
    async download(bucket, name) {
      calls.push(`${bucket}/${name}`);
      const file = files[`${bucket}/${name}`];
      if (file === undefined) throw new Error("object not found");
      return file;
    },
    async upload(bucket, name, bytes, contentType) {
      if (name.includes("unwritable")) throw new Error("storage refused write");
      uploaded.push({ path: `${bucket}/${name}`, bytes, contentType });
    },
    async remove(bucket, name) {
      removed.push(`${bucket}/${name}`);
      if (name.includes("sticky")) throw new Error("storage refused delete");
    },
  };
  return {
    store,
    storage,
    calls,
    uploaded,
    removed,
    recorded,
    finished,
    released,
    versions,
    queueJob: (job: (typeof jobs)[number]) => jobs.push(job),
    queueObject: (scan: (typeof objects)[number]) => objects.push(scan),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("upload scan worker", () => {
  it("marks an EICAR attachment Infected and removes it, and a clean one Clean", async () => {
    const eicar = encode(EICAR);
    const notes = encode("Load-in starts at 06:00.");
    const world = scriptedWorld({
      "attachments/o/a/v1/eicar.txt": eicar,
      "attachments/o/a/v2/notes.txt": notes,
    });
    world.versions["v1"] = {
      objectName: "o/a/v1/eicar.txt",
      filename: "eicar.txt",
      contentType: "text/plain",
      checksumSha256: await sha256(eicar),
      scanStatus: "Scanning",
    };
    world.versions["v2"] = {
      objectName: "o/a/v2/notes.txt",
      filename: "notes.txt",
      contentType: "text/plain",
      checksumSha256: await sha256(notes),
      scanStatus: "Scanning",
    };
    world.queueJob({ jobId: "j1", attachmentVersionId: "v1", attempts: 1 });
    world.queueJob({ jobId: "j2", attachmentVersionId: "v2", attempts: 1 });
    const outcomes = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: clamavScanner({ connect: scriptedClamd().connect }),
      worker: "scanner-test",
    });
    expect(outcomes.map((o) => [o.id, o.result])).toEqual([
      ["v1", "infected"],
      ["v2", "clean"],
    ]);
    expect(world.recorded).toEqual([
      { id: "v1", clean: false, detail: "Eicar-Test-Signature" },
      { id: "v2", clean: true, detail: null },
    ]);
    expect(world.removed).toEqual(["attachments/o/a/v1/eicar.txt"]);
    expect(world.finished.every((f) => f.succeeded)).toBe(true);
  });

  it("refuses a checksum mismatch, a type mismatch and a nested archive without scanning", async () => {
    const world = scriptedWorld({
      "attachments/o/a/v1/rider.pdf": PDF,
      "attachments/o/a/v2/photo.png": PDF,
      "attachments/o/a/v3/bundle.zip": zip([{ name: "inner.zip" }]),
    });
    world.versions["v1"] = {
      objectName: "o/a/v1/rider.pdf",
      filename: "rider.pdf",
      contentType: "application/pdf",
      checksumSha256: "0".repeat(64),
      scanStatus: "Scanning",
    };
    world.versions["v2"] = {
      objectName: "o/a/v2/photo.png",
      filename: "photo.png",
      contentType: "image/png",
      checksumSha256: null,
      scanStatus: "Scanning",
    };
    world.versions["v3"] = {
      objectName: "o/a/v3/bundle.zip",
      filename: "bundle.zip",
      contentType: "application/zip",
      checksumSha256: null,
      scanStatus: "Scanning",
    };
    for (const id of ["v1", "v2", "v3"])
      world.queueJob({ jobId: `j-${id}`, attachmentVersionId: id, attempts: 1 });
    const clamd = scriptedClamd();
    const outcomes = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: clamavScanner({ connect: clamd.connect }),
      worker: "w",
    });
    expect(outcomes.map((o) => o.result)).toEqual(["refused", "refused", "refused"]);
    expect(world.recorded.map((r) => r.clean)).toEqual([null, null, null]);
    expect(world.recorded[2]?.detail).toBe("Archives inside archives are not accepted.");
    expect(clamd.sessions).toHaveLength(0);
    expect(world.removed).toHaveLength(3);
  });

  it("retries when clamd is down, and records Scan Failed on the last attempt", async () => {
    const world = scriptedWorld({ "attachments/o/a/v1/a.txt": encode("hello") });
    world.versions["v1"] = {
      objectName: "o/a/v1/a.txt",
      filename: "a.txt",
      contentType: "text/plain",
      checksumSha256: null,
      scanStatus: "Scanning",
    };
    const down = clamavScanner({ connect: scriptedClamd({ failConnect: true }).connect });
    world.queueJob({ jobId: "j1", attachmentVersionId: "v1", attempts: 2 });
    const first = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: down,
      worker: "w",
    });
    expect(first[0]?.result).toBe("retrying");
    expect(world.finished[0]).toMatchObject({ jobId: "j1", succeeded: false });
    expect(world.recorded).toHaveLength(0);

    world.queueJob({ jobId: "j1", attachmentVersionId: "v1", attempts: 5 });
    const last = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: down,
      worker: "w",
    });
    expect(last[0]?.result).toBe("failed");
    expect(world.recorded[0]).toMatchObject({ id: "v1", clean: null });
    expect(world.finished[1]).toMatchObject({ jobId: "j1", succeeded: true });
  });

  it("skips a version that is no longer being scanned", async () => {
    const world = scriptedWorld({});
    world.versions["v1"] = {
      objectName: "n",
      filename: "n.txt",
      contentType: "text/plain",
      checksumSha256: null,
      scanStatus: "Clean",
    };
    world.queueJob({ jobId: "j1", attachmentVersionId: "v1", attempts: 1 });
    world.queueJob({ jobId: "j2", attachmentVersionId: "gone", attempts: 1 });
    const outcomes = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: clamavScanner({ connect: scriptedClamd().connect }),
      worker: "w",
    });
    expect(outcomes.map((o) => o.result)).toEqual(["skipped", "skipped"]);
    expect(world.calls).toHaveLength(0);
  });

  it("scans bucket objects: clean, infected (removed), refused, retried and exhausted", async () => {
    const world = scriptedWorld({
      "profile-media/p/avatar.png": PNG,
      "field-media/o/forms/p/eicar.jpg": encode(EICAR),
      "org-brand/o/logo.png": encode("<svg onload=alert(1)>"),
      "field-media/o/forms/p/sticky.png": encode("not a png"),
    });
    world.queueObject({
      objectScanId: "s1",
      bucketId: "profile-media",
      objectName: "p/avatar.png",
      contentType: "image/png",
      attempts: 1,
    });
    world.queueObject({
      objectScanId: "s2",
      bucketId: "field-media",
      objectName: "o/forms/p/eicar.jpg",
      contentType: "text/plain",
      attempts: 1,
    });
    world.queueObject({
      objectScanId: "s3",
      bucketId: "org-brand",
      objectName: "o/logo.png",
      contentType: "image/png",
      attempts: 1,
    });
    world.queueObject({
      objectScanId: "s4",
      bucketId: "field-media",
      objectName: "o/forms/p/missing.png",
      contentType: "image/png",
      attempts: 1,
    });
    world.queueObject({
      objectScanId: "exhausted",
      bucketId: "field-media",
      objectName: "o/forms/p/missing2.png",
      contentType: "image/png",
      attempts: 5,
    });
    world.queueObject({
      objectScanId: "s6",
      bucketId: "field-media",
      objectName: "o/forms/p/sticky.png",
      contentType: "image/png",
      attempts: 1,
    });
    const outcomes = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: clamavScanner({ connect: scriptedClamd().connect }),
      worker: "w",
    });
    expect(outcomes.map((o) => [o.id, o.result])).toEqual([
      ["s1", "clean"],
      ["s2", "refused"],
      ["s3", "refused"],
      ["s4", "retrying"],
      ["exhausted", "failed"],
      ["s6", "refused"],
    ]);
    expect(outcomes[5]?.detail).toMatch(/stays in storage/);
    expect(world.released.map((r) => r.id)).toEqual(["s4", "exhausted"]);
    expect(world.removed).toEqual([
      "field-media/o/forms/p/eicar.jpg",
      "org-brand/o/logo.png",
      "field-media/o/forms/p/sticky.png",
    ]);
  });

  it("publishes a Clean staged upload to its public bucket, and never an infected one (1265)", async () => {
    const world = scriptedWorld({
      "upload-staging/org-brand/o/logoLight-1.png": PNG,
      "upload-staging/profile-media/p/notes.txt": encode(EICAR),
      "upload-staging/profile-media/p/unwritable.png": PNG,
      "upload-staging/elsewhere/p/avatar.png": PNG,
    });
    const staged = (objectScanId: string, objectName: string, contentType: string) =>
      world.queueObject({
        objectScanId,
        bucketId: "upload-staging",
        objectName,
        contentType,
        attempts: 1,
      });
    staged("logo", "org-brand/o/logoLight-1.png", "image/png");
    staged("eicar", "profile-media/p/notes.txt", "text/plain");
    staged("down", "profile-media/p/unwritable.png", "image/png");
    staged("stray", "elsewhere/p/avatar.png", "image/png");
    const outcomes = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: clamavScanner({ connect: scriptedClamd().connect }),
      worker: "w",
    });
    expect(outcomes.map((o) => [o.id, o.result])).toEqual([
      ["logo", "published"],
      ["eicar", "infected"],
      ["down", "retrying"],
      ["stray", "refused"],
    ]);
    // The Clean logo is written to org-brand under its own name, then recorded and removed from staging.
    expect(world.uploaded).toEqual([
      { path: "org-brand/o/logoLight-1.png", bytes: PNG, contentType: "image/png" },
    ]);
    expect(world.recorded.map((r) => [r.id, r.clean])).toEqual([
      ["logo", true],
      ["eicar", false],
      ["stray", null],
    ]);
    expect(world.removed).toEqual([
      "upload-staging/org-brand/o/logoLight-1.png",
      "upload-staging/profile-media/p/notes.txt",
      "upload-staging/elsewhere/p/avatar.png",
    ]);
    // A public bucket that refuses the write leaves the staged file Scanning, for a retry.
    expect(world.released).toEqual([
      { id: "down", error: expect.stringMatching(/could not publish to profile-media/) },
    ]);
  });

  it("names the public bucket and object of a staged upload", () => {
    expect(UPLOAD_STAGING_BUCKET).toBe("upload-staging");
    expect(stagedUploadTarget("org-brand/o/logo.png")).toEqual({
      bucket: "org-brand",
      name: "o/logo.png",
    });
    expect(stagedUploadTarget("profile-media/p/a/b.png")).toEqual({
      bucket: "profile-media",
      name: "p/a/b.png",
    });
    expect(stagedUploadTarget("imports/o/a.csv")).toBeNull();
    expect(stagedUploadTarget("org-brand/")).toBeNull();
    expect(stagedUploadTarget("logo.png")).toBeNull();
  });

  it("marks an infected bucket object Infected", async () => {
    const world = scriptedWorld({ "field-media/o/forms/p/notes.txt": encode(EICAR) });
    world.queueObject({
      objectScanId: "s1",
      bucketId: "field-media",
      objectName: "o/forms/p/notes.txt",
      contentType: "text/plain",
      attempts: 1,
    });
    await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: clamavScanner({ connect: scriptedClamd().connect }),
      worker: "w",
    });
    expect(world.recorded).toEqual([{ id: "s1", clean: false, detail: "Eicar-Test-Signature" }]);
  });

  it("keeps an unexpected failure on the job or scan for a retry", async () => {
    const world = scriptedWorld({
      "attachments/o/a/v1/a.txt": encode("hi"),
      "org-brand/o/l.png": PNG,
    });
    world.versions["v1"] = {
      objectName: "o/a/v1/a.txt",
      filename: "a.txt",
      contentType: "text/plain",
      checksumSha256: null,
      scanStatus: "Scanning",
    };
    world.queueJob({ jobId: "j1", attachmentVersionId: "v1", attempts: 1 });
    world.queueObject({
      objectScanId: "s1",
      bucketId: "org-brand",
      objectName: "o/l.png",
      contentType: "image/png",
      attempts: 1,
    });
    const outcomes = await runUploadScans({
      store: world.store,
      storage: world.storage,
      scanner: {
        scan: async () => {
          throw new Error("scanner bug");
        },
      },
      worker: "w",
    });
    expect(outcomes.map((o) => o.result)).toEqual(["retrying", "retrying"]);
    expect(world.finished[0]).toEqual({ jobId: "j1", succeeded: false, error: "scanner bug" });
    expect(world.released[0]).toEqual({ id: "s1", error: "scanner bug" });
  });
});

describe("scan stores", () => {
  it("call the job queue, attachment and object scan RPCs", async () => {
    const calls: { fn: string; args: Readonly<Record<string, unknown>> }[] = [];
    const answers: Record<string, unknown> = {
      claim_jobs: [{ id: "j1", subject_id: "v1", attempts: 2 }],
      claim_object_scans: [
        {
          object_scan_id: "s1",
          bucket_id: "field-media",
          object_name: "o/x.png",
          content_type: null,
          attempts: "3",
        },
      ],
      record_attachment_scan: "Clean",
      finish_job: "Succeeded",
      record_object_scan: "Infected",
      release_object_scan: "Scanning",
    };
    const db: PlatformDb = {
      async rpc(fn, args) {
        calls.push({ fn, args });
        return answers[fn];
      },
      async selectOne(_table, _columns, match) {
        if (match["id"] !== "v1") return null;
        return {
          object_name: "o/a/v1/a.pdf",
          filename: "a.pdf",
          content_type: "application/pdf",
          checksum_sha256: null,
          scan_status: "Scanning",
        };
      },
    };
    const store = scanStore(db);
    expect(await store.claimAttachmentScans("w", 5)).toEqual([
      { jobId: "j1", attachmentVersionId: "v1", attempts: 2 },
    ]);
    expect(calls[0]).toEqual({
      fn: "claim_jobs",
      args: { p_worker: "w", p_job_kind: "attachment.scan", p_limit: 5 },
    });
    expect(await store.attachmentVersion("v1")).toMatchObject({
      filename: "a.pdf",
      checksumSha256: null,
    });
    expect(await store.attachmentVersion("nope")).toBeNull();
    expect(await store.recordAttachmentScan("v1", true, null)).toBe("Clean");
    expect(await store.finishJob("j1", true, null)).toBe("Succeeded");
    expect(await store.claimObjectScans("w", 5)).toEqual([
      {
        objectScanId: "s1",
        bucketId: "field-media",
        objectName: "o/x.png",
        contentType: null,
        attempts: 3,
      },
    ]);
    expect(await store.recordObjectScan("s1", false, "sig")).toBe("Infected");
    expect(await store.releaseObjectScan("s1", "down")).toBe("Scanning");
    expect(calls.map((c) => c.fn)).toEqual([
      "claim_jobs",
      "record_attachment_scan",
      "finish_job",
      "claim_object_scans",
      "record_object_scan",
      "release_object_scan",
    ]);
  });

  it("refuse malformed rows", async () => {
    const db: PlatformDb = {
      rpc: async () => [{ id: 1 }],
      selectOne: async () => null,
    };
    await expect(scanStore(db).claimAttachmentScans("w", 1)).rejects.toBeInstanceOf(
      PlatformDbError,
    );
  });

  it("download and remove through the Storage API, surfacing its errors", async () => {
    const actions: string[] = [];
    const client = {
      storage: {
        from(bucket: string) {
          return {
            async download(name: string) {
              actions.push(`download ${bucket}/${name}`);
              if (name === "missing") return { data: null, error: { message: "Object not found" } };
              return { data: new Blob([PNG]), error: null };
            },
            async upload(name: string, _bytes: Uint8Array, options: Record<string, unknown>) {
              actions.push(`upload ${bucket}/${name} ${JSON.stringify(options)}`);
              return { error: name === "full" ? { message: "quota exceeded" } : null };
            },
            async remove(names: string[]) {
              actions.push(`remove ${bucket}/${names.join(",")}`);
              return { error: names[0] === "locked" ? { message: "denied" } : null };
            },
          };
        },
      },
    };
    const storage = supabaseStorage(client as unknown as Parameters<typeof supabaseStorage>[0]);
    expect(await storage.download("org-brand", "o/l.png")).toEqual(PNG);
    await expect(storage.download("org-brand", "missing")).rejects.toThrow(/Object not found/);
    await storage.upload("org-brand", "o/l.png", PNG, "image/png");
    await storage.upload("profile-media", "p/a.png", PNG, null);
    await expect(storage.upload("org-brand", "full", PNG, "image/png")).rejects.toThrow(/quota/);
    await storage.remove("org-brand", "o/l.png");
    await expect(storage.remove("org-brand", "locked")).rejects.toThrow(/denied/);
    expect(actions).toHaveLength(7);
    expect(actions[2]).toBe('upload org-brand/o/l.png {"upsert":true,"contentType":"image/png"}');
    expect(actions[3]).toBe('upload profile-media/p/a.png {"upsert":true}');
  });
});
