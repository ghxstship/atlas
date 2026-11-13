/**
 * Push (Expo), SMS (sent.dm), the SMS webhook and chat translation (A80, finding A65-012). Every provider
 * runs against a fake transport: nothing here reaches Expo, sent.dm or Google.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { hasMessage } from "@xos/email";
import { locales } from "@xos/i18n";
import { copyKeys, NOTIFICATION_KINDS } from "@xos/schemas/notifications";
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
  SENTDM_API,
  SENTDM_REPLAY_WINDOW_SECONDS,
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
  handleSentdmWebhook,
  notificationArgs,
  notificationText,
  outcomeOf,
  pushMessage,
  pushStore,
  readPushEnv,
  readSmsEnv,
  recipientProfile,
  sentdmHeaders,
  sentdmSignature,
  sentdmSmsProvider,
  smartEncode,
  smsAutoReplies,
  smsDeliveryStatus,
  smsInboundStore,
  smsKeyword,
  smsSegments,
  smsStore,
  staticAccessToken,
  templateValue,
  translateChatMessage,
  translationOff,
  translationStore,
  verifySentdmSignature,
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
        expect(hasMessage(locale, copyKeys(k.kind).subject), `${locale} ${k.kind}`).toBe(true);
        expect(hasMessage(locale, copyKeys(k.kind).body), `${locale} ${k.kind}`).toBe(true);
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
    const [ticket] = await recording.send([message]);
    expect(ticket).toEqual({
      status: "ok",
      id: expect.stringMatching(/^recorded-push-[0-9a-f]{8}-1$/),
    });
    // Each run of the sender makes a new client; its ticket ids never repeat an earlier run's.
    const [next] = await new RecordingPushClient().send([message]);
    expect(next).not.toEqual(ticket);
    await expect(recording.receipts(["a"])).resolves.toEqual({ a: { status: "ok" } });
    expect(recording.sent).toHaveLength(1);
  });
});

// SMS ---------------------------------------------------------------------------------------------------

/** The em dash, built from its code point because the finish guard keeps the literal out of the source. */
const EM_DASH = String.fromCharCode(0x2014);
/** A test-only API key and signing secret: never a real sent.dm credential. */
const API_KEY = "test-sentdm-key-0000000000000000";
const WEBHOOK_SECRET = `whsec_${Buffer.from("x".repeat(32)).toString("base64")}`;

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
  const records: Parameters<SmsStore["record"]>[] = [];
  const store: SmsStore = {
    claimSms: async () => claims,
    recipient: async (id) => ({
      name: "Dave",
      locale: id === "p2" ? "es-US" : "en-US",
      timeZone: "America/New_York",
    }),
    senderName: async () => "Northwind Live",
    linkFor: async () => "https://atlas.xos.test/northwind-live/inbox",
    record: async (...args) => {
      records.push(args);
    },
  };
  return { store, records };
}

describe("SMS through sent.dm (Section 14.5)", () => {
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
    // Each sent text counts the segments it is billed as: English fits GSM-7, Spanish accents need UCS-2.
    expect(records.map((r) => [r[0], r[1], r[2], r[4]])).toEqual([
      ["s1", "Sent", "recorded-sms-1", 1],
      ["s2", "Sent", "recorded-sms-2", smsSegments(provider.sent[1]?.body ?? "")],
    ]);
    expect(records[1]?.[4]).toBeGreaterThan(1);
  });

  it("counts the segments a text is billed as (sms_segments meter)", () => {
    expect(smsSegments("")).toBe(1);
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
    // Extension characters take two septets.
    expect(smsSegments("€".repeat(80))).toBe(1);
    expect(smsSegments("€".repeat(81))).toBe(2);
    // One character outside GSM-7 makes the whole text UCS-2.
    expect(smsSegments(`Lo más importante ${"a".repeat(52)}`)).toBe(1);
    expect(smsSegments(`Lo más importante ${"a".repeat(53)}`)).toBe(2);
    expect(smsSegments("á".repeat(134))).toBe(2);
    expect(smsSegments("á".repeat(135))).toBe(3);
    // The sender swaps an ellipsis, curly quotes and odd spaces for their GSM look-alikes (smartEncode).
    expect(smsSegments(`${"a".repeat(157)}…`)).toBe(1);
    expect(smsSegments("\u201cLoad in\u201d \u2014 9:00\u202fAM")).toBe(1);
  });

  it("meters the provider's segment count when it gives one", async () => {
    const provider = {
      name: "scripted",
      send: async () => ({ providerMessageId: "m-seg", segments: 4 }),
    };
    const zero = {
      name: "scripted",
      send: async () => ({ providerMessageId: "m-0", segments: 0 }),
    };
    const { store, records } = smsFakeStore([sms()]);
    await dispatchSms(store, provider);
    await dispatchSms(store, zero);
    expect(records.map((r) => r[4])).toEqual([4, 1]);
  });

  it("bounces an error a retry cannot fix and retries anything else", async () => {
    let n = 0;
    const provider = {
      name: "scripted",
      send: async () => {
        n += 1;
        if (n === 1) throw new SmsSendError("opted out", "BUSINESS_004", true);
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

  it("keeps a text GSM-7 and a template value on one line", () => {
    expect(smartEncode(`\u201cLoad in\u201d ${EM_DASH} 9:00\u202fAM\u2026`)).toBe(
      '"Load in" - 9:00 AM...',
    );
    expect(templateValue("Line one\nLine two\t\tend      gap ")).toBe(
      "Line one Line two end    gap",
    );
  });

  it("posts the approved template to the Messages API with the key, the channel and an idempotency key per delivery", async () => {
    const accepted = (id: string) =>
      json(
        {
          success: true,
          data: {
            status: "QUEUED",
            recipients: [{ message_id: id, to: "+15555550100", channel: "sms" }],
          },
          error: null,
        },
        202,
      );
    const refused = (status: number, code: string, message: string) =>
      json({ success: false, status, error: { code, message } }, status);
    const { impl, requests } = fakeFetch((_url, _init, n) =>
      n === 1
        ? accepted("m-1")
        : n === 2
          ? refused(400, "BUSINESS_004", "Recipient has opted out")
          : n === 3
            ? refused(422, "CONFLICT_005", "Idempotency key reused with a different body")
            : n === 4
              ? refused(429, "RATE_LIMIT_001", "Too many requests")
              : new Response("oops", { status: 500 }),
    );
    const provider = sentdmSmsProvider({
      apiKey: API_KEY,
      template: "xos_notification",
      templateVariable: "message",
      channel: "sms",
      fetch: impl,
    });
    await expect(
      provider.send({ to: "+15555550100", body: `Hi ${EM_DASH} there\nnow`, deliveryId: "s1" }),
    ).resolves.toEqual({ providerMessageId: "m-1", segments: 1 });
    expect(requests[0]?.url).toBe(`${SENTDM_API}/messages`);
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers["Idempotency-Key"]).toBe("xos-sms-s1");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      to: ["+15555550100"],
      template: { name: "xos_notification", parameters: { message: "Hi - there now" } },
      channel: ["sms"],
    });
    await expect(
      provider.send({ to: "+15555550100", body: "Hi", deliveryId: "s2" }),
    ).rejects.toMatchObject({ code: "BUSINESS_004", permanent: true });
    // A reused key whose first request succeeded: the text went out, so it is never sent again.
    await expect(
      provider.send({ to: "+15555550100", body: "Hi", deliveryId: "s3" }),
    ).rejects.toMatchObject({ code: "CONFLICT_005", permanent: true });
    await expect(
      provider.send({ to: "+15555550100", body: "Hi", deliveryId: "s4" }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT_001", permanent: false });
    await expect(
      provider.send({ to: "+15555550100", body: "Hi", deliveryId: "s5" }),
    ).rejects.toMatchObject({ code: "500", permanent: false });

    // A template id, WhatsApp, and sandbox mode.
    const other = fakeFetch(() => accepted("m-2"));
    const whatsapp = sentdmSmsProvider({
      apiKey: API_KEY,
      template: "7ba7b820-9dad-11d1-80b4-00c04fd430c8",
      templateVariable: "body",
      channel: "whatsapp",
      sandbox: true,
      fetch: other.impl,
    });
    await whatsapp.send({ to: "+15555550100", body: "Hi", deliveryId: "w1" });
    expect(JSON.parse(String(other.requests[0]?.init.body))).toEqual({
      to: ["+15555550100"],
      template: { id: "7ba7b820-9dad-11d1-80b4-00c04fd430c8", parameters: { body: "Hi" } },
      channel: ["whatsapp"],
      sandbox: true,
    });
    const auto = fakeFetch(() => accepted("m-3"));
    await sentdmSmsProvider({
      apiKey: API_KEY,
      template: "xos_notification",
      templateVariable: "message",
      channel: "auto",
      fetch: auto.impl,
    }).send({ to: "+15555550100", body: "Hi", deliveryId: "a1" });
    expect(JSON.parse(String(auto.requests[0]?.init.body))).not.toHaveProperty("channel");

    const offline = sentdmSmsProvider({
      apiKey: API_KEY,
      template: "xos_notification",
      templateVariable: "message",
      channel: "sms",
      fetch: fakeFetch(() => {
        throw new Error("dns");
      }).impl,
    });
    await expect(offline.send({ to: "+1", body: "x", deliveryId: "s" })).rejects.toMatchObject({
      code: "network",
      permanent: false,
    });
  });

  it("records unless XOS_SMS_TRANSPORT=sentdm with the key, and guards recipients outside production", async () => {
    expect(createSmsProvider(readSmsEnv({})).name).toBe("record");
    expect(() => readSmsEnv({ XOS_SMS_TRANSPORT: "sentdm" })).toThrow(
      /SENT_DM_API_KEY.*XOS_SMS_HELP_CONTACT/,
    );
    expect(() => readSmsEnv({ XOS_SMS_TRANSPORT: "twilio" })).toThrow(/XOS_SMS_TRANSPORT/);
    expect(() => readSmsEnv({ SENT_DM_WEBHOOK_SECRET: "secret" })).toThrow(
      /whsec_ followed by the base64 key/,
    );
    // The error names the variable, never its value.
    expect(() => readSmsEnv({ SENT_DM_API_KEY: "short-key" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("short-key") }),
    );
    const env = readSmsEnv({
      XOS_SMS_TRANSPORT: "sentdm",
      SENT_DM_API_KEY: API_KEY,
      XOS_SMS_HELP_CONTACT: "help.xos.test",
      XOS_SMS_ALLOWLIST: "+15555550100, +15555550101",
    });
    expect(env.XOS_SMS_ALLOWLIST).toEqual(["+15555550100", "+15555550101"]);
    expect(env.XOS_SENTDM_TEMPLATE).toBe("xos_notification");
    expect(env.XOS_SENTDM_CHANNEL).toBe("sms");
    expect(env.XOS_SENTDM_SANDBOX).toBe(false);
    const sent = fakeFetch(() =>
      json({ success: true, data: { recipients: [{ message_id: "m-1" }] } }, 202),
    );
    const provider = createSmsProvider(env, { fetch: sent.impl });
    expect(provider).toBeInstanceOf(GuardedSmsProvider);
    expect(provider.name).toBe("sentdm");
    await expect(
      provider.send({ to: "+15555550199", body: "x", deliveryId: "s" }),
    ).rejects.toBeInstanceOf(SmsRecipientRefusedError);
    await expect(
      provider.send({ to: "+15555550100", body: "x", deliveryId: "s" }),
    ).resolves.toEqual({ providerMessageId: "m-1", segments: 1 });
    const open = new GuardedSmsProvider(new RecordingSmsProvider(), {
      allowed: [],
      deliverToAny: true,
    });
    await expect(
      open.send({ to: "+15555550199", body: "x", deliveryId: "s" }),
    ).resolves.toBeDefined();
  });

  it("gives the owner the HELP, STOP and START auto-replies in each language", async () => {
    const replies = await smsAutoReplies("help.xos.test");
    expect(replies["en-US"].help).toContain("Help: help.xos.test. Reply STOP to opt out.");
    expect(replies["en-US"].stop).toContain("You will get no more texts from XOS notifications.");
    expect(replies["en-US"].start).toContain("You will get XOS notifications by text again.");
    expect(replies["es-US"].stop).toMatch(/START/);
    expect(replies["es-US"].help).toContain("help.xos.test");
  });
});

describe("the SMS webhook: sent.dm's signed events", () => {
  const NOW = 1_794_400_000;
  const signed = async (
    event: unknown,
    options: { secret?: string; at?: number; id?: string; version?: 1 | 2 } = {},
  ) => {
    const rawBody = JSON.stringify(event);
    const id = options.id ?? "msg_2LJ0F8sZf3";
    const timestamp = String(options.at ?? NOW);
    const signature = await sentdmSignature(
      id,
      timestamp,
      rawBody,
      options.secret ?? WEBHOOK_SECRET,
    );
    const names =
      options.version === 1
        ? { id: "x-webhook-id", timestamp: "x-webhook-timestamp", signature: "x-webhook-signature" }
        : { id: "webhook-id", timestamp: "webhook-timestamp", signature: "webhook-signature" };
    const sent: Record<string, string> = {
      [names.id]: id,
      [names.timestamp]: timestamp,
      [names.signature]: signature,
    };
    return { headers: sentdmHeaders((name) => sent[name] ?? null), rawBody };
  };
  const handle = (store: SmsInboundStore, request: Awaited<ReturnType<typeof signed>>) =>
    handleSentdmWebhook(request, store, { webhookSecret: WEBHOOK_SECRET, nowSeconds: NOW });

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

  const received = (text: string, from = "+15555550100") => ({
    field: "message",
    event: "message.received",
    payload: {
      message_id: "in-1",
      inbound_number: from,
      outbound_number: "+18005550100",
      text,
      channel: "sms",
    },
  });

  it("reads the standard keywords on the whole message", () => {
    expect(smsKeyword(" stop ")).toEqual({ action: "Opt Out", keyword: "STOP" });
    expect(smsKeyword("Unsubscribe.")).toEqual({ action: "Opt Out", keyword: "UNSUBSCRIBE" });
    expect(smsKeyword("start")).toEqual({ action: "Opt In", keyword: "START" });
    expect(smsKeyword("subscribe")).toEqual({ action: "Opt In", keyword: "SUBSCRIBE" });
    expect(smsKeyword("HELP")).toEqual({ action: "Help", keyword: "HELP" });
    expect(smsKeyword("please stop texting me")).toBeNull();
  });

  it("computes sent.dm's signature: v1, HMAC-SHA256 of id.timestamp.body with the decoded secret", async () => {
    const body = '{"event":"message.received"}';
    const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
    const expected = `v1,${createHmac("sha256", key).update(`msg_1.${NOW}.${body}`).digest("base64")}`;
    await expect(sentdmSignature("msg_1", String(NOW), body, WEBHOOK_SECRET)).resolves.toBe(
      expected,
    );
    const headers = { id: "msg_1", timestamp: String(NOW), signature: expected };
    await expect(verifySentdmSignature(headers, body, WEBHOOK_SECRET, NOW)).resolves.toBe(true);
    // Any one of several space-separated signatures may match (a rotation).
    await expect(
      verifySentdmSignature(
        { ...headers, signature: `v1,old ${expected}` },
        body,
        WEBHOOK_SECRET,
        NOW,
      ),
    ).resolves.toBe(true);
    await expect(verifySentdmSignature(headers, `${body} `, WEBHOOK_SECRET, NOW)).resolves.toBe(
      false,
    );
    await expect(
      verifySentdmSignature({ ...headers, signature: null }, body, WEBHOOK_SECRET, NOW),
    ).resolves.toBe(false);
    // Outside the five-minute window, either way.
    await expect(
      verifySentdmSignature(headers, body, WEBHOOK_SECRET, NOW + SENTDM_REPLAY_WINDOW_SECONDS + 1),
    ).resolves.toBe(false);
    await expect(
      verifySentdmSignature(headers, body, WEBHOOK_SECRET, NOW - SENTDM_REPLAY_WINDOW_SECONDS - 1),
    ).resolves.toBe(false);
  });

  it("refuses an unsigned, forged or stale request and writes nothing", async () => {
    const { store, keywords } = inboundStore();
    const good = await signed(received("STOP"));
    await expect(
      handle(store, { ...good, headers: { ...good.headers, signature: null } }),
    ).resolves.toMatchObject({ status: 401 });
    const forged = await signed(received("STOP"), {
      secret: `whsec_${Buffer.from("y".repeat(32)).toString("base64")}`,
    });
    await expect(handle(store, forged)).resolves.toMatchObject({ status: 401 });
    const stale = await signed(received("STOP"), { at: NOW - 3600 });
    await expect(handle(store, stale)).resolves.toMatchObject({ status: 401 });
    expect(keywords).toEqual([]);
  });

  it("records STOP, HELP and START from message.received, on version 1 and 2 headers, and sends no reply", async () => {
    const { store, keywords } = inboundStore();
    const stop = await handle(store, await signed(received("Stop")));
    expect(stop).toEqual({ status: 204, contentType: "text/plain", body: "" });
    await handle(store, await signed(received("help"), { version: 1 }));
    await handle(store, await signed(received("START")));
    expect(keywords).toEqual([
      ["+15555550100", "Opt Out", "STOP"],
      ["+15555550100", "Help", "HELP"],
      ["+15555550100", "Opt In", "START"],
    ]);
    await handle(store, await signed(received("see you there")));
    await handle(store, await signed(received("STOP", "not-a-number")));
    expect(keywords).toHaveLength(3);
  });

  it("records a network-reported opt-out, and leaves a keyword's own contact event to message.received", async () => {
    const { store, keywords } = inboundStore();
    const contact = (event: string, source: string) => ({
      field: "contact",
      event,
      payload: { from: "+15555550100", to: "+18005550100", source, channel: "sms" },
    });
    await handle(store, await signed(contact("contact.opt_out", "INBOUND_KEYWORD")));
    await handle(store, await signed(contact("contact.opt_out", "PROVIDER_SIGNAL")));
    await handle(store, await signed(contact("contact.opt_in", "PROVIDER_SIGNAL")));
    expect(keywords).toEqual([
      ["+15555550100", "Opt Out", "PROVIDER_SIGNAL"],
      ["+15555550100", "Opt In", "PROVIDER_SIGNAL"],
    ]);
  });

  it("records delivery events by message id: delivered and read, or failed with sent.dm's reason", async () => {
    const { store, statuses } = inboundStore();
    const status = (event: string, message_status: string, extra: Record<string, string> = {}) => ({
      field: "message",
      event,
      payload: {
        message_id: `m-${message_status}`,
        message_status,
        channel: "sms",
        body: null,
        ...extra,
      },
    });
    const answer = await handle(
      store,
      await signed(
        status("message.failed", "FAILED", {
          reason_code: "DELIVERY_011",
          reason: "The carrier rejected the message",
        }),
      ),
    );
    expect(answer.status).toBe(204);
    await handle(store, await signed(status("message.delivered", "DELIVERED")));
    await handle(store, await signed(status("message.read", "READ")));
    await handle(
      store,
      await signed(
        status("message.blocked", "BLOCKED", { reason_code: "CONVERSATION_TEMPLATE_REQUIRED" }),
      ),
    );
    await handle(store, await signed(status("message.sent", "SENT")));
    await handle(store, await signed(status("message.queued", "QUEUED")));
    await handle(
      store,
      await signed({ field: "templates", event: "templates.approved", payload: {} }),
    );
    expect(statuses).toEqual([
      ["m-FAILED", "failed", "DELIVERY_011 The carrier rejected the message"],
      ["m-DELIVERED", "delivered", null],
      ["m-READ", "delivered", null],
      ["m-BLOCKED", "failed", "CONVERSATION_TEMPLATE_REQUIRED"],
    ]);
    expect(smsDeliveryStatus("cancelled")).toBe("failed");
    expect(smsDeliveryStatus("SCHEDULED")).toBeNull();
  });

  it("answers 400 to a signed body that is not JSON", async () => {
    const { store } = inboundStore();
    const id = "msg_bad";
    const timestamp = String(NOW);
    const rawBody = "not json";
    const signature = await sentdmSignature(id, timestamp, rawBody, WEBHOOK_SECRET);
    await expect(
      handle(store, { headers: { id, timestamp, signature }, rawBody }),
    ).resolves.toMatchObject({ status: 400 });
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
  it("reads the recipient's live language and zone in the org (app.recipient_setting, 1393)", async () => {
    const { db, calls } = fakeDb(
      {
        // The database answers with live values only, one kept for this org over the one for every org, and
        // the zone the org reaches the person in.
        recipient_setting: (args) =>
          args["p_person_id"] === "p1" && args["p_setting_key"] === "locale.time_zone"
            ? "America/Chicago"
            : null,
      },
      {
        people: [{ id: "p1", full_name: "Dave Lindqvist" }],
        // A cleared (soft-deleted) Spanish setting: reading the table directly would still pick it up.
        personal_setting_values: [
          {
            person_id: "p1",
            setting_key: "locale.language",
            value_text: "es-US",
            deleted_at: "2026-10-20T00:00:00Z",
          },
        ],
      },
    );
    await expect(recipientProfile(db, "p1", "org-1")).resolves.toEqual({
      name: "Dave Lindqvist",
      locale: "en-US",
      timeZone: "America/Chicago",
    });
    expect(calls).toEqual([
      {
        fn: "recipient_setting",
        args: { p_person_id: "p1", p_org_id: "org-1", p_setting_key: "locale.language" },
      },
      {
        fn: "recipient_setting",
        args: { p_person_id: "p1", p_org_id: "org-1", p_setting_key: "locale.time_zone" },
      },
    ]);
    // Outside an org only the values kept for every org apply.
    await recipientProfile(db, "p1");
    expect(calls.at(-1)?.args).toEqual({
      p_person_id: "p1",
      p_org_id: null,
      p_setting_key: "locale.time_zone",
    });
    await expect(recipientProfile(db, "p9", "org-1")).resolves.toEqual({
      name: "",
      locale: "en-US",
      timeZone: "UTC",
    });
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
        recipient_setting: () => null,
        record_notification_delivery: () => null,
        claim_push_receipts: () => [{ ticket_id: "t-1" }],
        record_push_receipts: () => 2,
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
    await expect(store.recipient("p1", "org-1")).resolves.toMatchObject({ locale: "en-US" });
    expect(calls.map((c) => c.fn)).toEqual([
      "claim_notification_deliveries",
      "record_push_tickets",
      "record_notification_delivery",
      "claim_push_receipts",
      "record_push_receipts",
      "recipient_setting",
      "recipient_setting",
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
        recipient_setting: (args) =>
          args["p_setting_key"] === "locale.time_zone" ? "America/Chicago" : null,
        record_notification_delivery: () => null,
        record_sms_keyword: () => 2,
        record_sms_status: () => true,
        email_brand_for_org: () => [],
      },
      { organizations: [{ id: "org-1", slug: "northwind-live", name: "Northwind Live" }] },
    );
    const store = smsStore(db, { appUrl: "https://atlas.xos.test/" });
    const [claimed] = await store.claimSms(5);
    if (claimed === undefined) throw new Error("claim expected");
    await expect(store.senderName("org-1", "shift.changed")).resolves.toBe("Northwind Live");
    // XOS's own notices name XOS, never the org (A138).
    await expect(store.senderName("org-1", "account.security_changed")).resolves.toBe("XOS");
    await expect(store.linkFor(claimed)).resolves.toBe(
      "https://atlas.xos.test/northwind-live/inbox",
    );
    await store.record("s1", "Bounced", null, "21610");
    expect(calls.at(-1)).toEqual({
      fn: "record_notification_delivery",
      args: {
        p_delivery_id: "s1",
        p_status: "Bounced",
        p_provider_message_id: null,
        p_error: "21610",
        p_segments: 1,
      },
    });
    await store.record("s1", "Sent", "SM-9", null, 2);
    expect(calls.at(-1)?.args).toMatchObject({ p_status: "Sent", p_segments: 2 });
    await expect(store.recipient("p1", "org-1")).resolves.toMatchObject({
      timeZone: "America/Chicago",
    });
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

  it("an SMS names the org's brand while white label is in force", async () => {
    const { db } = fakeDb(
      {
        email_brand_for_org: () => [
          {
            brand_name: "Northwind Presents",
            sender_name: null,
            reply_to: null,
            logo_path: null,
            accent_hex: null,
            suppress_powered_by: false,
          },
        ],
      },
      { organizations: [{ id: "org-1", slug: "northwind-live", name: "Northwind Live" }] },
    );
    const store = smsStore(db, { appUrl: "https://atlas.xos.test" });
    await expect(store.senderName("org-1", "shift.changed")).resolves.toBe("Northwind Presents");
    await expect(store.senderName("org-1", "billing.payment_failed")).resolves.toBe("XOS");
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
    const records: Parameters<SmsSummaryStore["recordSummary"]>[] = [];
    const store: SmsSummaryStore = {
      claimSummaries: async () => summaries,
      recipient: async (id) => ({
        name: "Dave",
        locale: id === "p2" ? "es-US" : "en-US",
        timeZone: "UTC",
      }),
      senderName: async () => "Northwind Live",
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
      "Northwind Live: 3 updates came in during your quiet hours. Most important: Your password was changed. If this was not you, reset your password now. https://atlas.xos.test/northwind-live/inbox Reply STOP to opt out.",
    );
    expect(provider.sent[1]?.body).toMatch(
      /^Northwind Live: 2 novedades llegaron durante tus horas de silencio\./,
    );
    // A single held text reads like any other notification.
    expect(provider.sent[2]?.body).toBe(
      "Northwind Live: Bob asked you to approve Catering. https://atlas.xos.test/northwind-live/inbox Reply STOP to opt out.",
    );
    // A summary counts its billed segments: the Spanish one is UCS-2 and runs to several.
    expect(records.map((r) => [r[0], r[1], r[2], r[4]])).toEqual([
      [["d1", "d2", "d3"], "Sent", "recorded-sms-1", 2],
      [["d4", "d5"], "Sent", "recorded-sms-2", smsSegments(provider.sent[1]?.body ?? "")],
      [["d6"], "Sent", "recorded-sms-3", 1],
    ]);
    expect(records[1]?.[4]).toBeGreaterThanOrEqual(3);
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

  it("sends the count alone when the most important held text cannot render", async () => {
    const provider = new RecordingSmsProvider();
    const broken = { kind: "message.received", messageArgs: { conversation_id: "c1" } };
    const { store, records } = summaryStore([
      held(broken),
      held({ ...broken, recipientPersonId: "p2", deliveryIds: ["d4", "d5"], heldCount: 2 }),
      held({ ...broken, deliveryIds: ["d6"], heldCount: 1 }),
    ]);
    await expect(dispatchSmsSummaries(store, provider)).resolves.toEqual({
      attempted: 3,
      sent: 2,
      failed: 1,
      bounced: 0,
    });
    expect(provider.sent.map((m) => m.body)).toEqual([
      "Northwind Live: 3 updates came in during your quiet hours. Open your Inbox to read them: https://atlas.xos.test/northwind-live/inbox Reply STOP to opt out.",
      "Northwind Live: 2 novedades llegaron durante tus horas de silencio. Ábrelas en tu Bandeja de entrada: https://atlas.xos.test/northwind-live/inbox Responde STOP para cancelar.",
    ]);
    // A single held text has nothing else to fall back to: it fails and retries as before.
    expect(records.map((r) => [r[0], r[1]])).toEqual([
      [["d1", "d2", "d3"], "Sent"],
      [["d4", "d5"], "Sent"],
      [["d6"], "Failed"],
    ]);
  });

  it("renders every workforce kind from the arguments its emitter stores, with the actor private.notify adds (1393)", () => {
    const startsAt = "2026-10-23T18:00:00Z";
    const emitted: Record<string, Readonly<Record<string, unknown>>> = {
      "message.received": { conversation_id: "c1", kind: "Text" },
      "announcement.posted": { title: "Gate C opens at noon", requires_acknowledgment: false },
      "survey.opened": { title: "Load-in pulse", anonymous: true },
      "recognition.received": { title: "Thanks for the save at load-out" },
      "event.invited": { title: "Crew briefing", startsAt, event_kind: "Meeting" },
      "training.assigned": { title: "Working at height", due_on: "2026-11-01" },
    };
    for (const [kind, args] of Object.entries(emitted)) {
      expect(() => notificationText(kind, args, "en-US", "America/New_York"), kind).toThrow();
      for (const locale of locales) {
        const text = notificationText(
          kind,
          { ...args, actorName: "Dave Lindqvist" },
          locale,
          "America/New_York",
        );
        expect(text.body, `${kind} ${locale}`).toContain("Dave Lindqvist");
      }
    }
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
    await store.recordSummary(["d1", "d2"], "Sent", "SM-1", null, 3);
    expect(calls.at(-1)).toEqual({
      fn: "record_sms_summary",
      args: {
        p_delivery_ids: ["d1", "d2"],
        p_status: "Sent",
        p_provider_message_id: "SM-1",
        p_error: null,
        p_segments: 3,
      },
    });
    await store.recordSummary(["d1"], "Failed", null, "timeout");
    expect(calls.at(-1)?.args).toMatchObject({ p_status: "Failed", p_segments: 1 });
    expect(calls[0]?.args).toEqual({ p_limit: 25 });
  });

  it("keeps the bypass list short and in the registry", () => {
    // ADR 0033 decision 62 (1620) adds a new shift within 12 hours, security changes (with a recovery code used)
    // and emergency access; B8 (2979, ADR 0147) the official weather warning, the weather hold and its all-clear.
    expect(
      NOTIFICATION_KINDS.filter((k) => k.quietHoursBypass !== null).map((k) => k.kind),
    ).toEqual([
      "shift.assigned",
      "shift.changed",
      "shift.reconfirm",
      "incident.reported",
      "occupancy.threshold",
      "weather.alert",
      "weather.warning",
      "weather.hold",
      "weather.all_clear",
      "crisis_alert.issued",
      "crisis_alert.ended",
      "account.security_changed",
      "account.recovery_code_used",
      "access.break_glass_started",
    ]);
  });
});
