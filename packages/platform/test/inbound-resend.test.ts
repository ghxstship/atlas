import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_INBOUND_BODY_CHARS,
  MAX_RAW_MESSAGE_BYTES,
  htmlToText,
  inboundStore,
  parseResendEvent,
  receiveInbound,
  receiveResendEmail,
  storageRawMailStore,
  verifyResendSignature,
  type PlatformDb,
  type RawMailStore,
  type ResendReceivedEvent,
} from "../src/index.ts";

// Recorded fixtures (test/fixtures/resend), written on 2026-10-23 from Resend's published formats: the
// `email.received` webhook event (resend.com/docs/webhooks/emails/received), the received email of
// `GET /emails/receiving/{id}` (resend.com/docs/api-reference/emails/retrieve-received-email) and a raw message.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/resend/${name}`, import.meta.url));
const EVENT_BODY = fixture("email-received.json").toString("utf8");
const RECEIVED = JSON.parse(fixture("received-email.json").toString("utf8")) as Record<
  string,
  unknown
>;
const RAW = new Uint8Array(fixture("raw.eml"));
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const DOMAIN = "inbound.ghxstship.tech";

// A signing secret in Resend's format, `whsec_` and base64 key bytes, made here rather than stored.
const KEY = Buffer.from("xos inbound-email test signing key");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_792_787_000;

/** svix-signature for a body, computed with Node's HMAC, independently of the code under test. */
function sign(id: string, timestamp: number, body: string, key: Buffer = KEY): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function event(): ResendReceivedEvent {
  const parsed = parseResendEvent(EVENT_BODY);
  if (parsed === null) throw new Error("fixture does not parse");
  return parsed;
}

/** Answers Resend's API and the raw download from scripted responses, and records every call. */
function fakeResend(
  overrides: { email?: Record<string, unknown>; apiStatus?: number; raw?: Response } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.startsWith("https://api.resend.com/emails/receiving/")) {
      if (overrides.apiStatus !== undefined)
        return new Response("{}", { status: overrides.apiStatus });
      return Response.json({ ...RECEIVED, ...overrides.email });
    }
    if (url.startsWith("https://raw.resend.test/")) {
      return (
        overrides.raw ??
        new Response(RAW, { headers: { "content-length": String(RAW.byteLength) } })
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { send, calls };
}

function fakeStores() {
  const received: Readonly<Record<string, unknown>>[] = [];
  const db: PlatformDb = {
    async rpc(fn, args) {
      expect(fn).toBe("receive_inbound_email");
      received.push(args);
      return "msg-1";
    },
    async selectOne() {
      return null;
    },
  };
  const stored: { name: string; bytes: Uint8Array }[] = [];
  const rawMail: RawMailStore = {
    async put(name, bytes) {
      stored.push({ name, bytes });
    },
  };
  return { store: inboundStore(db), received, rawMail, stored };
}

describe("Resend webhook signature (Svix)", () => {
  const id = "msg_2pQ8xL1nV7cR3";

  it("accepts the endpoint's signature over the raw body", async () => {
    const headers = { id, timestamp: String(NOW), signature: sign(id, NOW, EVENT_BODY) };
    await expect(
      verifyResendSignature(headers, EVENT_BODY, SECRET, { now: NOW + 60 }),
    ).resolves.toBe(true);
  });

  it("accepts any one of several space-separated v1 signatures, as during a secret rotation", async () => {
    const old = sign(id, NOW, EVENT_BODY, Buffer.from("the previous signing key"));
    const headers = {
      id,
      timestamp: String(NOW),
      signature: `${old} ${sign(id, NOW, EVENT_BODY)}`,
    };
    await expect(verifyResendSignature(headers, EVENT_BODY, SECRET, { now: NOW })).resolves.toBe(
      true,
    );
  });

  it("refuses a changed body, another secret, another message id and a re-serialized body", async () => {
    const headers = { id, timestamp: String(NOW), signature: sign(id, NOW, EVENT_BODY) };
    const verify = (body: string, secret = SECRET, h = headers) =>
      verifyResendSignature(h, body, secret, { now: NOW });
    await expect(verify(EVENT_BODY.replace("Rigging", "Rigged"))).resolves.toBe(false);
    await expect(
      verify(EVENT_BODY, `whsec_${Buffer.from("another key").toString("base64")}`),
    ).resolves.toBe(false);
    await expect(verify(EVENT_BODY, SECRET, { ...headers, id: "msg_other" })).resolves.toBe(false);
    await expect(verify(JSON.stringify(JSON.parse(EVENT_BODY)))).resolves.toBe(false);
  });

  it("refuses a timestamp more than five minutes from now, either way, so a captured request cannot replay", async () => {
    const at = (timestamp: number, now: number) =>
      verifyResendSignature(
        { id, timestamp: String(timestamp), signature: sign(id, timestamp, EVENT_BODY) },
        EVENT_BODY,
        SECRET,
        { now },
      );
    await expect(at(NOW, NOW + 300)).resolves.toBe(true);
    await expect(at(NOW, NOW + 301)).resolves.toBe(false);
    await expect(at(NOW + 301, NOW)).resolves.toBe(false);
  });

  it("refuses missing headers, other versions, malformed timestamps and an unusable secret", async () => {
    const signature = sign(id, NOW, EVENT_BODY);
    const verify = (
      h: { id: string | null; timestamp: string | null; signature: string | null },
      secret = SECRET,
    ) => verifyResendSignature(h, EVENT_BODY, secret, { now: NOW });
    await expect(verify({ id: null, timestamp: String(NOW), signature })).resolves.toBe(false);
    await expect(verify({ id, timestamp: null, signature })).resolves.toBe(false);
    await expect(verify({ id, timestamp: String(NOW), signature: null })).resolves.toBe(false);
    await expect(
      verify({ id, timestamp: String(NOW), signature: signature.replace("v1,", "v2,") }),
    ).resolves.toBe(false);
    await expect(verify({ id, timestamp: `${NOW}.5`, signature })).resolves.toBe(false);
    await expect(verify({ id, timestamp: String(NOW), signature }, "whsec_%%%")).resolves.toBe(
      false,
    );
    await expect(verify({ id, timestamp: String(NOW), signature }, "whsec_")).resolves.toBe(false);
  });
});

describe("Resend events and bodies", () => {
  it("reads the email.received event Resend publishes", () => {
    expect(event()).toMatchObject({
      type: "email.received",
      data: {
        email_id: EMAIL_ID,
        to: ["nwl-3f9a1c0d7e@inbound.ghxstship.tech"],
        cc: ["dave@northwind.test"],
        bcc: [],
        received_for: [],
        message_id: "<plot-v4.20261023@bayside-audio.test>",
      },
    });
  });

  it("returns null for a body that is not an event", () => {
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ type: "email.received", data: {} }))).toBeNull();
  });

  it("turns an HTML body into text without quoted blocks, scripts or tags", () => {
    expect(
      htmlToText(
        "<html><head><style>p{}</style></head><body><p>Confirmed&nbsp;for 6&#160;PM &amp; load in.</p>" +
          "<div>Thanks,<br>Erin</div><script>alert(1)</script>" +
          '<blockquote type="cite"><p>Can you confirm?</p></blockquote><p>&#x2014; &bogus; &lt;ok&gt;</p></body></html>',
      ),
    ).toBe("Confirmed for 6 PM & load in.\nThanks,\nErin\n\u2014 &bogus; <ok>");
  });
});

describe("receiveResendEmail", () => {
  it("reads the message, keeps its raw file and files it with Resend's DKIM verdict", async () => {
    const resend = fakeResend();
    const stores = fakeStores();
    const outcome = await receiveResendEmail(event(), {
      store: stores.store,
      rawMail: stores.rawMail,
      apiKey: "re_test_receiving",
      inboundDomain: DOMAIN,
      fetch: resend.send,
    });
    expect(outcome).toEqual({
      status: "received",
      inboundMessageId: "msg-1",
      rawObjectPath: `resend/${EMAIL_ID}.eml`,
    });
    expect(resend.calls[0]?.url).toBe(`https://api.resend.com/emails/receiving/${EMAIL_ID}`);
    expect(resend.calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer re_test_receiving",
    });
    expect(resend.calls[1]?.url).toBe(
      `https://raw.resend.test/emails/${EMAIL_ID}.eml?expires=1792787472`,
    );
    expect(stores.stored).toHaveLength(1);
    expect(stores.stored[0]?.name).toBe(`resend/${EMAIL_ID}.eml`);
    expect(Buffer.from(stores.stored[0]?.bytes ?? []).equals(Buffer.from(RAW))).toBe(true);
    expect(stores.received[0]).toEqual({
      p_local_part: "nwl-3f9a1c0d7e",
      p_from_address: "rigging@bayside-audio.test",
      p_subject_line: "Rigging plot v4",
      p_message_id_header: "<plot-v4.20261023@bayside-audio.test>",
      p_dkim_verified: true,
      p_body_text: "Updated plot attached.\nLoad in moves to 07:00.",
      p_raw_object_path: `resend/${EMAIL_ID}.eml`,
    });
  });

  it("passes DKIM only when Resend's check says pass", async () => {
    for (const authentication of [
      { spf: "pass", dkim: "gray", dmarc: "gray" },
      { spf: "pass", dkim: "fail", dmarc: "fail" },
      { spf: "pass", dkim: "processing_failed", dmarc: "unknown" },
      null,
    ]) {
      const stores = fakeStores();
      await receiveResendEmail(event(), {
        ...stores,
        apiKey: "re_test_receiving",
        inboundDomain: DOMAIN,
        fetch: fakeResend({ email: { authentication } }).send,
      });
      expect(stores.received[0]?.["p_dkim_verified"]).toBe(false);
    }
  });

  it("ignores mail for no address on the inbound domain without calling Resend", async () => {
    const resend = fakeResend();
    const stores = fakeStores();
    const other = event();
    const outcome = await receiveResendEmail(
      { ...other, data: { ...other.data, to: ["someone@else.test"], cc: [] } },
      { ...stores, apiKey: "re_test_receiving", inboundDomain: DOMAIN, fetch: resend.send },
    );
    expect(outcome).toEqual({ status: "ignored", reason: "not-for-inbound-domain" });
    expect(resend.calls).toHaveLength(0);
    expect(stores.received).toHaveLength(0);
  });

  it("ignores other events", async () => {
    const resend = fakeResend();
    const outcome = await receiveResendEmail(
      { ...event(), type: "email.delivered" },
      { ...fakeStores(), apiKey: "re_test_receiving", inboundDomain: DOMAIN, fetch: resend.send },
    );
    expect(outcome).toEqual({ status: "ignored", reason: "event-type" });
    expect(resend.calls).toHaveLength(0);
  });

  it("finds the inbox of forwarded and blind-copied mail through received_for and Bcc", async () => {
    for (const where of ["received_for", "bcc"] as const) {
      const stores = fakeStores();
      const base = event();
      await receiveResendEmail(
        {
          ...base,
          data: {
            ...base.data,
            to: ["erin@northwind.test"],
            cc: [],
            [where]: [`nwl-3f9a1c0d7e@${DOMAIN}`],
          },
        },
        {
          ...stores,
          apiKey: "re_test_receiving",
          inboundDomain: DOMAIN,
          fetch: fakeResend({
            email: { to: ["erin@northwind.test"], cc: [], [where]: [`nwl-3f9a1c0d7e@${DOMAIN}`] },
          }).send,
        },
      );
      expect(stores.received[0]?.["p_local_part"]).toBe("nwl-3f9a1c0d7e");
    }
  });

  it("files an HTML-only message as text, and names a message without a Message-ID by its Resend id", async () => {
    const stores = fakeStores();
    await receiveResendEmail(event(), {
      ...stores,
      apiKey: "re_test_receiving",
      inboundDomain: DOMAIN,
      fetch: fakeResend({ email: { text: null, message_id: null } }).send,
    });
    const base = event();
    const stores2 = fakeStores();
    await receiveResendEmail(
      { ...base, data: { ...base.data, message_id: null } },
      {
        ...stores2,
        apiKey: "re_test_receiving",
        inboundDomain: DOMAIN,
        fetch: fakeResend({ email: { message_id: "" } }).send,
      },
    );
    expect(stores.received[0]).toMatchObject({
      p_body_text: "Updated plot attached.\nLoad in moves to 07:00.",
      p_message_id_header: "<plot-v4.20261023@bayside-audio.test>",
    });
    expect(stores2.received[0]?.["p_message_id_header"]).toBe(`<${EMAIL_ID}@resend>`);
  });

  it("keeps no raw file over 50 MiB or without one, and records Resend's copy instead", async () => {
    const big = new Response(new Uint8Array(8), {
      headers: { "content-length": String(MAX_RAW_MESSAGE_BYTES + 1) },
    });
    for (const options of [{ raw: big }, { email: { raw: null } }]) {
      const stores = fakeStores();
      const outcome = await receiveResendEmail(event(), {
        ...stores,
        apiKey: "re_test_receiving",
        inboundDomain: DOMAIN,
        fetch: fakeResend(options).send,
      });
      expect(outcome).toMatchObject({ status: "received", rawObjectPath: `resend:${EMAIL_ID}` });
      expect(stores.stored).toHaveLength(0);
      expect(stores.received[0]?.["p_raw_object_path"]).toBe(`resend:${EMAIL_ID}`);
    }
  });

  it("throws on an API failure or a raw URL that is not https, so the webhook answers 500 and Resend retries", async () => {
    const deps = { ...fakeStores(), apiKey: "re_test_receiving", inboundDomain: DOMAIN };
    await expect(
      receiveResendEmail(event(), { ...deps, fetch: fakeResend({ apiStatus: 500 }).send }),
    ).rejects.toThrow(/Resend answered 500/);
    await expect(
      receiveResendEmail(event(), {
        ...deps,
        fetch: fakeResend({
          email: { raw: { download_url: "http://raw.resend.test/x.eml", expires_at: null } },
        }).send,
      }),
    ).rejects.toThrow(/not https/);
    await expect(
      receiveResendEmail(event(), {
        ...deps,
        fetch: fakeResend({ raw: new Response("", { status: 403 }) }).send,
      }),
    ).rejects.toThrow(/answered 403/);
  });
});

describe("storageRawMailStore", () => {
  it("writes the object through the Storage API with the service key, replacing a redelivered one", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = storageRawMailStore({
      url: "https://ref.supabase.test/",
      serviceKey: "service-key",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      },
    });
    await store.put(`resend/${EMAIL_ID}.eml`, RAW);
    expect(calls[0]?.url).toBe(
      `https://ref.supabase.test/storage/v1/object/inbound-mail/resend/${EMAIL_ID}.eml`,
    );
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        apikey: "service-key",
        Authorization: "Bearer service-key",
        "Content-Type": "message/rfc822",
        "x-upsert": "true",
      },
      body: RAW,
    });
  });

  it("throws when Storage refuses, so the message is retried", async () => {
    const store = storageRawMailStore({
      url: "https://ref.supabase.test",
      serviceKey: "service-key",
      fetch: async () => new Response("Payload too large", { status: 413 }),
    });
    await expect(store.put("resend/x.eml", RAW)).rejects.toThrow(/413 Payload too large/);
  });
});

describe("receiveInbound bounds", () => {
  it("cuts a body to what app.inbound_messages keeps, without splitting a character", async () => {
    const stores = fakeStores();
    const text = `${"a".repeat(MAX_INBOUND_BODY_CHARS - 1)}\u{1F3A4}tail`;
    await receiveInbound(
      stores.store,
      {
        to: [`nwl-3f9a1c0d7e@${DOMAIN}`],
        from: "rigging@bayside-audio.test",
        subject: "Long",
        messageId: "<long@bayside-audio.test>",
        dkimPass: true,
        text,
        rawObjectPath: "resend/long.eml",
      },
      DOMAIN,
    );
    const body = String(stores.received[0]?.["p_body_text"]);
    expect(Array.from(body)).toHaveLength(MAX_INBOUND_BODY_CHARS);
    expect(body.endsWith("\u{1F3A4}")).toBe(true);
  });

  it("ignores a sender address no mailbox can have", async () => {
    const stores = fakeStores();
    const message = {
      to: [`nwl-3f9a1c0d7e@${DOMAIN}`],
      subject: "x",
      messageId: "<x@bayside-audio.test>",
      dkimPass: true,
      text: "x",
      rawObjectPath: "resend/x.eml",
    };
    await expect(
      receiveInbound(stores.store, { ...message, from: `${"a".repeat(320)}@x.test` }, DOMAIN),
    ).resolves.toBeNull();
    await expect(
      receiveInbound(stores.store, { ...message, from: "<>" }, DOMAIN),
    ).resolves.toBeNull();
    expect(stores.received).toHaveLength(0);
  });
});
