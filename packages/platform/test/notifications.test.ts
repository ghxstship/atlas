/**
 * Push (Expo), SMS (Twilio), the SMS webhook and chat translation (A80, finding A65-012). Every provider
 * runs against a fake transport: nothing here reaches Expo, Twilio or Google.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { hasMessage } from "@xos/email";
import { locales } from "@xos/i18n";
import { NOTIFICATION_KINDS } from "@xos/schemas/notifications";
import { describe, expect, it } from "vitest";
import {
  EXPO_PUSH_RECEIPTS_URL,
  EXPO_PUSH_SEND_URL,
  GuardedSmsProvider,
  PlatformDbError,
  PushServiceError,
  RecordingPushClient,
  RecordingSmsProvider,
  SmsRecipientRefusedError,
  SmsSendError,
  TWILIO_API,
  TranslationUnavailableError,
  checkPushReceipts,
  clip,
  compassLink,
  createMessageTranslator,
  createPushClient,
  createSmsProvider,
  dispatchPush,
  dispatchSms,
  dispatchSmsSummaries,
  expoPushClient,
  googleLanguage,
  googleMessageTranslator,
  handleTwilioWebhook,
  notificationArgs,
  notificationText,
  outcomeOf,
  pushMessage,
  pushStore,
  readPushEnv,
  readSmsEnv,
  recipientProfile,
  smsInboundStore,
  smsKeyword,
  smsStore,
  staticAccessToken,
  translateChatMessage,
  translationOff,
  translationStore,
  twilioSignature,
  twilioSmsProvider,
  verifyTwilioSignature,
  workloadIdentityToken,
  type ClaimedPush,
  type ClaimedSms,
  type ClaimedSmsSummary,
  type DeviceTicket,
  type MessageTranslator,
  type PlatformDb,
  type PushClient,
  type PushMessage,
  type PushStore,
  type SmsInboundStore,
  type SmsStore,
  type SmsSummaryStore,
  type TranslationStore,
} from "../src/index.ts";

type Row = Readonly<Record<string, unknown>>;

/** A database answering RPCs from scripted handlers and reads by matching rows; records every call. */
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

/** A fetch that answers from a script and records each request. */
function fakeFetch(answer: (url: string, init: RequestInit, n: number) => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init: init ?? {} });
    return answer(url, init ?? {}, requests.length);
  }) as typeof fetch;
  return { impl, requests };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const NOTIFICATION_ID = "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f";
const noSleep = () => Promise.resolve();

describe("notification copy on every channel (Section 3.15)", () => {
  it("has a subject and a body for every registry kind in every locale, and SMS replies", () => {
    for (const locale of locales) {
      for (const k of NOTIFICATION_KINDS) {
        expect(hasMessage(locale, k.copy.subject), `${locale} ${k.kind}`).toBe(true);
        expect(hasMessage(locale, k.copy.body), `${locale} ${k.kind}`).toBe(true);
      }
      for (const key of ["sms.message", "sms.help", "sms.stop", "sms.start"])
        expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true);
    }
  });

  it("uses only push categories Compass registers with their actions (ADR 0030)", () => {
    const compass = readFileSync(
      new URL("../../../apps/compass/src/domain/notifications.ts", import.meta.url),
      "utf8",
    );
    const registered = [...compass.matchAll(/export const \w+_CATEGORY = "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    const used = [
      ...new Set(NOTIFICATION_KINDS.flatMap((k) => (k.pushCategory ? [k.pushCategory] : []))),
    ];
    expect(used.length).toBeGreaterThan(0);
    for (const category of used) expect(registered).toContain(category);
  });

  it("renders a kind's subject and body from the email catalog in the recipient's locale", () => {
    const args = { actorName: "Bob Okafor", title: "Rigging rental" };
    expect(notificationText("approval.requested", args, "en-US", "UTC")).toEqual({
      title: "Approval requested: Rigging rental",
      body: "Bob Okafor asked you to approve Rigging rental.",
    });
    expect(notificationText("approval.requested", args, "es-US", "UTC").title).toBe(
      "Aprobación solicitada: Rigging rental",
    );
  });

  it("formats ISO instants in the recipient's time zone and drops nested values", () => {
    const args = notificationArgs({
      title: "Load in",
      startsAt: "2026-11-03T14:00:00Z",
      count: 3,
      nested: { x: 1 },
    });
    expect(args["startsAt"]).toBeInstanceOf(Date);
    expect(args["nested"]).toBeUndefined();
    const text = notificationText(
      "shift.assigned",
      { title: "Load in", startsAt: "2026-11-03T14:00:00Z" },
      "en-US",
      "America/New_York",
    );
    expect(text.body).toContain("9:00");
    expect(() => notificationText("no.such_kind", {}, "en-US", "UTC")).toThrow(
      /Missing email message/,
    );
  });

  it("clips long text on a word boundary", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("one two three four five", 12)).toBe("one two…");
    expect(clip("abcdefghijklmnop", 6)).toBe("abcde…");
  });
});

// Push ------------------------------------------------------------------------------------------------

const DEVICE = { subscriptionId: "sub-1", token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]" };

const claim = (overrides: Partial<ClaimedPush> = {}): ClaimedPush => ({
  deliveryId: "d1",
  notificationId: NOTIFICATION_ID,
  orgId: "org-1",
  recipientPersonId: "p1",
  kind: "approval.requested",
  categoryCode: "approvals",
  messageArgs: { actorName: "Bob Okafor", title: "Timesheet week 44" },
  subjectTable: "timesheets",
  subjectId: "s1",
  devices: [DEVICE],
  ...overrides,
});

function pushFakeStore(claims: ClaimedPush[]) {
  const tickets: [string, readonly DeviceTicket[]][] = [];
  const records: [string, string, string | null, string | null][] = [];
  const store: PushStore = {
    claimPush: async () => claims,
    recipient: async (id) => ({
      name: "Dave",
      locale: id === "p2" ? "es-US" : "en-US",
      timeZone: "UTC",
    }),
    deepLink: async (c) =>
      c.kind === "explode.now" ? Promise.reject(new Error("no link")) : "compass://inbox",
    recordTickets: async (id, t) => {
      tickets.push([id, t]);
    },
    record: async (...args) => {
      records.push(args);
    },
    claimReceipts: async () => ["t-1", "t-2", "t-3"],
    recordReceipts: async (r) => r.filter((x) => x.error === "DeviceNotRegistered").length,
  };
  return { store, tickets, records };
}

describe("push through the Expo push service (ADR 0030)", () => {
  it("builds the ADR 0030 contract: actionable category, data and deep link", () => {
    const message = pushMessage(
      claim(),
      DEVICE,
      { name: "Dave", locale: "en-US", timeZone: "UTC" },
      "compass://inbox",
    );
    expect(message).toMatchObject({
      to: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]",
      title: "Approval requested: Timesheet week 44",
      categoryId: "approval_request",
      priority: "high",
      sound: "default",
      data: {
        notificationId: NOTIFICATION_ID,
        kind: "approval.requested",
        subjectTable: "timesheets",
        subjectId: "s1",
        title: "Timesheet week 44",
        url: "compass://inbox",
      },
    });
    const plain = pushMessage(
      claim({ kind: "comment.created", messageArgs: { actorName: "Bob", title: 7 } }),
      DEVICE,
      { name: "Dave", locale: "xx-XX", timeZone: "UTC" },
      "compass://inbox",
    );
    expect(plain.categoryId).toBeUndefined();
    expect(plain.priority).toBe("default");
    expect(plain.data["title"]).toBeNull();
  });

  it("pushes every device, stores a ticket each and records the delivery outcome", async () => {
    const client: PushClient = {
      name: "scripted",
      send: async (messages) =>
        messages.map((m, i) =>
          m.to.includes("dead")
            ? { status: "error", message: "not registered", error: "DeviceNotRegistered" }
            : { status: "ok", id: `t-${i}` },
        ),
      receipts: async () => ({}),
    };
    const { store, tickets, records } = pushFakeStore([
      claim({
        devices: [
          { subscriptionId: "sub-1", token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]" },
          { subscriptionId: "sub-2", token: "ExponentPushToken[deaddeaddeaddeaddead]" },
        ],
      }),
      claim({
        deliveryId: "d2",
        devices: [{ subscriptionId: "sub-3", token: "ExponentPushToken[deaddeaddeaddead0000]" }],
      }),
      claim({ deliveryId: "d3", devices: [] }),
      claim({ deliveryId: "d4", kind: "explode.now" }),
    ]);
    const summary = await dispatchPush(store, client);
    expect(summary).toEqual({ attempted: 4, sent: 2, failed: 1, bounced: 1, devices: 3 });
    expect(tickets.map(([id, t]) => [id, t.map((x) => x.status)])).toEqual([
      ["d1", ["ok", "error"]],
      ["d2", ["error"]],
    ]);
    expect(records.map((r) => [r[0], r[1]])).toEqual([
      ["d1", "Sent"],
      ["d2", "Bounced"],
      ["d3", "Sent"],
      ["d4", "Failed"],
    ]);
    expect(records[0]?.[2]).toBe("t-0");
    expect(records[3]?.[3]).toBe("no link");
  });

  it("batches 100 messages a request and fails a whole batch whose request failed", async () => {
    const sizes: number[] = [];
    let calls = 0;
    const client: PushClient = {
      name: "scripted",
      send: async (messages) => {
        calls += 1;
        sizes.push(messages.length);
        if (calls === 2) throw new PushServiceError(503, "Expo is down");
        return messages.map((_, i) => ({ status: "ok" as const, id: `t-${calls}-${i}` }));
      },
      receipts: async () => ({}),
    };
    const devices = Array.from({ length: 150 }, (_, i) => ({
      subscriptionId: `sub-${i}`,
      token: `ExponentPushToken[${String(i).padStart(20, "0")}]`,
    }));
    const { store, records } = pushFakeStore([
      claim({ devices: devices.slice(0, 100) }),
      claim({ deliveryId: "d2", devices: devices.slice(100) }),
    ]);
    const summary = await dispatchPush(store, client, { concurrency: 1 });
    expect(sizes).toEqual([100, 50]);
    expect(summary.sent).toBe(1);
    expect(records.find((r) => r[0] === "d2")?.slice(1, 2)).toEqual(["Failed"]);
    expect(records.find((r) => r[0] === "d2")?.[3]).toContain("Expo is down");
  });

  it("decides outcomes: Sent on any ticket, Bounced when every device is gone, Failed otherwise", () => {
    const ok: DeviceTicket = {
      subscriptionId: "a",
      status: "ok",
      ticketId: "t",
      error: null,
      message: null,
    };
    const gone: DeviceTicket = {
      subscriptionId: "b",
      status: "error",
      ticketId: null,
      error: "DeviceNotRegistered",
      message: "gone",
    };
    const rate: DeviceTicket = {
      subscriptionId: "c",
      status: "error",
      ticketId: null,
      error: "MessageRateExceeded",
      message: null,
    };
    expect(outcomeOf([gone, ok]).outcome).toBe("Sent");
    expect(outcomeOf([gone]).outcome).toBe("Bounced");
    expect(outcomeOf([gone, rate])).toMatchObject({
      outcome: "Failed",
      error: "gone; MessageRateExceeded",
    });
    expect(outcomeOf([]).outcome).toBe("Failed");
  });

  it("reads receipts and records them, pruning devices Expo no longer knows", async () => {
    const client: PushClient = {
      name: "scripted",
      send: async () => [],
      receipts: async () => ({
        "t-1": { status: "ok" },
        "t-2": { status: "error", message: "gone", error: "DeviceNotRegistered" },
      }),
    };
    const { store } = pushFakeStore([]);
    await expect(checkPushReceipts(store, client)).resolves.toEqual({ checked: 2, pruned: 1 });
    await expect(
      checkPushReceipts({ ...store, claimReceipts: async () => [] }, client),
    ).resolves.toEqual({ checked: 0, pruned: 0 });
    await expect(
      checkPushReceipts(store, { ...client, receipts: async () => ({}) }),
    ).resolves.toEqual({ checked: 0, pruned: 0 });
  });

  it("talks to Expo over REST with the optional access token, retrying rate limits with backoff", async () => {
    const waits: number[] = [];
    const { impl, requests } = fakeFetch((url, _init, n) => {
      if (url === EXPO_PUSH_SEND_URL && n === 1)
        return json({ errors: [{ code: "TOO_MANY_REQUESTS" }] }, 429, { "retry-after": "2" });
      if (url === EXPO_PUSH_SEND_URL)
        return json({
          data: [
            { status: "ok", id: "t-1" },
            { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
          ],
        });
      return json({
        data: {
          "t-1": { status: "ok" },
          "t-2": { status: "error", message: "bad", details: { error: "MessageTooBig" } },
        },
      });
    });
    const client = expoPushClient({
      accessToken: "expo-access-token-for-tests-only",
      fetch: impl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const message = pushMessage(
      claim(),
      DEVICE,
      { name: "D", locale: "en-US", timeZone: "UTC" },
      "compass://inbox",
    );
    await expect(client.send([message, message])).resolves.toEqual([
      { status: "ok", id: "t-1" },
      { status: "error", message: "gone", error: "DeviceNotRegistered" },
    ]);
    expect(waits).toEqual([2000]);
    const headers = requests[1]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer expo-access-token-for-tests-only");
    expect(JSON.parse(String(requests[1]?.init.body))[0].categoryId).toBe("approval_request");
    await expect(client.receipts(["t-1", "t-2"])).resolves.toEqual({
      "t-1": { status: "ok" },
      "t-2": { status: "error", message: "bad", error: "MessageTooBig" },
    });
    expect(requests.at(-1)?.url).toBe(EXPO_PUSH_RECEIPTS_URL);
    await expect(client.send(Array.from({ length: 101 }, () => message))).rejects.toBeInstanceOf(
      PushServiceError,
    );
  });

  it("gives up on client errors at once and on server errors after its attempts", async () => {
    const bad = expoPushClient({
      fetch: fakeFetch(() => new Response("bad request", { status: 400 })).impl,
      sleep: noSleep,
    });
    await expect(bad.send([])).rejects.toMatchObject({ status: 400 });
    const down = fakeFetch(() => {
      throw new Error("connection reset");
    });
    const flaky = expoPushClient({ fetch: down.impl, sleep: noSleep, attempts: 3 });
    await expect(flaky.receipts(["t"])).rejects.toMatchObject({
      status: 503,
      message: "connection reset",
    });
    expect(down.requests).toHaveLength(3);
    const noToken = fakeFetch(() => json({ data: [] }));
    await expoPushClient({ fetch: noToken.impl }).send([]);
    expect(
      (noToken.requests[0]?.init.headers as Record<string, string>)["Authorization"],
    ).toBeUndefined();
  });

  it("records pushes unless XOS_PUSH_TRANSPORT=expo, and validates the environment", async () => {
    expect(createPushClient(readPushEnv({})).name).toBe("record");
    expect(createPushClient(readPushEnv({ XOS_PUSH_TRANSPORT: "expo" })).name).toBe("expo");
    expect(() => readPushEnv({ XOS_PUSH_TRANSPORT: "fcm" })).toThrow(/XOS_PUSH_TRANSPORT/);
    const recording = new RecordingPushClient();
    const message = { to: "ExponentPushToken[x]" } as PushMessage;
    await expect(recording.send([message])).resolves.toEqual([
      { status: "ok", id: "recorded-push-1" },
    ]);
    await expect(recording.receipts(["a"])).resolves.toEqual({ a: { status: "ok" } });
    expect(recording.sent).toHaveLength(1);
  });
});

// SMS ---------------------------------------------------------------------------------------------------

const ACCOUNT = `AC${"0".repeat(32)}`;
const SERVICE = `MG${"0".repeat(32)}`;
const TOKEN = "0".repeat(32);

const sms = (overrides: Partial<ClaimedSms> = {}): ClaimedSms => ({
  deliveryId: "s1",
  orgId: "org-1",
  recipientPersonId: "p1",
  address: "+15555550100",
  kind: "shift.changed",
  messageArgs: { title: "Load in", startsAt: "2026-11-03T14:00:00Z" },
  ...overrides,
});

function smsFakeStore(claims: ClaimedSms[]) {
  const records: [string, string, string | null, string | null][] = [];
  const store: SmsStore = {
    claimSms: async () => claims,
    recipient: async (id) => ({
      name: "Dave",
      locale: id === "p2" ? "es-US" : "en-US",
      timeZone: "America/New_York",
    }),
    orgName: async () => "Northwind Live",
    linkFor: async () => "https://atlas.xos.test/northwind-live/inbox",
    record: async (...args) => {
      records.push(args);
    },
  };
  return { store, records };
}

describe("SMS through Twilio (Section 14.5)", () => {
  it("texts the org, the kind's body, the link and the opt-out line, and records each outcome", async () => {
    const provider = new RecordingSmsProvider();
    const { store, records } = smsFakeStore([
      sms(),
      sms({ deliveryId: "s2", recipientPersonId: "p2" }),
    ]);
    await expect(dispatchSms(store, provider)).resolves.toEqual({
      attempted: 2,
      sent: 2,
      failed: 0,
      bounced: 0,
    });
    expect(provider.sent[0]?.body).toBe(
      "Northwind Live: Your shift Load in now starts Tuesday, November 3, 2026 at 9:00 AM. https://atlas.xos.test/northwind-live/inbox Reply STOP to opt out.",
    );
    expect(provider.sent[1]?.body).toMatch(/Responde STOP para cancelar\.$/);
    expect(records.map((r) => [r[0], r[1], r[2]])).toEqual([
      ["s1", "Sent", "recorded-sms-1"],
      ["s2", "Sent", "recorded-sms-2"],
    ]);
  });

  it("bounces an error a retry cannot fix and retries anything else", async () => {
    let n = 0;
    const provider = {
      name: "scripted",
      send: async () => {
        n += 1;
        if (n === 1) throw new SmsSendError("unsubscribed", "21610", true);
        throw new Error("timeout");
      },
    };
    const { store, records } = smsFakeStore([sms(), sms({ deliveryId: "s2" })]);
    await expect(dispatchSms(store, provider)).resolves.toEqual({
      attempted: 2,
      sent: 0,
      failed: 1,
      bounced: 1,
    });
    expect(records.map((r) => r[1])).toEqual(["Bounced", "Failed"]);
  });

  it("posts to the Messages API from the Messaging Service with basic auth and the status callback", async () => {
    const { impl, requests } = fakeFetch((_url, _init, n) =>
      n === 1
        ? json({ sid: "SM-test-1", status: "accepted" }, 201)
        : n === 2
          ? json({ code: 21610, message: "Attempt to send to unsubscribed recipient" }, 400)
          : new Response("oops", { status: 500 }),
    );
    const provider = twilioSmsProvider({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      messagingServiceSid: SERVICE,
      statusCallbackUrl: "https://ref.supabase.test/functions/v1/sms-webhook",
      fetch: impl,
    });
    await expect(
      provider.send({ to: "+15555550100", body: "Hi", deliveryId: "s1" }),
    ).resolves.toEqual({
      providerMessageId: "SM-test-1",
    });
    expect(requests[0]?.url).toBe(`${TWILIO_API}/Accounts/${ACCOUNT}/Messages.json`);
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${btoa(`${ACCOUNT}:${TOKEN}`)}`);
    const form = new URLSearchParams(String(requests[0]?.init.body));
    expect(Object.fromEntries(form)).toEqual({
      To: "+15555550100",
      MessagingServiceSid: SERVICE,
      Body: "Hi",
      StatusCallback: "https://ref.supabase.test/functions/v1/sms-webhook",
    });
    await expect(
      provider.send({ to: "+15555550100", body: "Hi", deliveryId: "s2" }),
    ).rejects.toMatchObject({
      code: "21610",
      permanent: true,
    });
    await expect(
      provider.send({ to: "+15555550100", body: "Hi", deliveryId: "s3" }),
    ).rejects.toMatchObject({
      code: "500",
      permanent: false,
    });
    const offline = twilioSmsProvider({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      messagingServiceSid: SERVICE,
      fetch: fakeFetch(() => {
        throw new Error("dns");
      }).impl,
    });
    await expect(offline.send({ to: "+1", body: "x", deliveryId: "s" })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("records unless XOS_SMS_TRANSPORT=twilio with every secret, and guards recipients outside production", async () => {
    expect(createSmsProvider(readSmsEnv({})).name).toBe("record");
    expect(() => readSmsEnv({ XOS_SMS_TRANSPORT: "twilio" })).toThrow(
      /TWILIO_ACCOUNT_SID.*TWILIO_AUTH_TOKEN.*TWILIO_MESSAGING_SERVICE_SID.*XOS_SMS_HELP_CONTACT/,
    );
    expect(() => readSmsEnv({ TWILIO_ACCOUNT_SID: "AC123" })).toThrow(
      /AC followed by 32 hex digits/,
    );
    const env = readSmsEnv({
      XOS_SMS_TRANSPORT: "twilio",
      TWILIO_ACCOUNT_SID: ACCOUNT,
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_MESSAGING_SERVICE_SID: SERVICE,
      XOS_SMS_HELP_CONTACT: "help.xos.test",
      XOS_SMS_ALLOWLIST: "+15555550100, +15555550101",
    });
    expect(env.XOS_SMS_ALLOWLIST).toEqual(["+15555550100", "+15555550101"]);
    const sent = fakeFetch(() => json({ sid: "SM-1" }, 201));
    const provider = createSmsProvider(env, { fetch: sent.impl, statusCallbackUrl: null });
    expect(provider).toBeInstanceOf(GuardedSmsProvider);
    await expect(
      provider.send({ to: "+15555550199", body: "x", deliveryId: "s" }),
    ).rejects.toBeInstanceOf(SmsRecipientRefusedError);
    await expect(
      provider.send({ to: "+15555550100", body: "x", deliveryId: "s" }),
    ).resolves.toEqual({
      providerMessageId: "SM-1",
    });
    const open = new GuardedSmsProvider(new RecordingSmsProvider(), {
      allowed: [],
      deliverToAny: true,
    });
    await expect(
      open.send({ to: "+15555550199", body: "x", deliveryId: "s" }),
    ).resolves.toBeDefined();
  });
});

describe("the SMS webhook: STOP, START, HELP and status callbacks", () => {
  const url = "https://ref.supabase.test/functions/v1/sms-webhook";
  const inbound = (
    store: SmsInboundStore,
    params: Record<string, string>,
    signature?: string | null,
  ) =>
    (async () =>
      handleTwilioWebhook(
        {
          url,
          params,
          signature:
            signature === undefined ? await twilioSignature(url, params, TOKEN) : signature,
        },
        store,
        { authToken: TOKEN, helpContact: "help.xos.test" },
      ))();

  function inboundStore() {
    const keywords: [string, string, string][] = [];
    const statuses: [string, string, string | null][] = [];
    const store: SmsInboundStore = {
      recordKeyword: async (...args) => {
        keywords.push(args);
        return 1;
      },
      recordStatus: async (...args) => {
        statuses.push(args);
        return true;
      },
    };
    return { store, keywords, statuses };
  }

  it("reads Twilio's standard keywords on the whole message", () => {
    expect(smsKeyword(" stop ")).toEqual({ action: "Opt Out", keyword: "STOP" });
    expect(smsKeyword("Unsubscribe.")).toEqual({ action: "Opt Out", keyword: "UNSUBSCRIBE" });
    expect(smsKeyword("start")).toEqual({ action: "Opt In", keyword: "START" });
    expect(smsKeyword("HELP")).toEqual({ action: "Help", keyword: "HELP" });
    expect(smsKeyword("please stop texting me")).toBeNull();
  });

  it("computes Twilio's signature: HMAC-SHA1 of the URL and the sorted parameters", async () => {
    const params = { From: "+15555550100", Body: "STOP", AccountSid: ACCOUNT };
    const expected = createHmac("sha1", TOKEN)
      .update(`${url}AccountSid${ACCOUNT}BodySTOPFrom+15555550100`)
      .digest("base64");
    await expect(twilioSignature(url, params, TOKEN)).resolves.toBe(expected);
    await expect(verifyTwilioSignature(url, params, expected, TOKEN)).resolves.toBe(true);
    await expect(verifyTwilioSignature(url, params, "nope", TOKEN)).resolves.toBe(false);
    await expect(verifyTwilioSignature(url, params, null, TOKEN)).resolves.toBe(false);
  });

  it("refuses an unsigned or forged request", async () => {
    const { store, keywords } = inboundStore();
    await expect(
      inbound(store, { From: "+15555550100", Body: "STOP" }, null),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      inbound(store, { From: "+15555550100", Body: "STOP" }, "forged"),
    ).resolves.toMatchObject({ status: 403 });
    expect(keywords).toEqual([]);
  });

  it("records STOP with the STOP suppression and answers each keyword from the catalog", async () => {
    const { store, keywords } = inboundStore();
    const stop = await inbound(store, { From: "+15555550100", Body: "Stop" });
    expect(stop.status).toBe(200);
    expect(stop.contentType).toBe("text/xml");
    expect(stop.body).toContain("<Message>You will get no more texts from XOS notifications.");
    const help = await inbound(store, { From: "+15555550100", Body: "help" });
    expect(help.body).toContain("Help: help.xos.test. Reply STOP to opt out.");
    const start = await inbound(store, { From: "+15555550100", Body: "START" });
    expect(start.body).toContain("You will get XOS notifications by text again.");
    expect(keywords).toEqual([
      ["+15555550100", "Opt Out", "STOP"],
      ["+15555550100", "Help", "HELP"],
      ["+15555550100", "Opt In", "START"],
    ]);
    const other = await inbound(store, { From: "+15555550100", Body: "see you there" });
    expect(other.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    await inbound(store, { From: "not-a-number", Body: "STOP" });
    expect(keywords).toHaveLength(3);
  });

  it("records status callbacks by message SID", async () => {
    const { store, statuses } = inboundStore();
    const answer = await inbound(store, {
      MessageSid: "SM-1",
      MessageStatus: "undelivered",
      ErrorCode: "30003",
      ErrorMessage: "Unreachable",
    });
    expect(answer.status).toBe(204);
    await inbound(store, { MessageSid: "SM-2", MessageStatus: "delivered" });
    expect(statuses).toEqual([
      ["SM-1", "undelivered", "30003 Unreachable"],
      ["SM-2", "delivered", null],
    ]);
  });
});

// Chat translation ------------------------------------------------------------------------------------------

function translationFakeStore(overrides: Partial<TranslationStore> = {}) {
  const saved: unknown[][] = [];
  const store: TranslationStore = {
    message: async (id) =>
      id === "gone"
        ? null
        : { orgId: "org-1", body: id === "photo" ? null : "Hola equipo", language: "es-US" },
    enabled: async () => true,
    cached: async (id, target) =>
      id === "cached" && target === "en-US" ? "Hello team (cached)" : null,
    save: async (...args) => {
      saved.push(args);
    },
    ...overrides,
  };
  return { store, saved };
}

const echo: MessageTranslator = {
  provider: "echo",
  enabled: true,
  translate: async (r) => ({
    text: `[${r.targetLanguage}] ${r.text}`,
    detectedSourceLanguage: "es",
  }),
};

describe("chat message translation (Section 4.9)", () => {
  it("is off unless both the platform and the org turn it on", async () => {
    const { store, saved } = translationFakeStore();
    await expect(
      translateChatMessage(store, translationOff, { messageId: "m1", targetLanguage: "en-US" }),
    ).resolves.toEqual({ kind: "off" });
    const orgOff = translationFakeStore({ enabled: async () => false });
    await expect(
      translateChatMessage(orgOff.store, echo, { messageId: "m1", targetLanguage: "en-US" }),
    ).resolves.toEqual({ kind: "off" });
    await expect(
      translationOff.translate({ text: "x", targetLanguage: "en" }),
    ).rejects.toBeInstanceOf(TranslationUnavailableError);
    expect(saved).toEqual([]);
  });

  it("translates once, caches the result and skips messages already in the reader's language", async () => {
    const { store, saved } = translationFakeStore();
    await expect(
      translateChatMessage(store, echo, { messageId: "m1", targetLanguage: "en-US" }),
    ).resolves.toEqual({
      kind: "translated",
      text: "[en-US] Hola equipo",
      cached: false,
    });
    expect(saved).toEqual([["m1", "en-US", "[en-US] Hola equipo", "es-US", "echo"]]);
    await expect(
      translateChatMessage(store, echo, { messageId: "cached", targetLanguage: "en-US" }),
    ).resolves.toEqual({
      kind: "translated",
      text: "Hello team (cached)",
      cached: true,
    });
    await expect(
      translateChatMessage(store, echo, { messageId: "m1", targetLanguage: "es-MX" }),
    ).resolves.toEqual({
      kind: "same-language",
    });
    await expect(
      translateChatMessage(store, echo, { messageId: "photo", targetLanguage: "en-US" }),
    ).resolves.toMatchObject({
      kind: "unavailable",
    });
    await expect(
      translateChatMessage(store, echo, { messageId: "gone", targetLanguage: "en-US" }),
    ).resolves.toMatchObject({
      kind: "unavailable",
    });
    const failing = {
      ...echo,
      translate: () => Promise.reject(new TranslationUnavailableError("quota")),
    };
    await expect(
      translateChatMessage(store, failing, { messageId: "m1", targetLanguage: "fr-FR" }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "quota",
    });
  });

  it("calls Cloud Translation v3 with the access token and billing project, refreshing once after a 401", async () => {
    const refreshes: boolean[] = [];
    const { impl, requests } = fakeFetch((_url, _init, n) =>
      n === 1
        ? new Response("expired", { status: 401 })
        : json({ translations: [{ translatedText: "Hello team", detectedLanguageCode: "es" }] }),
    );
    const translator = googleMessageTranslator({
      project: "xos-translate-test",
      token: async (refresh = false) => {
        refreshes.push(refresh);
        return refresh ? "fresh-token" : "stale-token";
      },
      fetch: impl,
    });
    await expect(
      translator.translate({
        text: "Hola equipo",
        targetLanguage: "en-US",
        sourceLanguage: "es-US",
      }),
    ).resolves.toEqual({
      text: "Hello team",
      detectedSourceLanguage: "es",
    });
    expect(refreshes).toEqual([false, true]);
    expect(requests[1]?.url).toBe(
      "https://translation.googleapis.com/v3/projects/xos-translate-test/locations/global:translateText",
    );
    const headers = requests[1]?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer fresh-token");
    expect(headers["x-goog-user-project"]).toBe("xos-translate-test");
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
      contents: ["Hola equipo"],
      mimeType: "text/plain",
      targetLanguageCode: "en",
      sourceLanguageCode: "es",
      model: "projects/xos-translate-test/locations/global/models/general/nmt",
    });
    const denied = googleMessageTranslator({
      project: "xos-translate-test",
      token: staticAccessToken("t"),
      fetch: fakeFetch(() => new Response("no", { status: 403 })).impl,
    });
    await expect(denied.translate({ text: "x", targetLanguage: "en" })).rejects.toThrow(
      /answered 403/,
    );
    const always401 = googleMessageTranslator({
      project: "xos-translate-test",
      token: staticAccessToken("t"),
      fetch: fakeFetch(() => new Response("no", { status: 401 })).impl,
    });
    await expect(always401.translate({ text: "x", targetLanguage: "en" })).rejects.toThrow(
      /answered 401/,
    );
    expect(googleLanguage("pt-BR")).toBe("pt-BR");
    expect(googleLanguage("es-US")).toBe("es");
  });

  it("gets tokens through Workload Identity Federation without a stored key, and caches them", async () => {
    const expires = new Date(Date.now() + 3600_000).toISOString();
    const { impl, requests } = fakeFetch((url) =>
      url.startsWith("https://sts.googleapis.com")
        ? json({ access_token: "federated" })
        : json({ accessToken: "impersonated", expireTime: expires }),
    );
    const source = workloadIdentityToken({
      audience:
        "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v",
      serviceAccountEmail: "translate@xos-translate-test.iam.gserviceaccount.com",
      subjectToken: async () => "oidc-subject",
      fetch: impl,
    });
    await expect(source()).resolves.toBe("impersonated");
    await expect(source()).resolves.toBe("impersonated");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      subjectToken: "oidc-subject",
    });
    expect((requests[1]?.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer federated",
    );
    await source(true);
    expect(requests).toHaveLength(4);
    const refused = workloadIdentityToken({
      audience: "//iam.googleapis.com/x",
      serviceAccountEmail: "a@b.test",
      subjectToken: async () => "s",
      fetch: fakeFetch(() => new Response("", { status: 400 })).impl,
    });
    await expect(refused()).rejects.toThrow(/STS refused/);
    const noImpersonation = workloadIdentityToken({
      audience: "//iam.googleapis.com/x",
      serviceAccountEmail: "a@b.test",
      subjectToken: async () => "s",
      fetch: fakeFetch((u) =>
        u.startsWith("https://sts")
          ? json({ access_token: "f" })
          : new Response("", { status: 403 }),
      ).impl,
    });
    await expect(noImpersonation()).rejects.toThrow(/impersonation failed/);
  });

  it("builds the translator from the environment: off by default", () => {
    expect(createMessageTranslator({}).provider).toBe("off");
    expect(createMessageTranslator({ XOS_MESSAGE_TRANSLATION: "google" }).provider).toBe("off");
    expect(
      createMessageTranslator({
        XOS_MESSAGE_TRANSLATION: "google",
        GOOGLE_CLOUD_PROJECT: "xos-translate-test",
      }).provider,
    ).toBe("off");
    expect(
      createMessageTranslator({
        XOS_MESSAGE_TRANSLATION: "google",
        GOOGLE_CLOUD_PROJECT: "xos-translate-test",
        GOOGLE_OAUTH_ACCESS_TOKEN: "short-lived",
      }).provider,
    ).toBe("google");
    expect(
      createMessageTranslator(
        {
          XOS_MESSAGE_TRANSLATION: "google",
          GOOGLE_CLOUD_PROJECT: "xos-translate-test",
          GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: "//iam.googleapis.com/projects/1/x",
          GOOGLE_TRANSLATE_SERVICE_ACCOUNT: "translate@xos-translate-test.iam.gserviceaccount.com",
        },
        { subjectToken: async () => "oidc", fetch: fakeFetch(() => json({})).impl },
      ).provider,
    ).toBe("google");
    expect(createMessageTranslator({ XOS_MESSAGE_TRANSLATION: "deepl" }).provider).toBe("off");
  });
});

// Stores --------------------------------------------------------------------------------------------------------

describe("stores over the 1361 and 1363 RPCs", () => {
  it("reads the recipient's own language and time zone", async () => {
    const { db } = fakeDb(
      {},
      {
        people: [{ id: "p1", full_name: "Dave Lindqvist" }],
        personal_setting_values: [
          { person_id: "p1", setting_key: "locale.language", value_text: "es-US" },
          { person_id: "p1", setting_key: "locale.time_zone", value_text: "America/Chicago" },
        ],
      },
    );
    await expect(recipientProfile(db, "p1")).resolves.toEqual({
      name: "Dave Lindqvist",
      locale: "es-US",
      timeZone: "America/Chicago",
    });
    await expect(recipientProfile(db, "p9")).resolves.toEqual({
      name: "",
      locale: "en-US",
      timeZone: "UTC",
    });
  });

  it("writes in the language the org gives the recipient (app.recipient_language, 1397)", async () => {
    // The org locked es-US; the person's own en-US no longer decides the language.
    const { db, calls } = fakeDb(
      { recipient_language: () => "es-US" },
      {
        people: [{ id: "p1", full_name: "Dave Lindqvist" }],
        personal_setting_values: [
          { person_id: "p1", setting_key: "locale.language", value_text: "en-US" },
          { person_id: "p1", setting_key: "locale.time_zone", value_text: "America/Chicago" },
        ],
      },
    );
    await expect(recipientProfile(db, "p1", "org-1")).resolves.toEqual({
      name: "Dave Lindqvist",
      locale: "es-US",
      timeZone: "America/Chicago",
    });
    expect(calls).toEqual([
      { fn: "recipient_language", args: { p_org_id: "org-1", p_person_id: "p1" } },
    ]);
  });

  it("push store claims devices, records tickets, outcomes and receipts", async () => {
    const { db, calls } = fakeDb(
      {
        claim_notification_deliveries: () => [
          {
            delivery_id: "d1",
            notification_id: NOTIFICATION_ID,
            org_id: "org-1",
            recipient_person_id: "p1",
            kind: "approval.requested",
            category_code: "approvals",
            message_args: null,
            subject_table: "records",
            subject_id: "r1",
            push_devices: [
              { subscriptionId: "sub-1", token: "ExponentPushToken[a]" },
              { token: "broken" },
            ],
          },
        ],
        record_push_tickets: () => null,
        record_notification_delivery: () => null,
        claim_push_receipts: () => [{ ticket_id: "t-1" }],
        record_push_receipts: () => 2,
        recipient_language: () => "es-US",
      },
      {
        records: [{ id: "r1", project_id: "prj-1", record_number: 42 }],
        projects: [{ id: "prj-1", project_key: "NWL" }],
        organizations: [{ id: "org-1", slug: "northwind-live", name: "Northwind Live" }],
      },
    );
    const store = pushStore(db);
    const [claimed] = await store.claimPush(10);
    expect(claimed?.devices).toEqual([{ subscriptionId: "sub-1", token: "ExponentPushToken[a]" }]);
    expect(calls[0]?.args).toEqual({ p_channel: "Push", p_limit: 10 });
    if (claimed === undefined) throw new Error("claim expected");
    await expect(store.deepLink(claimed)).resolves.toBe("compass://r/NWL-42?org=northwind-live");
    await store.recordTickets("d1", []);
    await store.record("d1", "Sent", "t-1", null);
    await expect(store.claimReceipts(1000)).resolves.toEqual(["t-1"]);
    await expect(store.recordReceipts([])).resolves.toBe(2);
    await expect(store.recipient("p1", "org-1")).resolves.toMatchObject({ locale: "es-US" });
    expect(calls.map((c) => c.fn)).toEqual([
      "claim_notification_deliveries",
      "record_push_tickets",
      "record_notification_delivery",
      "claim_push_receipts",
      "record_push_receipts",
      "recipient_language",
    ]);
  });

  it("links pushes about anything but a known record to the Compass Inbox", async () => {
    const { db } = fakeDb({}, { records: [{ id: "r2", project_id: null }], organizations: [] });
    const base = { orgId: "org-1", subjectTable: "timesheets", subjectId: "t1" };
    await expect(compassLink(db, base)).resolves.toBe("compass://inbox");
    await expect(
      compassLink(db, { ...base, subjectTable: "records", subjectId: "r9" }),
    ).resolves.toBe("compass://inbox");
    await expect(
      compassLink(db, { ...base, subjectTable: "records", subjectId: "r2" }),
    ).resolves.toBe("compass://inbox");
    const noOrg = fakeDb(
      {},
      { records: [{ id: "r3", project_id: "p" }], projects: [{ id: "p", project_key: "NWL" }] },
    );
    await expect(
      compassLink(noOrg.db, { ...base, subjectTable: "app.records", subjectId: "r3" }),
    ).resolves.toBe("compass://inbox");
  });

  it("SMS stores claim numbers, link to the Inbox and record keywords and statuses", async () => {
    const { db, calls } = fakeDb(
      {
        claim_notification_deliveries: () => [
          {
            delivery_id: "s1",
            org_id: "org-1",
            recipient_person_id: "p1",
            address: "+15555550100",
            kind: "shift.changed",
            message_args: { title: "Load in" },
          },
        ],
        record_notification_delivery: () => null,
        record_sms_keyword: () => 2,
        record_sms_status: () => true,
        recipient_language: () => "en-US",
      },
      { organizations: [{ id: "org-1", slug: "northwind-live", name: "Northwind Live" }] },
    );
    const store = smsStore(db, { appUrl: "https://atlas.xos.test/" });
    const [claimed] = await store.claimSms(5);
    if (claimed === undefined) throw new Error("claim expected");
    await expect(store.orgName("org-1")).resolves.toBe("Northwind Live");
    await expect(store.linkFor(claimed)).resolves.toBe(
      "https://atlas.xos.test/northwind-live/inbox",
    );
    await store.record("s1", "Bounced", null, "21610");
    await expect(store.recipient("p1", "org-1")).resolves.toMatchObject({ timeZone: "UTC" });
    const inboundStore = smsInboundStore(db);
    await expect(inboundStore.recordKeyword("+15555550100", "Opt Out", "STOP")).resolves.toBe(2);
    await expect(inboundStore.recordStatus("SM-1", "delivered", null)).resolves.toBe(true);
    expect(calls.at(-2)?.args).toEqual({
      p_phone_e164: "+15555550100",
      p_action: "Opt Out",
      p_keyword: "STOP",
    });
    const odd = smsInboundStore(
      fakeDb({ record_sms_keyword: () => null, record_sms_status: () => null }).db,
    );
    await expect(odd.recordKeyword("+1", "Help", "HELP")).resolves.toBe(0);
    await expect(odd.recordStatus("SM-2", "sent", null)).resolves.toBe(false);
  });

  it("translation store reads the message, the setting and the cache, and saves through the RPC", async () => {
    const { db, calls } = fakeDb(
      { message_translation_enabled: () => true, record_chat_message_translation: () => null },
      {
        chat_messages: [
          { id: "m1", org_id: "org-1", body: "Hola", language: "es-US", deleted_at: null },
          {
            id: "m2",
            org_id: "org-1",
            body: "Bye",
            language: "en-US",
            deleted_at: "2026-10-20T00:00:00Z",
          },
        ],
        chat_message_translations: [
          { chat_message_id: "m1", target_language: "en-US", body: "Hello" },
        ],
      },
    );
    const store = translationStore(db);
    await expect(store.message("m1")).resolves.toEqual({
      orgId: "org-1",
      body: "Hola",
      language: "es-US",
    });
    await expect(store.message("m2")).resolves.toBeNull();
    await expect(store.message("m3")).resolves.toBeNull();
    await expect(store.enabled("org-1")).resolves.toBe(true);
    await expect(store.cached("m1", "en-US")).resolves.toBe("Hello");
    await expect(store.cached("m1", "fr-FR")).resolves.toBeNull();
    await store.save("m1", "fr-FR", "Bonjour", "es-US", "google");
    expect(calls.at(-1)).toEqual({
      fn: "record_chat_message_translation",
      args: {
        p_chat_message_id: "m1",
        p_target_language: "fr-FR",
        p_body: "Bonjour",
        p_source_language: "es-US",
        p_provider: "google",
      },
    });
  });
});

// Quiet hours (ADR 0033 decision 35) ---------------------------------------------------------------------------

describe("texts held by quiet hours go out as one summary", () => {
  const held = (overrides: Partial<ClaimedSmsSummary> = {}): ClaimedSmsSummary => ({
    orgId: "org-1",
    recipientPersonId: "p1",
    address: "+15555550100",
    deliveryIds: ["d1", "d2", "d3"],
    heldCount: 3,
    kind: "account.security_changed",
    messageArgs: { change: "password" },
    ...overrides,
  });

  function summaryStore(summaries: ClaimedSmsSummary[]) {
    const records: [readonly string[], string, string | null, string | null][] = [];
    const store: SmsSummaryStore = {
      claimSummaries: async () => summaries,
      recipient: async (id) => ({
        name: "Dave",
        locale: id === "p2" ? "es-US" : "en-US",
        timeZone: "UTC",
      }),
      orgName: async () => "Northwind Live",
      inboxLink: async () => "https://atlas.xos.test/northwind-live/inbox",
      recordSummary: async (...args) => {
        records.push(args);
      },
    };
    return { store, records };
  }

  it("sends one text per member and org with the count and the most important line", async () => {
    const provider = new RecordingSmsProvider();
    const { store, records } = summaryStore([
      held(),
      held({ recipientPersonId: "p2", deliveryIds: ["d4", "d5"], heldCount: 2 }),
      held({
        deliveryIds: ["d6"],
        heldCount: 1,
        kind: "approval.requested",
        messageArgs: { actorName: "Bob", title: "Catering" },
      }),
    ]);
    await expect(dispatchSmsSummaries(store, provider)).resolves.toEqual({
      attempted: 3,
      sent: 3,
      failed: 0,
      bounced: 0,
    });
    expect(provider.sent[0]?.body).toBe(
      "Northwind Live: 3 updates came in during your quiet hours. Most important: A security setting on your account changed: password. If this was not you, reset your password now. https://atlas.xos.test/northwind-live/inbox Reply STOP to opt out.",
    );
    expect(provider.sent[1]?.body).toMatch(
      /^Northwind Live: 2 novedades llegaron durante tus horas de silencio\./,
    );
    // A single held text reads like any other notification.
    expect(provider.sent[2]?.body).toBe(
      "Northwind Live: Bob asked you to approve Catering. https://atlas.xos.test/northwind-live/inbox Reply STOP to opt out.",
    );
    expect(records.map((r) => [r[0], r[1], r[2]])).toEqual([
      [["d1", "d2", "d3"], "Sent", "recorded-sms-1"],
      [["d4", "d5"], "Sent", "recorded-sms-2"],
      [["d6"], "Sent", "recorded-sms-3"],
    ]);
    expect(provider.sent).toHaveLength(3);
  });

  it("settles every held delivery with the failure: Bounced when a retry cannot fix it, Failed otherwise", async () => {
    let n = 0;
    const provider = {
      name: "scripted",
      send: async () => {
        n += 1;
        if (n === 1) throw new SmsSendError("unsubscribed", "21610", true);
        throw new Error("timeout");
      },
    };
    const { store, records } = summaryStore([held(), held({ deliveryIds: ["d9"], heldCount: 1 })]);
    await expect(dispatchSmsSummaries(store, provider)).resolves.toEqual({
      attempted: 2,
      sent: 0,
      failed: 1,
      bounced: 1,
    });
    expect(records.map((r) => [r[0].length, r[1]])).toEqual([
      [3, "Bounced"],
      [1, "Failed"],
    ]);
  });

  it("claims and records summaries through the 1367 RPCs", async () => {
    const { db, calls } = fakeDb(
      {
        claim_sms_summaries: () => [
          {
            org_id: "org-1",
            recipient_person_id: "p1",
            address: "+15555550100",
            delivery_ids: ["d1", "d2", 7],
            held_count: 2,
            kind: "approval.requested",
            message_args: null,
          },
          {
            org_id: "org-1",
            recipient_person_id: "p1",
            address: "+1",
            delivery_ids: null,
            held_count: null,
            kind: "x.y",
          },
        ],
        record_sms_summary: () => null,
      },
      { organizations: [{ id: "org-1", slug: "northwind-live", name: "Northwind Live" }] },
    );
    const store = smsStore(db, { appUrl: "https://atlas.xos.test" });
    const [first, second] = await store.claimSummaries(25);
    expect(first).toMatchObject({ deliveryIds: ["d1", "d2"], heldCount: 2, messageArgs: {} });
    expect(second).toMatchObject({ deliveryIds: [], heldCount: 0 });
    await expect(store.inboxLink("org-1")).resolves.toBe(
      "https://atlas.xos.test/northwind-live/inbox",
    );
    await store.recordSummary(["d1", "d2"], "Sent", "SM-1", null);
    expect(calls.at(-1)).toEqual({
      fn: "record_sms_summary",
      args: {
        p_delivery_ids: ["d1", "d2"],
        p_status: "Sent",
        p_provider_message_id: "SM-1",
        p_error: null,
      },
    });
    expect(calls[0]?.args).toEqual({ p_limit: 25 });
  });

  it("keeps the bypass list short and in the registry", () => {
    expect(
      NOTIFICATION_KINDS.filter((k) => k.quietHoursBypass !== null).map((k) => k.kind),
    ).toEqual(["shift.changed", "incident.reported", "occupancy.threshold", "weather.alert"]);
  });
});
