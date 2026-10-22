/**
 * Contract tests for the share link handlers (A82, migration 1380, Section 8.6). Requests run through
 * `contractApp` against the in-memory client and every success is checked against openapi/v1.json
 * with `expectContract`. The classification rules, the hashing and the lockout are the database's
 * (pgTAP 1380); here the RPCs answer the way the database does, and refusals stand in for its rules.
 */
import { describe, expect, it } from "vitest";
import { handlers as platform } from "../src/handlers/platform.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(82000 + n).padStart(12, "0")}`;
const FILE = id(1);
const VERSION = id(2);
const LINK = id(3);
const MISSING = id(9999);
const TOKEN = `xshr_${"ab".repeat(32)}`;

function link(extra: Row = {}): Row {
  return tenantRow(LINK, ORG, {
    created_by: testContext().personId,
    attachment_id: FILE,
    attachment_version_id: VERSION,
    classification: "Internal",
    access_code_required: false,
    recipient_email: null,
    note: "Stage plot for the venue",
    expires_at: "2026-10-27T23:59:59Z",
    failed_attempts: 0,
    open_count: 0,
    last_opened_at: null,
    revoked_at: null,
    revoked_by: null,
    ...extra,
  });
}

function world() {
  const rows: Row[] = [link()];
  const db = memoryDb(
    { share_links: rows },
    {
      create_share_link: (args) => {
        if (args["p_attachment_id"] === MISSING) throw refusal("share_link_restricted");
        return [
          {
            share_link_id: id(4),
            token: TOKEN,
            access_code: args["p_access_code_required"] ? "042424" : null,
            classification: "Internal",
            expires_at: args["p_expires_at"] ?? null,
          },
        ];
      },
      revoke_share_link: () => {
        Object.assign(rows[0] as Row, {
          revoked_at: "2026-10-20T10:00:00Z",
          revoked_by: testContext().personId,
        });
        return "2026-10-20T10:00:00Z";
      },
    },
  );
  return { db, http: requests(contractApp({ handlers: [platform], db })) };
}

describe("Platform: share links", () => {
  it("lists and reads a file's links without their token or code", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get(`/share-links?filter[attachment_id][eq]=${FILE}`)),
      "shareLinks.list",
    )) as { data: Row[] };
    expect(page.data[0]?.["note"]).toBe("Stage plot for the venue");
    expect(Object.keys(page.data[0] ?? {})).not.toContain("token_hash");
    await expectContract(await success(http.get(`/share-links/${LINK}`)), "shareLinks.get");
    expect((await http.get(`/share-links/${MISSING}`)).status).toBe(404);
  });

  it("creates a link and answers its token and code once", async () => {
    const { db, http } = world();
    const response = await success(
      http.post("/share-links", {
        attachment_id: FILE,
        access_code_required: true,
        expires_at: "2026-10-27T23:59:59Z",
        recipient_email: "ana@venue.test",
      }),
    );
    const made = (await expectContract(response, "shareLinks.create")) as {
      token: string;
      access_code: string;
    };
    expect(made.token).toBe(TOKEN);
    expect(made.access_code).toBe("042424");
    expect(db.calls.find((c) => c.name === "create_share_link")?.args).toEqual({
      p_attachment_id: FILE,
      p_access_code_required: true,
      p_expires_at: "2026-10-27T23:59:59Z",
      p_recipient_email: "ana@venue.test",
    });
  });

  it("answers a Section 8.6 refusal as 422 with its rule", async () => {
    const { http } = world();
    const response = await http.post("/share-links", { attachment_id: MISSING });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("share_link_restricted");
  });

  it("revokes a link", async () => {
    const { http } = world();
    const revoked = (await expectContract(
      await success(http.post(`/share-links/${LINK}/revoke`)),
      "shareLinks.revoke",
    )) as { revoked_at: string };
    expect(revoked.revoked_at).toBe("2026-10-20T10:00:00Z");
    expect((await http.post(`/share-links/${MISSING}/revoke`)).status).toBe(404);
  });
});
