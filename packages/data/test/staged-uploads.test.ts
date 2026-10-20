import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  UPLOAD_STAGING_BUCKET,
  myStagedUploadStatus,
  stagePublicUpload,
  stagedUploadName,
} from "../src/staged-uploads.ts";

/** Uploads for the public buckets go to upload-staging first (migration 1265, ADR 0034 amendment). */
function fake(options: { uploadError?: string; status?: unknown; rpcError?: string } = {}) {
  const calls: string[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: (name: string, _file: Blob, opts: Record<string, unknown>) => {
          calls.push(`upload ${bucket}/${name} ${JSON.stringify(opts)}`);
          return Promise.resolve({
            data: options.uploadError ? null : { path: name },
            error: options.uploadError ? { message: options.uploadError } : null,
          });
        },
      }),
    },
    rpc: (fn: string, args: unknown) => {
      calls.push(`rpc ${fn} ${JSON.stringify(args)}`);
      return Promise.resolve({
        data: options.rpcError ? null : (options.status ?? null),
        error: options.rpcError ? { message: options.rpcError, code: "42501" } : null,
      });
    },
  };
  return { db: client as unknown as XosClient, calls };
}

describe("staged uploads", () => {
  it("names a staged file after its public bucket and object", () => {
    expect(UPLOAD_STAGING_BUCKET).toBe("upload-staging");
    expect(stagedUploadName("org-brand", "o1/logoLight-1.png")).toBe(
      "org-brand/o1/logoLight-1.png",
    );
  });

  it("uploads a file for a public bucket into upload-staging", async () => {
    const { db, calls } = fake();
    const result = await stagePublicUpload(
      db,
      "org-brand",
      "o1/logoLight-1.png",
      new Blob(["png"]),
      "image/png",
    );
    expect(result).toEqual({ ok: true, data: "org-brand/o1/logoLight-1.png" });
    expect(calls).toEqual([
      'upload upload-staging/org-brand/o1/logoLight-1.png {"contentType":"image/png","upsert":false}',
    ]);
  });

  it("reports a refused upload", async () => {
    const { db } = fake({ uploadError: "new row violates row-level security policy" });
    expect(
      await stagePublicUpload(db, "profile-media", "p1/a.png", new Blob(["x"]), "image/png"),
    ).toEqual({
      ok: false,
      error: { kind: "unexpected", message: "new row violates row-level security policy" },
    });
  });

  it("asks the uploader's scan status of the staged name", async () => {
    const infected = fake({ status: "Infected" });
    expect(await myStagedUploadStatus(infected.db, "org-brand", "o1/logo.png")).toEqual({
      ok: true,
      data: "Infected",
    });
    expect(infected.calls).toEqual([
      'rpc my_upload_scan_status {"p_bucket_id":"upload-staging","p_object_name":"org-brand/o1/logo.png"}',
    ]);
    expect(await myStagedUploadStatus(fake().db, "org-brand", "o1/logo.png")).toEqual({
      ok: true,
      data: null,
    });
    expect(
      await myStagedUploadStatus(fake({ status: "Weird" }).db, "org-brand", "o1/logo.png"),
    ).toEqual({ ok: true, data: null });
    const failed = await myStagedUploadStatus(fake({ rpcError: "denied" }).db, "org-brand", "x");
    expect(failed.ok).toBe(false);
  });
});
