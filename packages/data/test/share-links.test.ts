import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  classifyAttachment,
  createShareLink,
  fetchTicketFile,
  isClassification,
  isClassifiedFile,
  listShareLinks,
  maxShareDays,
  openShareLink,
  recordFileDownload,
  revokeShareLink,
  shareLinkActive,
  shareNeedsExpiry,
  type ShareLink,
} from "../src/share-links.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

/** The fake client with `schema("api_public").rpc(...)` queued under `rpc:api_public.<fn>`. */
function withPublic(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    ...(fake.db as unknown as Record<string, unknown>),
    schema: (name: string) => ({
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn: `${name}.${fn}`, args });
        const next = queues[`rpc:${name}.${fn}`]?.shift();
        if (!next) throw new Error(`no queued response for rpc:${name}.${fn}`);
        return next;
      },
    }),
  } as unknown as XosClient;
  return { db, calls, fakeCalls: fake.calls };
}

const TOKEN = `xshr_${"ab".repeat(32)}`;

const linkRow = (over: Record<string, unknown> = {}) => ({
  id: "l1",
  attachment_id: "a1",
  classification: "Internal",
  access_code_required: false,
  recipient_email: null,
  note: "For the venue",
  expires_at: "2026-10-27T00:00:00Z",
  open_count: 2,
  last_opened_at: "2026-10-20T00:00:00Z",
  failed_attempts: 0,
  revoked_at: null,
  created_by: "p-dave",
  created_at: "2026-10-20T00:00:00Z",
  ...over,
});

describe("Section 8.6 rules", () => {
  it("knows the classifications and the link limits", () => {
    expect(isClassification("Confidential")).toBe(true);
    expect(isClassification("Secret")).toBe(false);
    expect(maxShareDays("Public")).toBe(90);
    expect(maxShareDays("Internal")).toBe(90);
    expect(maxShareDays("Confidential")).toBe(30);
    expect(maxShareDays("Restricted")).toBeNull();
    expect(shareNeedsExpiry("Public")).toBe(false);
    expect(shareNeedsExpiry("Internal")).toBe(true);
    expect(isClassifiedFile("Internal")).toBe(false);
    expect(isClassifiedFile("Restricted")).toBe(true);
  });

  it("says whether a link still opens", () => {
    const base = {
      id: "l1",
      attachmentId: "a1",
      classification: "Internal",
      accessCodeRequired: false,
      recipientEmail: null,
      note: null,
      expiresAt: "2026-10-27T00:00:00Z",
      openCount: 0,
      lastOpenedAt: null,
      locked: false,
      revokedAt: null,
      createdBy: null,
      createdAt: "2026-10-20T00:00:00Z",
    } satisfies ShareLink;
    const now = new Date("2026-10-21T00:00:00Z");
    expect(shareLinkActive(base, now)).toBe(true);
    expect(shareLinkActive({ ...base, expiresAt: null }, now)).toBe(true);
    expect(shareLinkActive({ ...base, expiresAt: "2026-10-20T12:00:00Z" }, now)).toBe(false);
    expect(shareLinkActive({ ...base, locked: true }, now)).toBe(false);
    expect(shareLinkActive({ ...base, revokedAt: "2026-10-20T12:00:00Z" }, now)).toBe(false);
  });
});

describe("share links", () => {
  it("lists a file's links without the hashes, locked after five wrong codes", async () => {
    const { db, calls } = fakeClient({
      "from:share_links": [okResponse([linkRow(), linkRow({ id: "l2", failed_attempts: 5 })])],
    });
    const result = await listShareLinks(db, "a1");
    expect(result.ok && result.data.map((l) => [l.id, l.locked])).toEqual([
      ["l1", false],
      ["l2", true],
    ]);
    const select = calls[0]?.steps.find(([m]) => m === "select")?.[1][0] as string;
    expect(select).not.toContain("token_hash");
    expect(select).not.toContain("access_code_hash");
  });

  it("creates a link and returns the token and code once", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_share_link": [
        okResponse([
          {
            share_link_id: "l1",
            token: TOKEN,
            access_code: "042424",
            classification: "Confidential",
            expires_at: "2026-10-27T00:00:00Z",
          },
        ]),
      ],
    });
    const result = await createShareLink(db, {
      attachmentId: "a1",
      expiresAt: "2026-10-27T00:00:00Z",
      accessCodeRequired: true,
      recipientEmail: "ana@venue.test",
      note: null,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        id: "l1",
        token: TOKEN,
        accessCode: "042424",
        classification: "Confidential",
        expiresAt: "2026-10-27T00:00:00Z",
      },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_attachment_id: "a1",
      p_expires_at: "2026-10-27T00:00:00Z",
      p_access_code_required: true,
      p_recipient_email: "ana@venue.test",
    });
  });

  it("passes a Section 8.6 refusal through with its rule", async () => {
    const { db } = fakeClient({
      "rpc:create_share_link": [
        errorResponse(
          "XR001",
          "A Restricted file is never shared by link (Section 8.6).",
          "share_link_restricted",
        ),
      ],
    });
    const result = await createShareLink(db, {
      attachmentId: "a1",
      expiresAt: null,
      accessCodeRequired: false,
      recipientEmail: null,
      note: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({ kind: "refusal", rule: "share_link_restricted" });
  });

  it("revokes and classifies", async () => {
    const { db } = fakeClient({
      "rpc:revoke_share_link": [okResponse("2026-10-20T10:00:00Z")],
      "from:attachments": [okResponse([{ classification: "Confidential" }]), okResponse([])],
    });
    expect(await revokeShareLink(db, "l1")).toEqual({ ok: true, data: "2026-10-20T10:00:00Z" });
    expect(await classifyAttachment(db, "a1", "Confidential")).toEqual({
      ok: true,
      data: "Confidential",
    });
    expect(await classifyAttachment(db, "a2", "Public")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("opening a link", () => {
  it("refuses a malformed token without asking the database", async () => {
    const { db, calls } = withPublic({});
    expect(await openShareLink(db, { token: "nope", accessCode: null })).toEqual({
      ok: true,
      data: { refused: true, reason: "share_link_invalid" },
    });
    expect(calls).toHaveLength(0);
  });

  it("answers the refusal the database gave", async () => {
    const { db, calls } = withPublic({
      "rpc:api_public.open_share_link": [
        okResponse([{ refusal: "REFUSE", reason: "share_link_access_code", ticket: null }]),
      ],
    });
    expect(await openShareLink(db, { token: TOKEN, accessCode: "000000" })).toEqual({
      ok: true,
      data: { refused: true, reason: "share_link_access_code" },
    });
    expect(calls[0]).toEqual({
      fn: "api_public.open_share_link",
      args: { p_token: TOKEN, p_access_code: "000000" },
    });
  });

  it("answers the ticket and the watermark rule on an open", async () => {
    const { db } = withPublic({
      "rpc:api_public.open_share_link": [
        okResponse([
          {
            refusal: null,
            reason: null,
            ticket: "xdlt_ticket",
            org_name: "Northwind Live",
            filename: "stage.png",
            content_type: "image/png",
            size_bytes: 1200,
            classification: "Confidential",
            watermark: true,
            recipient_email: "ana@venue.test",
            expires_at: "2026-10-27T00:00:00Z",
            attachment_version_id: "0192f0a0-0000-7000-8000-000000000001",
          },
        ]),
      ],
    });
    const result = await openShareLink(db, { token: TOKEN, accessCode: "042424" });
    expect(result.ok && result.data).toMatchObject({
      refused: false,
      ticket: "xdlt_ticket",
      watermark: true,
      recipientEmail: "ana@venue.test",
      contentType: "image/png",
      versionId: "0192f0a0-0000-7000-8000-000000000001",
    });
  });

  // A69-013: before migration 2000 the database answers no version, and the copy links nowhere.
  it("answers no version when the database names none", async () => {
    const { db } = withPublic({
      "rpc:api_public.open_share_link": [
        okResponse([{ refusal: null, reason: null, ticket: "xdlt_ticket", watermark: false }]),
      ],
    });
    const result = await openShareLink(db, { token: TOKEN, accessCode: null });
    expect(result.ok && !result.data.refused && result.data.versionId).toBeNull();
  });
});

describe("file handover and classified downloads", () => {
  it("trades a ticket for the bytes at the file-download function", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;
    const result = await fetchTicketFile("https://db.test/functions/v1/", "xdlt_t", fetchImpl);
    expect(result.ok && [...result.data.bytes]).toEqual([1, 2, 3]);
    expect(seen).toEqual([
      { url: "https://db.test/functions/v1/file-download", body: { ticket: "xdlt_t" } },
    ]);
    const gone = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await fetchTicketFile("https://db.test/functions/v1", "x", gone)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("logs a classified download and answers its watermark rule", async () => {
    const { db } = fakeClient({
      "rpc:record_file_download": [
        okResponse([
          { classification: "Confidential", watermark: true, viewer_email: "bob@northwind.test" },
        ]),
        errorResponse("XR001", "needs the capability", "download_confidential"),
      ],
    });
    expect(await recordFileDownload(db, "v1")).toEqual({
      ok: true,
      data: { classification: "Confidential", watermark: true, viewerEmail: "bob@northwind.test" },
    });
    const refused = await recordFileDownload(db, "v1");
    expect(!refused.ok && refused.error).toMatchObject({
      kind: "refusal",
      rule: "download_confidential",
    });
  });
});
