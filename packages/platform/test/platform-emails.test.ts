import { RecordingTransport } from "@xos/email";
import { describe, expect, it } from "vitest";
import {
  dispatchPlatformEmails,
  platformEmailStore,
  subprocessorLinks,
  type ClaimedPlatformEmail,
  type PlatformEmailStore,
} from "../src/legal/platform-emails.ts";
import type { PlatformDb } from "../src/stores.ts";

/** Subprocessor change notices (A82, migration 1382): the platform email worker. */
const OPTIONS = {
  appUrl: "https://atlas.xos.test",
  from: "XOS <notices@mail.xos.test>",
  postalAddress: "100 Harbor Way, Miami, FL 33132",
  senderName: "XOS",
};

function store(claims: ClaimedPlatformEmail[]) {
  const finished: [string, boolean, string | null, string | null][] = [];
  const s: PlatformEmailStore = {
    claim: async () => claims,
    finish: async (...args) => {
      finished.push(args);
      return args[1] ? "Sent" : "Queued";
    },
  };
  return { s, finished };
}

describe("platform emails", () => {
  it("builds the list, confirmation and unsubscribe links on Atlas", () => {
    const links = subprocessorLinks("https://atlas.xos.test/");
    expect(links.list).toBe("https://atlas.xos.test/legal/subprocessors");
    expect(links.confirm("xspn_a")).toBe(
      "https://atlas.xos.test/legal/subprocessors?confirm=xspn_a",
    );
    expect(links.unsubscribe("xspu_b")).toBe(
      "https://atlas.xos.test/legal/subprocessors?unsubscribe=xspu_b",
    );
  });

  it("sends the double opt-in confirmation and a notice with its own unsubscribe link", async () => {
    const transport = new RecordingTransport();
    const { s, finished } = store([
      {
        id: "e1",
        template: "subprocessor_confirm",
        to: "dana@example.test",
        locale: "es-US",
        args: { confirm_token: "xspn_token" },
      },
      {
        id: "e2",
        template: "subprocessor_notice",
        to: "dana@example.test",
        locale: "en-US",
        args: {
          list_version: "1.1.0",
          summary: "Adds Example Mail Inc. for inbound email.",
          effective_on: "2026-12-01",
          unsubscribe_token: "xspu_token",
        },
      },
    ]);
    const summary = await dispatchPlatformEmails(s, transport, OPTIONS);
    expect(summary).toEqual({ attempted: 2, sent: 2, failed: 0 });
    const [confirm, notice] = transport.sent;
    expect(confirm?.subject).toBe("Confirma tu suscripción a los cambios de subencargados de XOS");
    expect(confirm?.html).toContain(
      "https://atlas.xos.test/legal/subprocessors?confirm=xspn_token",
    );
    // A confirmation is transactional: no unsubscribe header.
    expect(confirm?.headers?.["List-Unsubscribe"]).toBeUndefined();
    expect(notice?.subject).toBe("XOS Subprocessor List changes on December 1, 2026");
    expect(notice?.text).toContain("Adds Example Mail Inc. for inbound email.");
    expect(notice?.headers?.["List-Unsubscribe"]).toBe(
      "<https://atlas.xos.test/legal/subprocessors?unsubscribe=xspu_token>",
    );
    expect(finished).toEqual([
      ["e1", true, "recorded-1", null],
      ["e2", true, "recorded-2", null],
    ]);
  });

  it("sends an account or roster invitation that links to Gateway sign-in, never with the address", async () => {
    const transport = new RecordingTransport();
    const { s, finished } = store([
      {
        id: "e4",
        template: "party_invitation",
        to: "nell@touring.test",
        locale: "en-US",
        args: {
          kind: "roster",
          inviter_name: "Victor Osei",
          org_name: "Northwind Live",
          project_name: "Northwind Summer Series",
          party_name: "Bayside Audio",
          expires_at: "2027-06-01T12:00:00Z",
        },
      },
    ]);
    const summary = await dispatchPlatformEmails(s, transport, {
      ...OPTIONS,
      gatewayUrl: "https://gateway.xos.test",
    });
    expect(finished[0]?.[3] ?? null).toBeNull();
    expect(summary).toEqual({ attempted: 1, sent: 1, failed: 0 });
    const [invitation] = transport.sent;
    expect(invitation?.subject).toBe(
      "Victor Osei invites you onto the Bayside Audio crew for Northwind Summer Series",
    );
    expect(invitation?.html).toContain("https://gateway.xos.test/auth/sign-in");
    expect(invitation?.html).not.toContain("nell%40touring.test");
    expect(invitation?.headers?.["List-Unsubscribe"]).toBeUndefined();
    expect(finished).toEqual([["e4", true, "recorded-1", null]]);
  });

  it("records a failure instead of dropping it", async () => {
    const { s, finished } = store([
      {
        id: "e3",
        template: "subprocessor_confirm",
        to: "x@example.test",
        locale: "en-US",
        args: {},
      },
    ]);
    expect(await dispatchPlatformEmails(s, new RecordingTransport(), OPTIONS)).toEqual({
      attempted: 1,
      sent: 0,
      failed: 1,
    });
    expect(finished[0]).toEqual(["e3", false, null, "Missing confirm_token"]);
  });

  it("claims and finishes through the 1382 RPCs", async () => {
    const calls: [string, unknown][] = [];
    const db: PlatformDb = {
      rpc: async (fn, args) => {
        calls.push([fn, args]);
        return fn === "claim_platform_emails"
          ? [
              {
                id: "e4",
                template: "subprocessor_confirm",
                to_email: "y@example.test",
                locale: "xx",
                args: null,
              },
            ]
          : "Sent";
      },
      selectOne: async () => null,
    };
    const s = platformEmailStore(db);
    expect(await s.claim(10)).toEqual([
      {
        id: "e4",
        template: "subprocessor_confirm",
        to: "y@example.test",
        locale: "en-US",
        args: {},
      },
    ]);
    expect(await s.finish("e4", true, "m-1", null)).toBe("Sent");
    expect(calls).toEqual([
      ["claim_platform_emails", { p_limit: 10 }],
      [
        "finish_platform_email",
        { p_id: "e4", p_sent: true, p_provider_message_id: "m-1", p_error: null },
      ],
    ]);
  });
});
