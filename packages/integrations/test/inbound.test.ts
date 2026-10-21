import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ChatRequestDeps,
  CommunicationSource,
} from "../src/connectors/communication/index.ts";
import { integrationsTranslator } from "../src/framework/messages.ts";
import { sha256Hex } from "../src/framework/support.ts";
import {
  handleInboundRequest,
  inboundRoute,
  INBOUND_MAX_BYTES,
  supabaseInboundStore,
  teamsCommandText,
  type InboundConnection,
  type InboundDeps,
  type InboundKind,
  type InboundStore,
} from "../src/inbound/handler.ts";
import { mintChatSession, CHAT_SESSION_SECONDS } from "../src/inbound/session.ts";
import {
  safeEqual,
  verifyQuickBooksSignature,
  verifySharedToken,
  verifyXeroSignature,
} from "../src/inbound/verify.ts";
import { dbError, okData, recordingDb } from "./doubles.ts";

const t = integrationsTranslator("en-US");
// Secrets built at run time; none is a real credential.
const SLACK_SECRET = ["fixture", "slack", "signing", "secret"].join("-");
const XERO_KEY = ["fixture", "xero", "webhook", "key"].join("-");
const QBO_TOKEN = ["fixture", "qbo", "verifier"].join("-");
const TEAMS_SECRET = Buffer.from(["fixture", "teams", "outgoing", "secret"].join("-")).toString(
  "base64",
);
const CHANNEL_TOKEN = ["fixture", "channel", "token", "value"].join("-");
const TEAMS_ID = "0193f2c4-0000-7000-8000-00000000000a";
const GCAL_ID = "0193f2c4-0000-7000-8000-00000000000b";
const GRAPH_ID = "0193f2c4-0000-7000-8000-00000000000c";
const NOW = new Date("2027-06-30T12:00:00Z");

interface Recorded {
  connectionId: string;
  kind: InboundKind;
  key: string;
  payload: Readonly<Record<string, unknown>>;
}

function memoryInbound(failRecord = false) {
  const recorded: Recorded[] = [];
  const connections: Record<string, InboundConnection> = {
    [TEAMS_ID]: {
      id: TEAMS_ID,
      providerCode: "microsoft_teams",
      externalAccountId: "tenant-nwl",
      state: "Connected",
    },
    [GCAL_ID]: {
      id: GCAL_ID,
      providerCode: "google_calendar",
      externalAccountId: null,
      state: "Connected",
    },
    [GRAPH_ID]: {
      id: GRAPH_ID,
      providerCode: "microsoft_365",
      externalAccountId: null,
      state: "Connected",
    },
  };
  const store: InboundStore = {
    findConnection: async (provider, account) => {
      const known: Record<string, string> = {
        "slack:T0NORTH": "conn-slack",
        "xero:tenant-1": "conn-xero",
        "quickbooks_online:realm-1": "conn-qbo",
      };
      return known[`${provider}:${account}`] ?? null;
    },
    connection: async (id) => connections[id] ?? null,
    inboundSecret: async (id) =>
      id === TEAMS_ID ? TEAMS_SECRET : id === GCAL_ID || id === GRAPH_ID ? CHANNEL_TOKEN : null,
    async record(connectionId, kind, key, payload) {
      if (failRecord) throw new Error("database unreachable");
      const duplicate = recorded.some((r) => r.connectionId === connectionId && r.key === key);
      if (!duplicate) recorded.push({ connectionId, kind, key, payload });
      return { eventId: `ev-${recorded.length}`, duplicate };
    },
  };
  return { store, recorded };
}

function chat(): ChatRequestDeps {
  const source: CommunicationSource = {
    routedEvents: async () => [],
    findConnection: async (_p, account) =>
      account === "T0NORTH" || account === "tenant-nwl" ? "conn" : null,
    resolveMember: async () => ({ personId: "p", userId: "u-dave", orgId: "o" }),
  };
  return {
    source,
    translate: t,
    clientFor: async () =>
      recordingDb({
        "from:projects": [okData({ id: "prj-1" })],
        "from:records": [okData({ title: "Load In", record_kind: "Task", record_state: "Active" })],
      }).db,
  };
}

function deps(store: InboundStore, secrets: InboundDeps["secrets"] = {}): InboundDeps {
  return {
    store,
    secrets: {
      slackSigningSecret: SLACK_SECRET,
      xeroWebhookKey: XERO_KEY,
      quickbooksVerifierToken: QBO_TOKEN,
      ...secrets,
    },
    chat: chat(),
    now: () => NOW,
  };
}

const base = "https://project.functions.supabase.test/functions/v1/integration-inbound";

function slackRequest(path: string, body: string, signature?: string): Request {
  const ts = String(NOW.getTime() / 1000);
  const sig =
    signature ??
    `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request(`${base}/slack/${path}`, {
    method: "POST",
    body,
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
  });
}

describe("webhook signatures", () => {
  it("verifies Xero and QuickBooks HMAC signatures on the raw body", () => {
    const body = '{"events":[]}';
    const xero = createHmac("sha256", XERO_KEY).update(body).digest("base64");
    expect(verifyXeroSignature(XERO_KEY, xero, body)).toBe(true);
    expect(verifyXeroSignature(XERO_KEY, xero, `${body} `)).toBe(false);
    expect(verifyXeroSignature("", xero, body)).toBe(false);
    expect(verifyXeroSignature(XERO_KEY, "", body)).toBe(false);
    const qbo = createHmac("sha256", QBO_TOKEN).update(body).digest("base64");
    expect(verifyQuickBooksSignature(QBO_TOKEN, qbo, body)).toBe(true);
    expect(verifyQuickBooksSignature(QBO_TOKEN, xero, body)).toBe(false);
    expect(verifyQuickBooksSignature("", qbo, body)).toBe(false);
  });

  it("compares shared tokens in constant time and refuses short or missing ones", () => {
    expect(verifySharedToken(CHANNEL_TOKEN, CHANNEL_TOKEN)).toBe(true);
    expect(verifySharedToken(CHANNEL_TOKEN, `${CHANNEL_TOKEN}x`)).toBe(false);
    expect(verifySharedToken("short", "short")).toBe(false);
    expect(verifySharedToken(null, CHANNEL_TOKEN)).toBe(false);
    expect(verifySharedToken(CHANNEL_TOKEN, null)).toBe(false);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});

describe("inbound routing", () => {
  it("reads the route after the function name and refuses everything else", async () => {
    expect(inboundRoute(`${base}/slack/events`)).toEqual(["slack", "events"]);
    expect(inboundRoute("https://x.test/other/slack")).toEqual([]);
    const d = deps(memoryInbound().store);
    expect(
      (await handleInboundRequest(new Request("https://x.test/other", { method: "POST" }), d))
        .status,
    ).toBe(404);
    expect(
      (await handleInboundRequest(new Request(`${base}/slack/events/extra`, { method: "POST" }), d))
        .status,
    ).toBe(404);
    expect((await handleInboundRequest(new Request(`${base}/slack/events`), d)).status).toBe(405);
    expect(
      (await handleInboundRequest(new Request(`${base}/stripe`, { method: "POST", body: "{}" }), d))
        .status,
    ).toBe(404);
    expect(
      (
        await handleInboundRequest(
          new Request(`${base}/slack/other`, { method: "POST", body: "{}" }),
          d,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleInboundRequest(
          new Request(`${base}/xero/extra`, { method: "POST", body: "{}" }),
          d,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleInboundRequest(
          new Request(`${base}/quickbooks_online/x`, { method: "POST", body: "{}" }),
          d,
        )
      ).status,
    ).toBe(404);
  });

  it("refuses bodies above the limit before reading them", async () => {
    const big = "x".repeat(INBOUND_MAX_BYTES + 1);
    const d = deps(memoryInbound().store);
    const declared = new Request(`${base}/xero`, {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(INBOUND_MAX_BYTES + 1) },
    });
    expect((await handleInboundRequest(declared, d)).status).toBe(413);
    expect(
      (await handleInboundRequest(new Request(`${base}/xero`, { method: "POST", body: big }), d))
        .status,
    ).toBe(413);
  });
});

describe("Slack", () => {
  it("answers the URL check and refuses bad or unconfigured signatures", async () => {
    const m = memoryInbound();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const ok = await handleInboundRequest(slackRequest("events", body), deps(m.store));
    expect(await ok.json()).toEqual({ challenge: "abc123" });
    expect(
      (await handleInboundRequest(slackRequest("events", body, "v0=bad"), deps(m.store))).status,
    ).toBe(401);
    expect(
      (
        await handleInboundRequest(
          slackRequest("events", body),
          deps(m.store, { slackSigningSecret: undefined }),
        )
      ).status,
    ).toBe(503);
    expect(
      (await handleInboundRequest(slackRequest("events", "not json"), deps(m.store))).status,
    ).toBe(400);
  });

  it("records a link_shared event once and acknowledges at once", async () => {
    const m = memoryInbound();
    const envelope = {
      type: "event_callback",
      team_id: "T0NORTH",
      event_id: "Ev0PRODUCTION",
      event: {
        type: "link_shared",
        user: "U0DAVE",
        channel: "C0PROD",
        message_ts: "1700000000.0001",
        links: [
          { url: "https://atlas.example.com/o/work?peek=NWL-12" },
          { url: 7 },
          ...Array(30).fill({ url: "https://a.test" }),
        ],
      },
    };
    const body = JSON.stringify(envelope);
    expect((await handleInboundRequest(slackRequest("events", body), deps(m.store))).status).toBe(
      200,
    );
    expect((await handleInboundRequest(slackRequest("events", body), deps(m.store))).status).toBe(
      200,
    );
    expect(m.recorded).toHaveLength(1);
    expect(m.recorded[0]).toMatchObject({
      connectionId: "conn-slack",
      kind: "Link Unfurl",
      key: "Ev0PRODUCTION",
    });
    expect((m.recorded[0]?.payload["links"] as string[]).length).toBe(20);
  });

  it("drops events it does not handle and workspaces it does not know", async () => {
    const m = memoryInbound();
    const other = JSON.stringify({
      type: "event_callback",
      team_id: "T0NORTH",
      event_id: "E1",
      event: { type: "app_mention" },
    });
    const unknown = JSON.stringify({
      type: "event_callback",
      team_id: "T0OTHER",
      event_id: "E2",
      event: { type: "link_shared", links: [] },
    });
    expect((await handleInboundRequest(slackRequest("events", other), deps(m.store))).status).toBe(
      200,
    );
    expect(
      (await handleInboundRequest(slackRequest("events", unknown), deps(m.store))).status,
    ).toBe(200);
    expect(m.recorded).toHaveLength(0);
  });

  it("answers a slash command as the linked person", async () => {
    const m = memoryInbound();
    const body = "team_id=T0NORTH&user_id=U0DAVE&command=%2Fxos&text=record+NWL-12";
    const response = await handleInboundRequest(slackRequest("commands", body), deps(m.store));
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: "NWL-12 Load In: Task, Active.",
    });
    expect(
      (await handleInboundRequest(slackRequest("commands", "text=help"), deps(m.store))).status,
    ).toBe(400);
    expect(
      (await handleInboundRequest(slackRequest("commands", body, "v0=bad"), deps(m.store))).status,
    ).toBe(401);
    expect(
      (
        await handleInboundRequest(
          slackRequest("commands", body),
          deps(m.store, { slackSigningSecret: "" }),
        )
      ).status,
    ).toBe(503);
  });

  it("answers 503 when the event cannot be recorded, so Slack delivers it again", async () => {
    const m = memoryInbound(true);
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T0NORTH",
      event_id: "E3",
      event: { type: "link_shared", links: [{ url: "https://a.test" }] },
    });
    expect((await handleInboundRequest(slackRequest("events", body), deps(m.store))).status).toBe(
      503,
    );
  });
});

describe("Microsoft Teams", () => {
  const teams = (body: string, auth?: string, id = TEAMS_ID) =>
    new Request(`${base}/microsoft_teams/${id}`, {
      method: "POST",
      body,
      headers: {
        authorization:
          auth ??
          `HMAC ${createHmac("sha256", Buffer.from(TEAMS_SECRET, "base64")).update(body).digest("base64")}`,
      },
    });

  it("strips the mention and answers as the linked person", async () => {
    expect(teamsCommandText("<at>XOS</at>&nbsp;record <b>NWL-12</b>")).toBe("record NWL-12");
    const body = JSON.stringify({
      text: "<at>XOS</at> record NWL-12",
      from: { aadObjectId: "aad-dave" },
    });
    const response = await handleInboundRequest(teams(body), deps(memoryInbound().store));
    expect(await response.json()).toEqual({
      type: "message",
      text: "NWL-12 Load In: Task, Active.",
    });
  });

  it("refuses an unknown connection, a bad signature and a malformed message", async () => {
    const m = memoryInbound();
    const body = JSON.stringify({ text: "help", from: { id: "29:x" } });
    expect(
      (await handleInboundRequest(teams(body, undefined, "not-a-uuid"), deps(m.store))).status,
    ).toBe(404);
    expect(
      (await handleInboundRequest(teams(body, undefined, GCAL_ID), deps(m.store))).status,
    ).toBe(404);
    expect((await handleInboundRequest(teams(body, "HMAC bad"), deps(m.store))).status).toBe(401);
    expect((await handleInboundRequest(teams("{}"), deps(m.store))).status).toBe(400);
    expect((await handleInboundRequest(teams(body), deps(m.store))).status).toBe(200);
    const noSecret = { ...m.store, inboundSecret: async () => null };
    expect((await handleInboundRequest(teams(body), deps(noSecret))).status).toBe(503);
  });
});

describe("accounting change notices", () => {
  it("records a Xero notice per tenant, once, after the signature checks out", async () => {
    const m = memoryInbound();
    const body = JSON.stringify({
      events: [
        {
          tenantId: "tenant-1",
          eventCategory: "INVOICE",
          eventType: "UPDATE",
          resourceId: "inv-1",
        },
        {
          tenantId: "tenant-unknown",
          eventCategory: "INVOICE",
          eventType: "CREATE",
          resourceId: "inv-2",
        },
        null,
      ],
    });
    const signature = createHmac("sha256", XERO_KEY).update(body).digest("base64");
    const request = () =>
      new Request(`${base}/xero`, {
        method: "POST",
        body,
        headers: { "x-xero-signature": signature },
      });
    expect((await handleInboundRequest(request(), deps(m.store))).status).toBe(200);
    expect((await handleInboundRequest(request(), deps(m.store))).status).toBe(200);
    expect(m.recorded).toEqual([
      {
        connectionId: "conn-xero",
        kind: "Change Notice",
        key: `xero:${sha256Hex(body)}`,
        payload: {
          scope: "Payment Sync",
          changes: [{ category: "INVOICE", type: "UPDATE", resource_id: "inv-1" }],
        },
      },
    ]);
  });

  it("answers Xero's intent-to-receive check with 401 for a bad signature", async () => {
    const m = memoryInbound();
    const bad = () =>
      new Request(`${base}/xero`, {
        method: "POST",
        body: "{}",
        headers: { "x-xero-signature": "bad" },
      });
    expect((await handleInboundRequest(bad(), deps(m.store))).status).toBe(401);
    expect((await handleInboundRequest(bad(), deps(m.store, { xeroWebhookKey: "" }))).status).toBe(
      503,
    );
    const notJson = "nope";
    const signed = new Request(`${base}/xero`, {
      method: "POST",
      body: notJson,
      headers: {
        "x-xero-signature": createHmac("sha256", XERO_KEY).update(notJson).digest("base64"),
      },
    });
    expect((await handleInboundRequest(signed, deps(m.store))).status).toBe(400);
  });

  it("records a QuickBooks notice per known realm", async () => {
    const m = memoryInbound();
    const body = JSON.stringify({
      eventNotifications: [
        {
          realmId: "realm-1",
          dataChangeEvent: { entities: [{ name: "Payment", id: "42", operation: "Create" }] },
        },
        { realmId: "realm-unknown", dataChangeEvent: { entities: [] } },
        {},
      ],
    });
    const signature = createHmac("sha256", QBO_TOKEN).update(body).digest("base64");
    const request = new Request(`${base}/quickbooks_online`, {
      method: "POST",
      body,
      headers: { "intuit-signature": signature },
    });
    expect((await handleInboundRequest(request, deps(m.store))).status).toBe(200);
    expect(m.recorded).toHaveLength(1);
    expect(m.recorded[0]?.payload).toEqual({
      scope: "Payment Sync",
      changes: [{ category: "Payment", type: "Create", resource_id: "42" }],
    });
    const bad = () =>
      new Request(`${base}/quickbooks_online`, {
        method: "POST",
        body,
        headers: { "intuit-signature": "x" },
      });
    expect((await handleInboundRequest(bad(), deps(m.store))).status).toBe(401);
    expect(
      (await handleInboundRequest(bad(), deps(m.store, { quickbooksVerifierToken: "" }))).status,
    ).toBe(503);
    const junk = new Request(`${base}/quickbooks_online`, {
      method: "POST",
      body: "[]",
      headers: {
        "intuit-signature": createHmac("sha256", QBO_TOKEN).update("[]").digest("base64"),
      },
    });
    expect((await handleInboundRequest(junk, deps(m.store))).status).toBe(400);
  });
});

describe("calendar change notices", () => {
  const google = (headers: Record<string, string>, id = GCAL_ID) =>
    new Request(`${base}/google_calendar/${id}`, { method: "POST", headers });

  it("records a Google Calendar push once per channel message, after the channel token checks out", async () => {
    const m = memoryInbound();
    const headers = {
      "x-goog-channel-token": CHANNEL_TOKEN,
      "x-goog-channel-id": "ch-1",
      "x-goog-message-number": "7",
      "x-goog-resource-state": "exists",
      "x-goog-resource-id": "res-1",
    };
    expect((await handleInboundRequest(google(headers), deps(m.store))).status).toBe(200);
    expect((await handleInboundRequest(google(headers), deps(m.store))).status).toBe(200);
    expect(m.recorded).toEqual([
      {
        connectionId: GCAL_ID,
        kind: "Change Notice",
        key: "gcal:ch-1:7",
        payload: {
          scope: "Calendar Sync",
          changes: [{ category: "calendar", type: "exists", resource_id: "res-1" }],
        },
      },
    ]);
    expect(
      (
        await handleInboundRequest(
          google({ ...headers, "x-goog-resource-state": "sync" }),
          deps(m.store),
        )
      ).status,
    ).toBe(200);
    expect(m.recorded).toHaveLength(1);
    expect(
      (
        await handleInboundRequest(
          google({ ...headers, "x-goog-channel-token": "wrong-token-value-x" }),
          deps(m.store),
        )
      ).status,
    ).toBe(401);
    expect((await handleInboundRequest(google(headers, TEAMS_ID), deps(m.store))).status).toBe(404);
  });

  it("echoes a Graph validation token and records signed change notifications", async () => {
    const m = memoryInbound();
    const validation = await handleInboundRequest(
      new Request(`${base}/microsoft_365/${GRAPH_ID}?validationToken=Validation%3A+abc`, {
        method: "POST",
      }),
      deps(m.store),
    );
    expect(validation.status).toBe(200);
    expect(await validation.text()).toBe("Validation: abc");
    expect(
      (
        await handleInboundRequest(
          new Request(`${base}/microsoft_365/${GRAPH_ID}?validationToken=`, { method: "POST" }),
          deps(m.store),
        )
      ).status,
    ).toBe(400);
    const body = JSON.stringify({
      value: [{ clientState: CHANNEL_TOKEN, changeType: "updated", resourceData: { id: "evt-1" } }],
    });
    const post = (b: string) =>
      new Request(`${base}/microsoft_365/${GRAPH_ID}`, { method: "POST", body: b });
    expect((await handleInboundRequest(post(body), deps(m.store))).status).toBe(202);
    expect(m.recorded[0]).toMatchObject({
      connectionId: GRAPH_ID,
      key: `graph:${sha256Hex(body)}`,
    });
    const forged = JSON.stringify({
      value: [{ clientState: "forged-client-state", changeType: "deleted" }],
    });
    expect((await handleInboundRequest(post(forged), deps(m.store))).status).toBe(401);
    expect((await handleInboundRequest(post('{"value":[]}'), deps(m.store))).status).toBe(400);
    expect((await handleInboundRequest(post("x"), deps(m.store))).status).toBe(400);
    expect(
      (
        await handleInboundRequest(
          new Request(`${base}/microsoft_365/${GCAL_ID}`, { method: "POST", body }),
          deps(m.store),
        )
      ).status,
    ).toBe(404);
  });
});

describe("inbound store", () => {
  it("calls the service-role RPCs of migration 1400", async () => {
    const r = recordingDb({
      "rpc:find_integration_connection": [okData("conn-1")],
      "from:integration_connections": [
        okData({
          id: "c",
          provider_code: "slack",
          external_account_id: "T",
          connection_state: "Connected",
        }),
        okData(null),
      ],
      "rpc:read_integration_inbound_secret": [okData("s")],
      "rpc:record_integration_inbound_event": [
        okData([{ event_id: "e", duplicate: false }]),
        okData([]),
        dbError("XR001", "integration_disconnected: x", "integration_disconnected"),
      ],
    });
    const store = supabaseInboundStore(r.db);
    expect(await store.findConnection("xero", "tenant")).toBe("conn-1");
    expect(await store.connection("c")).toEqual({
      id: "c",
      providerCode: "slack",
      externalAccountId: "T",
      state: "Connected",
    });
    expect(await store.connection("missing")).toBeNull();
    expect(await store.inboundSecret("c")).toBe("s");
    expect(await store.record("c", "Change Notice", "k", { scope: "Payment Sync" })).toEqual({
      eventId: "e",
      duplicate: false,
    });
    await expect(store.record("c", "Change Notice", "k", {})).rejects.toThrow("returned nothing");
    await expect(store.record("c", "Change Notice", "k", {})).rejects.toThrow();
    expect(r.calls[4]?.steps[0]).toEqual([
      "args",
      [
        {
          p_connection_id: "c",
          p_kind: "Change Notice",
          p_idempotency_key: "k",
          p_payload: { scope: "Payment Sync" },
        },
      ],
    ]);
  });
});

describe("chat sessions", () => {
  it("mints a one-minute HS256 token for the linked user", async () => {
    const key = "k".repeat(40);
    const token = await mintChatSession(
      "u-dave",
      key,
      "https://project.test/auth/v1",
      1_800_000_000,
    );
    const [head, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(String(payload), "base64url").toString()) as Record<
      string,
      unknown
    >;
    expect(JSON.parse(Buffer.from(String(head), "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(claims).toMatchObject({
      sub: "u-dave",
      role: "authenticated",
      aud: "authenticated",
      exp: 1_800_000_000 + CHAT_SESSION_SECONDS,
    });
    const expected = createHmac("sha256", key).update(`${head}.${payload}`).digest("base64url");
    expect(signature).toBe(expected);
    await expect(mintChatSession("u", "short", "i")).rejects.toThrow("too short");
  });
});
