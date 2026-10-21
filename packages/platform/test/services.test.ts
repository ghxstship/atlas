import { describe, expect, it } from "vitest";
import { RecordingTransport } from "@xos/email";
import {
  PlatformDbError,
  billingStore,
  dispatchEmail,
  dispatchWebhooks,
  inboundStore,
  isPublicAddress,
  kioskPunch,
  localPartFor,
  gatewayLink,
  notificationStore,
  receiveInbound,
  signWebhook,
  stripQuotedText,
  supabaseDb,
  verifyWebhook,
  webhookStore,
  type ClaimedEmail,
  type NotificationStore,
  type PlatformDb,
} from "../src/index.ts";

/** A database that answers RPCs and reads from scripted handlers and records every call. */
function fakeDb(
  rpcs: Record<string, (args: Readonly<Record<string, unknown>>) => unknown>,
  tables: Record<string, Record<string, unknown>> = {},
) {
  const calls: { fn: string; args: Readonly<Record<string, unknown>> }[] = [];
  const db: PlatformDb = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      const handler = rpcs[fn];
      if (handler === undefined) throw new PlatformDbError(fn, "not scripted");
      return handler(args);
    },
    async selectOne(table) {
      return tables[table] ?? null;
    },
  };
  return { db, calls };
}

describe("webhook signing (ADR 0003)", () => {
  it("matches the database signature test vector", async () => {
    expect(await signWebhook("whsec_test", 1700000000, '{"a": 1}')).toBe(
      "t=1700000000,v1=f9086839ba44ac933ad5d79a65f74e64811e534328d3bf3c278acf3329bf7ce5",
    );
  });

  it("verifies within tolerance and refuses tampering, replays and malformed headers", async () => {
    const header = await signWebhook("whsec_k", 1000, "body");
    expect(await verifyWebhook(header, "body", "whsec_k", { now: 1100 })).toBe(true);
    expect(await verifyWebhook(header, "body!", "whsec_k", { now: 1100 })).toBe(false);
    expect(await verifyWebhook(header, "body", "whsec_other", { now: 1100 })).toBe(false);
    expect(await verifyWebhook(header, "body", "whsec_k", { now: 2000 })).toBe(false);
    expect(await verifyWebhook(null, "body", "whsec_k")).toBe(false);
    expect(await verifyWebhook("garbage", "body", "whsec_k")).toBe(false);
    expect(await verifyWebhook("t=abc,v1=00", "body", "whsec_k")).toBe(false);
  });
});

describe("SSRF guard", () => {
  it("refuses private, loopback, link-local and unique local addresses", () => {
    for (const ip of [
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "999.1.1.1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  // A69-004: a host's AAAA record can carry IPv4 in IPv6 forms, and special-purpose blocks are not
  // the public internet either.
  it("refuses IPv4 written in IPv6 forms and every special-purpose block", () => {
    for (const ip of [
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::FFFF:0A00:0001",
      "0:0:0:0:0:ffff:7f00:1",
      "::127.0.0.1",
      "::7f00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::169.254.169.254",
      "::",
      "0:0:0:0:0:0:0:1",
      "fec0::1",
      "ff02::1",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::1",
      "3fff::1",
      "5f00::1",
      "fe80::1%eth0",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "::ffff:999.0.0.1",
      "192.0.0.8",
      "192.0.2.10",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.5",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of [
      "64:ff9b::8.8.8.8",
      "::ffff:5db8:d822",
      "2a00:1450:4001:80b::200e",
      "198.20.0.1",
      "223.255.255.255",
      "1.1.1.1",
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("webhook dispatch", () => {
  const delivery = (id: string, url: string) => ({
    delivery_id: id,
    url,
    event_type: "project.created",
    body: '{"id":"e"}',
    signature: "t=1,v1=ab",
  });

  it("posts signed deliveries, refuses private hosts and records every outcome", async () => {
    const { db, calls } = fakeDb({
      claim_webhook_deliveries: () => [
        delivery("d1", "https://hooks.example.com/x"),
        delivery("d2", "https://internal.example.com/x"),
        delivery("d3", "https://down.example.com/x"),
        delivery("d4", "https://93.184.216.34/x"),
      ],
      record_webhook_attempt: (args) =>
        args["p_response_status"] === 200 ? "Delivered" : "Retrying",
    });
    const requests: { url: string; init: RequestInit }[] = [];
    const summary = await dispatchWebhooks({
      store: webhookStore(db),
      resolve: async (host) => (host === "internal.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]),
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (url.includes("down")) throw new Error("connect ECONNREFUSED");
        return new Response("ok", { status: url.includes("93.184") ? 500 : 200 });
      },
    });
    expect(summary).toEqual({ attempted: 4, delivered: 1, failed: 3 });
    expect(requests.map((r) => r.url)).toEqual([
      "https://hooks.example.com/x",
      "https://down.example.com/x",
      "https://93.184.216.34/x",
    ]);
    expect(requests[0]?.init.redirect).toBe("manual");
    expect((requests[0]?.init.headers as Record<string, string>)["XOS-Signature"]).toBe(
      "t=1,v1=ab",
    );
    const records = calls
      .filter((c) => c.fn === "record_webhook_attempt")
      .map((c) => [c.args["p_delivery_id"], c.args["p_response_status"], c.args["p_error"]]);
    expect(records).toEqual([
      ["d1", 200, null],
      ["d2", null, "Refused: the endpoint host resolves to a private address."],
      ["d3", null, "connect ECONNREFUSED"],
      ["d4", 500, "HTTP 500"],
    ]);
  });
});

describe("notification email dispatch", () => {
  const claim = (overrides: Partial<ClaimedEmail>): ClaimedEmail => ({
    deliveryId: "nd1",
    orgId: "org-1",
    recipientPersonId: "p1",
    address: "dave@northwind.test",
    kind: "approval.requested",
    emailTemplateCode: "notification",
    messageArgs: { actorName: "Bob Okafor", title: "Rigging rental", ignored: { nested: true } },
    subjectTable: "app.expenses",
    subjectId: "s1",
    ...overrides,
  });

  function store(claims: ClaimedEmail[]) {
    const records: [string, string, string | null, string | null][] = [];
    const s: NotificationStore = {
      claimEmail: async () => claims,
      senderFor: async () => ({
        orgName: "Northwind Live",
        postalAddress: "100 Harbor Way, Miami, FL 33132",
        preferencesUrl: "https://atlas.xos.test/northwind-live/me/notifications",
        unsubscribeUrl: "https://fn.xos.test/email-unsubscribe?t=x",
        from: "Northwind Live <notifications@mail.xos.test>",
      }),
      recipient: async (id) => ({
        name: "Dave",
        locale: id === "p2" ? "es-US" : "xx-XX",
        timeZone: "UTC",
      }),
      linkFor: async () => "https://atlas.xos.test/northwind-live/inbox",
      replyAddressFor: async (c) => (c.subjectId === null ? null : "r-abc@in.xos.test"),
      record: async (...args) => {
        records.push(args);
      },
    };
    return { s, records };
  }

  it("sends in the recipient's locale, with reply address and delivery idempotency, and records each outcome", async () => {
    const transport = new RecordingTransport();
    const { s, records } = store([
      claim({}),
      claim({ deliveryId: "nd2", recipientPersonId: "p2", subjectId: null }),
      claim({
        deliveryId: "nd3",
        emailTemplateCode: "export_ready",
        messageArgs: {
          exportName: "Vendors",
          expiresAt: "2026-11-03T00:00:00Z",
          url: "https://a.test/e",
        },
      }),
      claim({
        deliveryId: "nd4",
        emailTemplateCode: "export_ready",
        messageArgs: { exportName: "Vendors" },
      }),
      claim({ deliveryId: "nd5", emailTemplateCode: "digest" }),
    ]);
    const summary = await dispatchEmail(s, transport);
    expect(summary).toEqual({ attempted: 5, sent: 3, failed: 2 });
    expect(transport.sent[0]?.subject).toBe("Approval requested: Rigging rental");
    expect(transport.sent[0]?.replyTo).toBe("r-abc@in.xos.test");
    expect(transport.sent[0]?.idempotencyKey).toBe("delivery-nd1");
    expect(transport.sent[1]?.subject).toBe("Aprobación solicitada: Rigging rental");
    expect(transport.sent[1]?.replyTo).toBeUndefined();
    expect(transport.sent[2]?.subject).toBe("Your export Vendors is ready");
    expect(records.map((r) => [r[0], r[1]])).toEqual([
      ["nd1", "Sent"],
      ["nd2", "Sent"],
      ["nd3", "Sent"],
      ["nd4", "Failed"],
      ["nd5", "Failed"],
    ]);
    expect(records[4]?.[3]).toMatch(/not sent for notifications/);
  });

  it("records a failure when the template code is unknown", async () => {
    const { s, records } = store([claim({ emailTemplateCode: "no_such_template" })]);
    await dispatchEmail(s, new RecordingTransport());
    expect(records[0]?.[3]).toMatch(/Unknown email template/);
  });
});

describe("inbound mail", () => {
  it("strips quoted text in English and Spanish and signature separators", () => {
    expect(
      stripQuotedText(
        "Confirmed for 6 PM.\r\n\r\nOn Tue, Oct 13, 2026 Bob wrote:\r\n> Can you confirm?",
      ),
    ).toBe("Confirmed for 6 PM.");
    expect(stripQuotedText("Confirmado.\nEl mar, 13 oct 2026 Bob escribió:\n> ¿Confirmas?")).toBe(
      "Confirmado.",
    );
    expect(stripQuotedText("Yes\n> quoted\nstill mine\n-- \nDave")).toBe("Yes\nstill mine");
    expect(stripQuotedText("Done\n-----Original Message-----\nFrom: x")).toBe("Done");
  });

  it("finds the local part on the inbound domain only", () => {
    expect(
      localPartFor(
        ["Ops <ops@northwind.test>", "NWL Inbox <NWL-AB12CD@in.xos.test>"],
        "in.xos.test",
      ),
    ).toBe("nwl-ab12cd");
    expect(localPartFor(["someone@else.test"], "in.xos.test")).toBeNull();
  });

  it("hands the stripped message to the database and skips mail for other domains", async () => {
    const { db, calls } = fakeDb({ receive_inbound_email: () => "msg-1" });
    const message = {
      to: ["r-abc@in.xos.test"],
      from: "Erin <ERIN@northwind.test>",
      subject: "Re: Opening night",
      messageId: "<r1@northwind.test>",
      dkimPass: true,
      text: "Confirmed.\n> earlier",
      rawObjectPath: "raw/r1.eml",
    };
    await expect(receiveInbound(inboundStore(db), message, "in.xos.test")).resolves.toBe("msg-1");
    expect(calls[0]?.args).toMatchObject({
      p_local_part: "r-abc",
      p_from_address: "erin@northwind.test",
      p_body_text: "Confirmed.",
      p_dkim_verified: true,
    });
    await expect(
      receiveInbound(inboundStore(db), { ...message, to: ["x@other.test"] }, "in.xos.test"),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("stores", () => {
  it("billing store calls the 0560 RPCs and reads processing state", async () => {
    const { db, calls } = fakeDb(
      {
        record_stripe_event: () => [{ stripe_event_row_id: "row-1", is_new: true }],
        finish_stripe_event: () => null,
        sync_subscription_from_stripe: () => "active",
        record_addon_purchase_from_stripe: () => "purchase-1",
      },
      { stripe_events: { processed_at: null }, stripe_subscription_links: { org_id: "org-7" } },
    );
    const store = billingStore(db);
    await expect(
      store.recordStripeEvent({
        id: "evt_1",
        type: "x.y",
        livemode: false,
        createdAt: new Date(0),
        payload: {},
        orgId: null,
      }),
    ).resolves.toEqual({ rowId: "row-1", isNew: true, processed: false });
    await store.finishStripeEvent("row-1", null);
    await expect(store.orgForCustomer("cus_1")).resolves.toBe("org-7");
    await expect(
      store.syncSubscription({
        orgId: "org-7",
        customerId: "cus_1",
        subscriptionId: "sub_1",
        planCode: "pro",
        interval: "Monthly",
        status: "active",
        currentPeriodEnd: null,
        livemode: false,
        extraSeats: 3,
      }),
    ).resolves.toBe("active");
    await expect(
      store.recordAddonPurchase({
        orgId: "org-7",
        addonCode: "aurora_requests_1000",
        quantity: 2,
        checkoutSessionId: "cs_test_1",
        currency: "USD",
        amountTotalMinor: 9800,
        livemode: false,
        paidAt: new Date(0),
      }),
    ).resolves.toBe("purchase-1");
    expect(calls.map((c) => c.fn)).toEqual([
      "record_stripe_event",
      "finish_stripe_event",
      "sync_subscription_from_stripe",
      "record_addon_purchase_from_stripe",
    ]);
    expect(calls[2]?.args["p_current_period_end"]).toBeNull();
    expect(calls[2]?.args["p_extra_seats"]).toBe(3);
    expect(calls[3]?.args).toMatchObject({
      p_addon_code: "aurora_requests_1000",
      p_quantity: 2,
      p_paid_at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("notification store builds sender links, reply addresses and records outcomes", async () => {
    const { db, calls } = fakeDb(
      {
        claim_notification_deliveries: () => [
          {
            delivery_id: "nd1",
            org_id: "org-1",
            recipient_person_id: "p1",
            address: "dave@northwind.test",
            kind: "comment.created",
            email_template_code: "notification",
            message_args: null,
            subject_table: null,
            subject_id: "s1",
          },
        ],
        reply_address_local_part: () => "r-abc",
        record_notification_delivery: () => null,
        notification_recipient_profile: (args) => [
          {
            full_name: args["p_person_id"] === "p1" ? "Dave Lindqvist" : null,
            language: "en-US",
            time_zone: args["p_org_id"] === "org-1" ? "America/New_York" : null,
          },
        ],
      },
      {
        organizations: { slug: "northwind-live", name: "Northwind Live" },
        people: { full_name: "Dave Lindqvist" },
      },
    );
    const store = notificationStore(db, {
      appUrl: "https://atlas.xos.test",
      fromAddress: "notifications@mail.xos.test",
      postalAddress: "100 Harbor Way",
      unsubscribeUrl: async (org, person) => `https://fn.xos.test/u?o=${org}&p=${person}`,
      inboundDomain: "in.xos.test",
    });
    const [claimed] = await store.claimEmail(10);
    expect(claimed?.messageArgs).toEqual({});
    const sender = await store.senderFor("org-1", "p1");
    expect(sender.from).toBe("Northwind Live <notifications@mail.xos.test>");
    expect(sender.preferencesUrl).toBe("https://atlas.xos.test/northwind-live/me/notifications");
    expect(sender.unsubscribeUrl).toBe("https://fn.xos.test/u?o=org-1&p=p1");
    await expect(store.recipient("p1", "org-1")).resolves.toEqual({
      name: "Dave Lindqvist",
      locale: "en-US",
      timeZone: "America/New_York",
    });
    if (claimed === undefined) throw new Error("claim expected");
    await expect(store.linkFor(claimed)).resolves.toBe(
      "https://atlas.xos.test/northwind-live/inbox",
    );
    // An external party's notification (1131) links to Gateway when its base URL is known.
    const party = { ...claimed, messageArgs: { gatewayPath: "/money/invoices" } };
    await expect(store.linkFor(party)).resolves.toBe("https://atlas.xos.test/northwind-live/inbox");
    const withGateway = notificationStore(db, {
      appUrl: "https://atlas.xos.test",
      gatewayUrl: "https://gateway.xos.test/",
      fromAddress: "notifications@mail.xos.test",
      postalAddress: "100 Harbor Way",
      unsubscribeUrl: async () => "https://fn.xos.test/u",
      inboundDomain: null,
    });
    await expect(withGateway.linkFor(party)).resolves.toBe(
      "https://gateway.xos.test/money/invoices",
    );
    expect(
      gatewayLink({ messageArgs: { gatewayPath: "https://evil.test" } }, "https://g.test"),
    ).toBe(null);
    await expect(store.replyAddressFor(claimed)).resolves.toBe("r-abc@in.xos.test");
    await expect(store.replyAddressFor({ ...claimed, subjectId: null })).resolves.toBeNull();
    await store.record("nd1", "Sent", "re_1", null);
    expect(calls.at(-1)?.args).toEqual({
      p_delivery_id: "nd1",
      p_status: "Sent",
      p_provider_message_id: "re_1",
      p_error: null,
    });
  });

  it("refuses a malformed database response instead of guessing", async () => {
    const { db } = fakeDb({ claim_webhook_deliveries: () => [{ delivery_id: 5 }] });
    await expect(webhookStore(db).claim(1)).rejects.toBeInstanceOf(PlatformDbError);
  });

  it("kiosk punches go through app.kiosk_punch with the record_punch fields and return its refusal codes", async () => {
    const { db, calls } = fakeDb({
      kiosk_punch: (args) => [
        args["p_pin"] === "4821"
          ? {
              punch_id: args["p_punch_id"],
              time_entry_id: "te1",
              punch_kind: args["p_punch_kind"],
              effective_at: "2026-10-14T11:59:30Z",
              skew_flagged: true,
              refusal: null,
            }
          : {
              punch_id: args["p_punch_id"],
              time_entry_id: null,
              punch_kind: "Mystery",
              effective_at: null,
              skew_flagged: null,
              refusal: "kiosk_pin_rejected",
            },
      ],
    });
    const deviceAt = new Date("2026-10-14T12:00:00Z");
    await expect(
      kioskPunch(db, {
        deviceKey: "xkio_1",
        membershipId: "m1",
        pin: "4821",
        punchId: "01a13cc9-7c52-7d3e-8f31-e2d62d58f18a",
        punchKind: "Break Start",
        deviceAt,
        monotonicOffsetMs: 30000,
        photoUri: "storage://attachments/org/kiosk/p.jpg",
      }),
    ).resolves.toEqual({
      punchId: "01a13cc9-7c52-7d3e-8f31-e2d62d58f18a",
      timeEntryId: "te1",
      punchKind: "Break Start",
      effectiveAt: "2026-10-14T11:59:30Z",
      skewFlagged: true,
      refusal: null,
    });
    expect(calls[0]?.args).toEqual({
      p_device_key: "xkio_1",
      p_membership_id: "m1",
      p_pin: "4821",
      p_punch_id: "01a13cc9-7c52-7d3e-8f31-e2d62d58f18a",
      p_punch_kind: "Break Start",
      p_device_time: "2026-10-14T12:00:00.000Z",
      p_monotonic_offset_ms: 30000,
      p_photo_uri: "storage://attachments/org/kiosk/p.jpg",
      p_project_id: null,
    });
    await expect(
      kioskPunch(db, {
        deviceKey: "xkio_1",
        membershipId: "m1",
        pin: "0000",
        punchId: "x",
        punchKind: "In",
        deviceAt,
        projectId: "p",
      }),
    ).resolves.toEqual({
      punchId: "x",
      timeEntryId: null,
      punchKind: null,
      effectiveAt: null,
      skewFlagged: null,
      refusal: "kiosk_pin_rejected",
    });
    expect(calls[1]?.args["p_project_id"]).toBe("p");
    expect(calls[1]?.args["p_monotonic_offset_ms"]).toBeNull();
  });

  it("supabaseDb calls the app schema and surfaces errors", async () => {
    const queries: string[] = [];
    const client = {
      schema: (name: string) => {
        queries.push(`schema:${name}`);
        return {
          rpc: async (fn: string) =>
            fn === "bad"
              ? { data: null, error: { message: "XR001 refused" } }
              : { data: [{ ok: true }], error: null },
          from: (table: string) => {
            const chain = {
              select: () => chain,
              match: () => chain,
              limit: () => chain,
              maybeSingle: async () =>
                table === "bad"
                  ? { data: null, error: { message: "denied" } }
                  : { data: { id: "x" }, error: null },
            };
            return chain;
          },
        };
      },
    };
    const db = supabaseDb(client as never);
    await expect(db.rpc("good", {})).resolves.toEqual([{ ok: true }]);
    await expect(db.rpc("bad", {})).rejects.toThrow(/bad: XR001 refused/);
    await expect(db.selectOne("organizations", "id", { id: "x" })).resolves.toEqual({ id: "x" });
    await expect(db.selectOne("bad", "id", {})).rejects.toThrow(/denied/);
    expect(queries[0]).toBe("schema:app");
  });
});
