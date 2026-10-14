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
      }),
    ).resolves.toBe("active");
    expect(calls.map((c) => c.fn)).toEqual([
      "record_stripe_event",
      "finish_stripe_event",
      "sync_subscription_from_stripe",
    ]);
    expect(calls[2]?.args["p_current_period_end"]).toBeNull();
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
    await expect(store.recipient("p1")).resolves.toEqual({
      name: "Dave Lindqvist",
      locale: "en-US",
      timeZone: "UTC",
    });
    if (claimed === undefined) throw new Error("claim expected");
    await expect(store.linkFor(claimed)).resolves.toBe(
      "https://atlas.xos.test/northwind-live/inbox",
    );
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

  it("kiosk punches go through app.kiosk_punch and return its refusal codes", async () => {
    const { db, calls } = fakeDb({
      kiosk_punch: (args) => [
        args["p_pin"] === "4821"
          ? { time_entry_id: "te1", punch: "Clock In", refusal: null }
          : { time_entry_id: null, punch: null, refusal: "kiosk_pin_rejected" },
      ],
    });
    await expect(
      kioskPunch(db, { deviceKey: "xkio_1", membershipId: "m1", pin: "4821" }),
    ).resolves.toEqual({ timeEntryId: "te1", punch: "Clock In", refusal: null });
    await expect(
      kioskPunch(db, { deviceKey: "xkio_1", membershipId: "m1", pin: "0000", projectId: "p" }),
    ).resolves.toEqual({ timeEntryId: null, punch: null, refusal: "kiosk_pin_rejected" });
    expect(calls[1]?.args["p_project_id"]).toBe("p");
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
