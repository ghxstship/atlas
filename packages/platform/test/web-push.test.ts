import { describe, expect, it } from "vitest";
import {
  PlatformDbError,
  RecordingPushClient,
  RecordingWebPushClient,
  base64UrlDecode,
  base64UrlEncode,
  createWebPushClient,
  dispatchPush,
  encryptWebPush,
  pushStore,
  readWebPushEnv,
  vapidAuthorization,
  vapidWebPushClient,
  webPushLink,
  webPushStore,
  type ClaimedPush,
  type DeviceTicket,
  type PlatformDb,
  type PushStore,
  type VapidKeys,
  type WebPushClient,
  type WebPushDevice,
  type WebPushStore,
} from "../src/index.ts";

/**
 * Web Push with VAPID (A96, 1533, ADR 0052). Every key here is generated at runtime: the browser's keys, its auth
 * secret and the VAPID key pair. The test plays the browser: it decrypts what the sender posted and checks the VAPID
 * signature with the public key.
 */

type Row = Readonly<Record<string, unknown>>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function buffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(data.length));
  out.set(data);
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", buffer(ikm), "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? encoder.encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: buffer(infoBytes) },
      key,
      length * 8,
    ),
  );
}

/** A browser: its ECDH key pair and auth secret, as base64url the way PushManager hands them out. */
async function browser() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys,
    p256dh: base64UrlEncode(publicKey),
    auth: base64UrlEncode(auth),
    publicKey,
    authSecret: auth,
  };
}

/** The browser's side of RFC 8291: decrypts one aes128gcm record. */
async function decrypt(body: Uint8Array, b: Awaited<ReturnType<typeof browser>>): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLength = body[20] ?? 0;
  const serverPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  expect(recordSize).toBe(4096);
  const serverKey = await crypto.subtle.importKey(
    "raw",
    buffer(serverPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, b.keys.privateKey, 256),
  );
  const info = new Uint8Array([
    ...encoder.encode("WebPush: info\0"),
    ...b.publicKey,
    ...serverPublic,
  ]);
  const ikm = await hkdf(b.authSecret, shared, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", buffer(cek), "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(nonce) }, key, buffer(ciphertext)),
  );
  expect(padded[padded.length - 1]).toBe(2);
  return decoder.decode(padded.slice(0, -1));
}

/** A VAPID key pair made for the test, never a real one. */
async function vapidKeys(): Promise<VapidKeys & { verifyKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: base64UrlEncode(publicKey),
    privateKey: jwk.d ?? "",
    subject: "mailto:platform@example.com",
    verifyKey: pair.publicKey,
  };
}

function fakeFetch(answer: (n: number) => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return answer(requests.length);
  }) as typeof fetch;
  return { impl, requests };
}

const ENDPOINT = "https://push.example.test/send/browser-one";

async function device(app: WebPushDevice["app"] = "Atlas", subscriptionId = "web-1") {
  const b = await browser();
  return {
    b,
    device: {
      subscriptionId,
      endpoint: ENDPOINT,
      p256dh: b.p256dh,
      auth: b.auth,
      app,
    } satisfies WebPushDevice,
  };
}

const PAYLOAD = {
  title: "Approval needed",
  body: "Bob asked you to approve Timesheet week 44.",
  url: "/northwind/inbox",
  tag: "n-1",
  kind: "approval.requested",
};

describe("RFC 8291 message encryption", () => {
  it("encrypts a payload only the subscribed browser can read", async () => {
    const { b } = await device();
    const body = await encryptWebPush(encoder.encode(JSON.stringify(PAYLOAD)), b.p256dh, b.auth);
    expect(JSON.parse(await decrypt(body, b))).toEqual(PAYLOAD);
    const other = await browser();
    await expect(decrypt(body, other)).rejects.toThrow();
  });

  it("refuses malformed keys and a message too big for one record", async () => {
    const { b } = await device();
    await expect(encryptWebPush(encoder.encode("hi"), "AAAA", b.auth)).rejects.toThrow(RangeError);
    await expect(encryptWebPush(new Uint8Array(5000), b.p256dh, b.auth)).rejects.toThrow(
      RangeError,
    );
  });

  it("round-trips base64url", () => {
    const data = crypto.getRandomValues(new Uint8Array(65));
    expect(base64UrlDecode(base64UrlEncode(data))).toEqual(data);
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe("-_8");
  });
});

describe("RFC 8292 VAPID", () => {
  it("signs an ES256 token for the push service's origin with the public key alongside", async () => {
    const keys = await vapidKeys();
    const header = await vapidAuthorization(ENDPOINT, keys, 1_800_000_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head = "", claims = "", signature = "", k = ""] = match ?? [];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(decoder.decode(base64UrlDecode(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(decoder.decode(base64UrlDecode(claims)))).toEqual({
      aud: "https://push.example.test",
      exp: 1_800_000_000 + 12 * 3600,
      sub: "mailto:platform@example.com",
    });
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.verifyKey,
      base64UrlDecode(signature),
      encoder.encode(`${head}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("refuses a public key that is not an uncompressed P-256 point", async () => {
    const keys = await vapidKeys();
    await expect(
      vapidAuthorization(ENDPOINT, { ...keys, publicKey: base64UrlEncode(new Uint8Array(33)) }, 0),
    ).rejects.toThrow(RangeError);
  });
});

describe("Web Push over fetch", () => {
  it("posts the encrypted payload with VAPID, TTL and urgency, and takes 201 as accepted", async () => {
    const keys = await vapidKeys();
    const { b, device: d } = await device();
    const f = fakeFetch(() => new Response(null, { status: 201 }));
    const client = vapidWebPushClient({ keys, fetch: f.impl, now: () => 1_800_000_000_000 });
    expect(await client.send(d, PAYLOAD, { ttl: 86400, urgency: "high" })).toEqual({
      status: "ok",
    });
    const request = f.requests[0];
    expect(request?.url).toBe(ENDPOINT);
    const headers = request?.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["TTL"]).toBe("86400");
    expect(headers["Urgency"]).toBe("high");
    expect(headers["Authorization"]).toMatch(/^vapid t=.+, k=/);
    expect(JSON.parse(await decrypt(request?.init.body as Uint8Array, b))).toEqual(PAYLOAD);
  });

  it("maps the push service's answers: gone, too big, refused, retried", async () => {
    const keys = await vapidKeys();
    const { device: d } = await device();
    const sleep = async () => undefined;
    const answer = (status: number) =>
      vapidWebPushClient({
        keys,
        sleep,
        fetch: fakeFetch(() => new Response("nope", { status })).impl,
      }).send(d, PAYLOAD, {
        ttl: 60,
        urgency: "normal",
      });
    expect(await answer(410)).toMatchObject({ status: "error", error: "DeviceNotRegistered" });
    expect(await answer(404)).toMatchObject({ status: "error", error: "DeviceNotRegistered" });
    expect(await answer(413)).toMatchObject({ status: "error", error: "MessageTooBig" });
    expect(await answer(403)).toMatchObject({ status: "error", error: "PushServiceRefused" });
    expect(await answer(503)).toMatchObject({ status: "error", error: "RequestFailed" });

    const flaky = fakeFetch((n) => new Response(null, { status: n < 3 ? 429 : 201 }));
    expect(
      await vapidWebPushClient({ keys, sleep, fetch: flaky.impl }).send(d, PAYLOAD, {
        ttl: 60,
        urgency: "normal",
      }),
    ).toEqual({
      status: "ok",
    });
    expect(flaky.requests).toHaveLength(3);

    const offline = fakeFetch(() => Promise.reject(new Error("network down")));
    expect(
      await vapidWebPushClient({ keys, sleep, fetch: offline.impl }).send(d, PAYLOAD, {
        ttl: 60,
        urgency: "normal",
      }),
    ).toEqual({
      status: "error",
      error: "RequestFailed",
      message: "network down",
    });
  });

  it("reports a browser with broken keys without reaching the network", async () => {
    const keys = await vapidKeys();
    const f = fakeFetch(() => new Response(null, { status: 201 }));
    const result = await vapidWebPushClient({ keys, fetch: f.impl }).send(
      { subscriptionId: "w", endpoint: ENDPOINT, p256dh: "AAAA", auth: "AAAA", app: "Atlas" },
      PAYLOAD,
      { ttl: 60, urgency: "normal" },
    );
    expect(result).toMatchObject({ status: "error", error: "MessageTooBig" });
    expect(f.requests).toHaveLength(0);
  });
});

describe("the Web Push environment", () => {
  it("records unless VAPID is asked for, and then needs all three keys", async () => {
    expect(createWebPushClient(readWebPushEnv({})).name).toBe("record");
    expect(() => readWebPushEnv({ XOS_WEB_PUSH_TRANSPORT: "vapid" })).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => readWebPushEnv({ VAPID_PRIVATE_KEY: "short" })).toThrow(/VAPID_PRIVATE_KEY/);
    const keys = await vapidKeys();
    const env = readWebPushEnv({
      XOS_WEB_PUSH_TRANSPORT: "vapid",
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: keys.subject,
    });
    expect(createWebPushClient(env).name).toBe("vapid");
  });

  it("never echoes a key it refuses", () => {
    const secret = "x".repeat(42);
    try {
      readWebPushEnv({ VAPID_PRIVATE_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

// The dispatcher -----------------------------------------------------------------------------------------------------

const claim = (overrides: Partial<ClaimedPush> = {}): ClaimedPush => ({
  deliveryId: "d1",
  notificationId: "n-1",
  orgId: "org-1",
  recipientPersonId: "p1",
  kind: "approval.requested",
  categoryCode: "approvals",
  messageArgs: { actorName: "Bob Okafor", title: "Timesheet week 44" },
  subjectTable: "timesheets",
  subjectId: "s1",
  devices: [],
  browsers: ["web-1"],
  ...overrides,
});

function stores(claims: ClaimedPush[], devices: Record<string, WebPushDevice[]>) {
  const records: [string, string, string | null, string | null][] = [];
  const webTickets: [string, readonly DeviceTicket[]][] = [];
  const expoTickets: [string, readonly DeviceTicket[]][] = [];
  const store: PushStore = {
    claimPush: async () => claims,
    recipient: async () => ({ name: "Dave", locale: "en-US", timeZone: "America/New_York" }),
    deepLink: async () => "compass://inbox",
    recordTickets: async (id, t) => {
      expoTickets.push([id, t]);
    },
    record: async (...args) => {
      records.push(args);
    },
    claimReceipts: async () => [],
    recordReceipts: async () => 0,
  };
  const web: WebPushStore = {
    webDevices: async (id) => devices[id] ?? [],
    recordWebTickets: async (id, t) => {
      webTickets.push([id, t]);
    },
    webLink: async (_c, app) => (app === "Atlas" ? "/northwind/inbox" : "/home"),
  };
  return { store, web, records, webTickets, expoTickets };
}

describe("dispatchPush with browsers (1533)", () => {
  it("pushes a delivery's browsers with each app's link and records the answers", async () => {
    const atlas = await device("Atlas", "web-1");
    const gateway = await device("Gateway", "web-2");
    const s = stores([claim({ browsers: ["web-1", "web-2"] })], {
      d1: [atlas.device, gateway.device],
    });
    const client = new RecordingWebPushClient();
    const summary = await dispatchPush(s.store, new RecordingPushClient(), {
      web: { store: s.web, client },
    });
    expect(summary).toMatchObject({ attempted: 1, sent: 1, devices: 2 });
    expect(client.sent.map((x) => x.payload.url)).toEqual(["/northwind/inbox", "/home"]);
    expect(client.sent[0]?.payload).toMatchObject({ tag: "n-1", kind: "approval.requested" });
    expect(client.sent[0]?.options).toEqual({ ttl: 86400, urgency: "high" });
    expect(s.webTickets[0]?.[1].map((t) => t.status)).toEqual(["ok", "ok"]);
    expect(s.records).toEqual([["d1", "Sent", null, null]]);
  });

  it("bounces a delivery whose only browser is gone", async () => {
    const gone = await device();
    const s = stores([claim()], { d1: [gone.device] });
    const client: WebPushClient = {
      name: "gone",
      send: async () => ({ status: "error", error: "DeviceNotRegistered", message: "410" }),
    };
    await dispatchPush(s.store, new RecordingPushClient(), { web: { store: s.web, client } });
    expect(s.records[0]?.[1]).toBe("Bounced");
    expect(s.webTickets[0]?.[1][0]).toMatchObject({
      subscriptionId: "web-1",
      error: "DeviceNotRegistered",
      ticketId: null,
    });
  });

  it("counts an Expo device and a browser together", async () => {
    const browserOne = await device();
    const s = stores(
      [
        claim({
          devices: [{ subscriptionId: "sub-1", token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]" }],
        }),
      ],
      { d1: [browserOne.device] },
    );
    const failing: WebPushClient = {
      name: "down",
      send: async () => ({ status: "error", error: "RequestFailed", message: "down" }),
    };
    const summary = await dispatchPush(s.store, new RecordingPushClient(), {
      web: { store: s.web, client: failing },
    });
    expect(summary.devices).toBe(2);
    expect(s.expoTickets).toHaveLength(1);
    expect(s.records[0]?.[1]).toBe("Sent");
  });

  it("records a failure to read the browsers instead of dropping the delivery", async () => {
    const s = stores([claim()], {});
    const broken: WebPushStore = {
      ...s.web,
      webDevices: () => Promise.reject(new Error("db down")),
    };
    await dispatchPush(s.store, new RecordingPushClient(), {
      web: { store: broken, client: new RecordingWebPushClient() },
    });
    expect(s.records).toEqual([["d1", "Failed", null, "db down"]]);
  });
});

// The stores ---------------------------------------------------------------------------------------------------------

function fakeDb(
  rpcs: Record<string, (args: Row) => unknown>,
  tables: Record<string, readonly Row[]> = {},
) {
  const calls: { fn: string; args: Row }[] = [];
  const db: PlatformDb = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      const handler = rpcs[fn];
      if (handler === undefined) throw new PlatformDbError(fn, "not scripted");
      return handler(args);
    },
    async selectOne(table, _columns, match) {
      return (
        (tables[table] ?? []).find((row) =>
          Object.entries(match).every(([k, v]) => row[k] === v),
        ) ?? null
      );
    },
  };
  return { db, calls };
}

describe("the Web Push stores over the 1533 RPCs", () => {
  it("reads the browsers A80's claim lists with no token", async () => {
    const { db } = fakeDb({
      claim_notification_deliveries: () => [
        {
          delivery_id: "d1",
          notification_id: "n1",
          org_id: "o1",
          recipient_person_id: "p1",
          kind: "approval.requested",
          category_code: "approvals",
          message_args: {},
          subject_table: null,
          subject_id: null,
          push_devices: [
            { subscriptionId: "sub-1", token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]" },
            { subscriptionId: "web-1", token: null },
          ],
        },
      ],
    });
    const [claimed] = await pushStore(db).claimPush(10);
    expect(claimed?.devices.map((d) => d.subscriptionId)).toEqual(["sub-1"]);
    expect(claimed?.browsers).toEqual(["web-1"]);
  });

  it("reads endpoints and records answers through the sender RPCs", async () => {
    const { db, calls } = fakeDb({
      web_push_devices: () => [
        { subscription_id: "web-1", endpoint: ENDPOINT, p256dh: "k", auth: "a", app: "Gateway" },
        { subscription_id: "web-2", endpoint: ENDPOINT, p256dh: "k", auth: "a", app: "Compass" },
      ],
      record_web_push_tickets: () => null,
    });
    const store = webPushStore(db);
    expect(await store.webDevices("d1")).toEqual([
      { subscriptionId: "web-1", endpoint: ENDPOINT, p256dh: "k", auth: "a", app: "Gateway" },
    ]);
    await store.recordWebTickets("d1", [
      { subscriptionId: "web-1", status: "ok", ticketId: null, error: null, message: null },
    ]);
    expect(calls.map((c) => c.fn)).toEqual(["web_push_devices", "record_web_push_tickets"]);
    expect(calls[0]?.args).toEqual({ p_delivery_id: "d1" });
  });

  it("links a push to the record in Atlas, the Inbox otherwise, and Home in Gateway", async () => {
    const { db } = fakeDb(
      {},
      {
        organizations: [{ id: "o1", slug: "northwind" }],
        records: [{ id: "r1", project_id: "pr1", record_number: 42 }],
        projects: [{ id: "pr1", project_key: "NWS" }],
      },
    );
    const base = { orgId: "o1", subjectTable: "records", subjectId: "r1" };
    expect(await webPushLink(db, base, "Atlas")).toBe("/northwind/r/NWS-42");
    expect(await webPushLink(db, { ...base, subjectTable: "timesheets" }, "Atlas")).toBe(
      "/northwind/inbox",
    );
    expect(await webPushLink(db, base, "Gateway")).toBe("/home");
    expect(await webPushLink(db, { ...base, orgId: "gone" }, "Atlas")).toBe("/");
  });
});
