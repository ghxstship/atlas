import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  addBlocklistEntry,
  blocklistRefusal,
  listBlocklist,
  removeBlocklistEntry,
} from "../src/member-blocklist.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** B16 (migration 3050, ADR 0155 D3): the org blocklist repository maps rows and refusals faithfully. */

describe("member blocklist", () => {
  it("lists entries with who added them and how many members match", async () => {
    const { db } = fakeClient({
      "rpc:member_blocklist": [
        okResponse([
          {
            entry_id: "e1",
            entry_kind: "Domain",
            entry_value: "blocked.test",
            reason: null,
            created_at: "2026-10-30T12:00:00Z",
            created_by_name: "Bob Okafor",
            members_matching: 2,
          },
        ]),
      ],
    });
    expect(await listBlocklist(db as unknown as XosClient, "org-1")).toEqual({
      ok: true,
      data: [
        {
          entryId: "e1",
          kind: "Domain",
          value: "blocked.test",
          reason: null,
          createdAt: "2026-10-30T12:00:00Z",
          createdByName: "Bob Okafor",
          membersMatching: 2,
        },
      ],
    });
  });

  it("adds an entry and returns what it revoked, declined and matched", async () => {
    const { db, calls } = fakeClient({
      "rpc:add_blocklist_entry": [
        okResponse([
          { entry_id: "e2", invites_revoked: 2, requests_declined: 1, members_matching: 0 },
        ]),
        errorResponse(
          "XR001",
          "blocklist_own_domain: This domain is one of the organization's verified domains.",
        ),
        okResponse([]),
      ],
    });
    const client = db as unknown as XosClient;
    expect(
      await addBlocklistEntry(client, {
        orgId: "org-1",
        kind: "Domain",
        value: "blocked.test",
        reason: "Spam",
      }),
    ).toEqual({
      ok: true,
      data: { entryId: "e2", invitesRevoked: 2, requestsDeclined: 1, membersMatching: 0 },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "org-1", p_kind: "Domain", p_value: "blocked.test", p_reason: "Spam" }],
    ]);
    const refused = await addBlocklistEntry(client, {
      orgId: "org-1",
      kind: "Domain",
      value: "northwind.test",
    });
    expect(refused.ok === false && refused.error).toMatchObject({
      kind: "refusal",
      rule: "blocklist_own_domain",
    });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { p_org_id: "org-1", p_kind: "Domain", p_value: "northwind.test" },
    ]);
    expect(
      (await addBlocklistEntry(client, { orgId: "org-1", kind: "Email", value: "x@y.test" })).ok,
    ).toBe(false);
  });

  it("removes an entry and names the blocklist's refusals", async () => {
    const { db } = fakeClient({
      "rpc:remove_blocklist_entry": [okResponse(null), errorResponse("42501", "denied")],
    });
    expect(await removeBlocklistEntry(db as unknown as XosClient, "e1")).toEqual({
      ok: true,
      data: null,
    });
    expect(await removeBlocklistEntry(db as unknown as XosClient, "e1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(blocklistRefusal("member_blocked")).toBe("member_blocked");
    expect(blocklistRefusal("invite_blocked")).toBe("invite_blocked");
    expect(blocklistRefusal("role_band")).toBeNull();
  });
});
