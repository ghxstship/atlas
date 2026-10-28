/** A white-label org's sender and brand on its notification email (A138, migration 2310, Section 12). */
import { describe, expect, it } from "vitest";
import { RecordingTransport, type Sender } from "@xos/email";
import {
  dispatchEmail,
  isPlatformEmailKind,
  mailbox,
  notificationStore,
  type ClaimedEmail,
  type NotificationStore,
  type PlatformDb,
} from "../src/index.ts";

const ORG = "0190a5b2-0000-7000-8000-00000000000a";

function db(brand: readonly Record<string, unknown>[]) {
  const rpcs: string[] = [];
  const fake: PlatformDb = {
    async rpc(fn) {
      rpcs.push(fn);
      if (fn === "email_brand_for_org") return brand;
      throw new Error(`not scripted: ${fn}`);
    },
    async selectOne(table) {
      return table === "organizations" ? { slug: "northwind-live", name: "Northwind Live" } : null;
    },
  };
  return { fake, rpcs };
}

const options = {
  appUrl: "https://atlas.xos.test",
  fromAddress: "notifications@mail.xos.test",
  postalAddress: "100 Harbor Way, Miami, FL 33132",
  unsubscribeUrl: async () => "https://fn.xos.test/u",
  inboundDomain: null,
  brandAssetUrl: "https://db.xos.test/storage/v1/object/public/org-brand/",
};

const northwind = {
  brand_name: "Northwind",
  sender_name: "Northwind Crew Desk",
  reply_to: "crew@northwind-live.com",
  logo_path: `${ORG}/logo light.png`,
  accent_hex: "#0B5FFF",
};

describe("senderFor", () => {
  it("keeps the platform sender while white label is not in force", async () => {
    const { fake } = db([]);
    const sender = await notificationStore(fake, options).senderFor(
      ORG,
      "p1",
      "approval.requested",
    );
    expect(sender).toEqual({
      orgName: "Northwind Live",
      postalAddress: "100 Harbor Way, Miami, FL 33132",
      preferencesUrl: "https://atlas.xos.test/northwind-live/me/notifications",
      unsubscribeUrl: "https://fn.xos.test/u",
      from: "Northwind Live <notifications@mail.xos.test>",
    });
  });

  it("uses the org's sender name, support address as reply-to, brand name, logo and accent", async () => {
    const { fake } = db([northwind]);
    const sender = await notificationStore(fake, options).senderFor(
      ORG,
      "p1",
      "approval.requested",
    );
    expect(sender.from).toBe("Northwind Crew Desk <notifications@mail.xos.test>");
    expect(sender.replyTo).toBe("crew@northwind-live.com");
    expect(sender.orgName).toBe("Northwind");
    expect(sender.brand).toEqual({
      logoUrl: `https://db.xos.test/storage/v1/object/public/org-brand/${ORG}/logo%20light.png`,
      accentHex: "#0B5FFF",
    });
  });

  it("leaves out what the org did not set, and the logo without the bucket URL", async () => {
    const { fake } = db([
      {
        brand_name: "Northwind",
        sender_name: "Northwind",
        reply_to: null,
        logo_path: null,
        accent_hex: null,
      },
    ]);
    const sender = await notificationStore(fake, options).senderFor(ORG, "p1");
    expect(sender.replyTo).toBeUndefined();
    expect(sender.brand).toEqual({});
    const { fake: withLogo } = db([northwind]);
    const noBucket = await notificationStore(withLogo, {
      ...options,
      brandAssetUrl: null,
    }).senderFor(ORG, "p1");
    expect(noBucket.brand).toEqual({ accentHex: "#0B5FFF" });
  });

  it("keeps billing and plan notices platform-branded without asking for the brand", async () => {
    for (const kind of [
      "billing.payment_failed",
      "billing.trial_ending",
      "organization.white_label_reverting",
    ]) {
      const { fake, rpcs } = db([northwind]);
      const sender = await notificationStore(fake, options).senderFor(ORG, "p1", kind);
      expect(sender.from).toBe("Northwind Live <notifications@mail.xos.test>");
      expect(sender.brand).toBeUndefined();
      expect(sender.replyTo).toBeUndefined();
      expect(rpcs).not.toContain("email_brand_for_org");
    }
    expect(isPlatformEmailKind("approval.requested")).toBe(false);
    expect(isPlatformEmailKind("organization.ownership_offered")).toBe(false);
  });

  it("quotes a sender name RFC 5322 reserves characters in, and drops control characters", async () => {
    const { fake } = db([{ ...northwind, sender_name: 'Northwind, "Crew" Desk' }]);
    const sender = await notificationStore(fake, options).senderFor(ORG, "p1");
    expect(sender.from).toBe('"Northwind, \\"Crew\\" Desk" <notifications@mail.xos.test>');
    expect(mailbox("Crew\r\nBcc: x@evil.test", "n@mail.xos.test")).toBe(
      '"Crew  Bcc: x@evil.test" <n@mail.xos.test>',
    );
    expect(mailbox("Northwind Live", "n@mail.xos.test")).toBe("Northwind Live <n@mail.xos.test>");
  });
});

describe("dispatchEmail with a brand", () => {
  const claim: ClaimedEmail = {
    deliveryId: "nd1",
    orgId: ORG,
    recipientPersonId: "p1",
    address: "dave@northwind.test",
    kind: "approval.requested",
    emailTemplateCode: "notification",
    messageArgs: { actorName: "Bob Okafor", title: "Rigging rental" },
    subjectTable: null,
    subjectId: null,
  };

  function store(sender: Sender & { from: string; replyTo?: string }, replyAddress: string | null) {
    const kinds: (string | undefined)[] = [];
    const s: NotificationStore = {
      claimEmail: async () => [claim],
      senderFor: async (_org, _person, kind) => {
        kinds.push(kind);
        return sender;
      },
      recipient: async () => ({ name: "Dave", locale: "en-US", timeZone: "UTC" }),
      linkFor: async () => "https://atlas.xos.test/northwind-live/inbox",
      replyAddressFor: async () => replyAddress,
      record: async () => undefined,
    };
    return { s, kinds };
  }

  const branded = {
    orgName: "Northwind",
    postalAddress: "100 Harbor Way",
    preferencesUrl: "https://atlas.xos.test/northwind-live/me/notifications",
    unsubscribeUrl: "https://fn.xos.test/u",
    from: "Northwind Crew Desk <notifications@mail.xos.test>",
    replyTo: "crew@northwind-live.com",
    brand: { logoUrl: "https://db.xos.test/logo.png", accentHex: "#0B5FFF" },
  };

  it("sends from the org's sender name, with its logo and accent, replying to its support address", async () => {
    const transport = new RecordingTransport();
    const { s, kinds } = store(branded, null);
    await expect(dispatchEmail(s, transport)).resolves.toEqual({
      attempted: 1,
      sent: 1,
      failed: 0,
    });
    const [sent] = transport.sent;
    expect(kinds).toEqual(["approval.requested"]);
    expect(sent?.from).toBe("Northwind Crew Desk <notifications@mail.xos.test>");
    expect(sent?.replyTo).toBe("crew@northwind-live.com");
    expect(sent?.html).toContain('src="https://db.xos.test/logo.png"');
    expect(sent?.html).toContain("background-color:#0B5FFF");
  });

  it("prefers the signed reply address, which threads the reply onto the record", async () => {
    const transport = new RecordingTransport();
    await dispatchEmail(store(branded, "r-abc@in.xos.test").s, transport);
    expect(transport.sent[0]?.replyTo).toBe("r-abc@in.xos.test");
  });
});
