import { RecordingTransport } from "@xos/email";
import { describe, expect, it } from "vitest";
import {
  dispatchEmail,
  notificationStore,
  type ClaimedEmail,
  type NotificationStore,
  type PlatformDb,
} from "../src/index.ts";

/**
 * Signed-out approval links (P9, migration 2861, ADR 0138): the email that carries a link's access code mints the code
 * while it is rendered (app.mint_approval_link_code), so the code exists in clear only in that email; the database
 * keeps its hash. A link that is no longer ready sends no email, and the delivery is recorded as failed.
 */

const CLAIM: ClaimedEmail = {
  deliveryId: "nd-code",
  orgId: "org-1",
  recipientPersonId: "p-ivy",
  address: "ivy@freelance.test",
  kind: "approval.link_code",
  emailTemplateCode: "approval_link_code",
  messageArgs: { title: "Pass CR-000123 for Frank Ortiz", orgName: "Northwind Live", actorName: "Northwind Live" },
  subjectTable: "notification_action_tokens",
  subjectId: "tok-1",
  notificationId: "n-code",
};

function store(code: string | null, recorded: unknown[][]): NotificationStore {
  return {
    claimEmail: async () => [CLAIM],
    senderFor: async () => ({
      orgName: "Northwind Live",
      postalAddress: "100 Harbor Way",
      preferencesUrl: "https://gateway.xos.test/settings/notifications",
      unsubscribeUrl: "https://fn.xos.test/u",
      from: "Northwind Live <notifications@mail.xos.test>",
    }),
    recipient: async () => ({ name: "Ivy", locale: "en-US", timeZone: "UTC" }),
    linkFor: async () => "https://gateway.xos.test/home",
    replyAddressFor: async () => null,
    mintApprovalLinkCodeFor: async () => code,
    record: async (...args) => {
      recorded.push(args);
    },
  };
}

describe("the access code email", () => {
  it("mints the code at dispatch through app.mint_approval_link_code", async () => {
    const calls: { fn: string; args: Readonly<Record<string, unknown>> }[] = [];
    const db: PlatformDb = {
      async rpc(fn, args) {
        calls.push({ fn, args });
        return fn === "mint_approval_link_code" ? "482913" : null;
      },
      async selectOne() {
        return null;
      },
    };
    const minted = await notificationStore(db, {
      appUrl: "https://atlas.xos.test",
      gatewayUrl: "https://gateway.xos.test",
      fromAddress: "notifications@mail.xos.test",
      postalAddress: "100 Harbor Way",
      unsubscribeUrl: async () => "https://fn.xos.test/u",
      inboundDomain: null,
    }).mintApprovalLinkCodeFor?.(CLAIM);
    expect(minted).toBe("482913");
    expect(calls).toEqual([{ fn: "mint_approval_link_code", args: { p_delivery_id: "nd-code" } }]);
  });

  it("sends the code once, with its 10 minutes and the org, and nothing else stores it", async () => {
    const recorded: unknown[][] = [];
    const transport = new RecordingTransport();
    const summary = await dispatchEmail(store("482913", recorded), transport);
    expect(summary).toEqual({ attempted: 1, sent: 1, failed: 0 });
    const sent = transport.sent[0];
    expect(sent?.subject).toBe("Your code to decide for Northwind Live");
    expect(sent?.text).toContain("482913");
    expect(sent?.text).toContain("10 minutes");
    // Transactional: no unsubscribe link, so a recipient can always get the code they asked for.
    expect(sent?.html).not.toContain("https://fn.xos.test/u");
    // The code reaches only the email: neither the delivery record nor the claim carries it.
    expect(JSON.stringify(recorded)).not.toContain("482913");
    expect(JSON.stringify(CLAIM)).not.toContain("482913");
  });

  it("sends nothing when the link is no longer ready, and records the failure", async () => {
    const recorded: unknown[][] = [];
    const transport = new RecordingTransport();
    const summary = await dispatchEmail(store(null, recorded), transport);
    expect(summary).toEqual({ attempted: 1, sent: 0, failed: 1 });
    expect(transport.sent).toEqual([]);
    expect(recorded[0]?.[1]).toBe("Failed");
  });
});
