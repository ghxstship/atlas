import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatConnector,
  chatConnectors,
  findRecordAs,
  handleSlashCommand,
  notificationText,
  recordKeysIn,
  slackFailure,
  slackProvider,
  supabaseCommunicationSource,
  teamsProvider,
  unfurlLinks,
  verifySlackRequest,
  verifyTeamsRequest,
  type ChatRequestDeps,
  type CommunicationSource,
  type RoutedEvent,
} from "../src/connectors/communication/index.ts";
import { integrationsTranslator } from "../src/framework/messages.ts";
import { bodyOf, contextFor, memoryStore, okData, recordingDb, scriptedHttp } from "./doubles.ts";

const t = integrationsTranslator("en-US");
const run = { scope: "Notification Delivery" as const, direction: "Outbound" as const };

const event = (overrides: Partial<RoutedEvent> = {}): RoutedEvent => ({
  eventId: "e-1",
  channelId: "C0PROD",
  eventType: "record.created",
  projectName: "Northwind Summer Series",
  data: { record_kind: "Meeting", title: "Production Meeting" },
  ...overrides,
});

function source(events: RoutedEvent[] = [], member = true): CommunicationSource {
  return {
    routedEvents: async () => events,
    findConnection: async (_p, account) => (account === "T0NORTH" ? "conn-1" : null),
    resolveMember: async () => (member ? { personId: "p", userId: "u-dave", orgId: "o" } : null),
  };
}

describe("notification text", () => {
  it("writes finished copy for known events and a generic line otherwise", () => {
    expect(notificationText(event(), t)).toBe(
      "New Meeting in Northwind Summer Series: Production Meeting",
    );
    expect(
      notificationText(
        event({
          eventType: "record.state_changed",
          data: { from_state: "Proposed", to_state: "Scheduled" },
        }),
        t,
      ),
    ).toBe("A record in Northwind Summer Series moved from Proposed to Scheduled.");
    expect(
      notificationText(event({ eventType: "project.created", data: { name: "Fall Fair" } }), t),
    ).toBe("New project: Fall Fair");
    expect(notificationText(event({ eventType: "project.created", data: {} }), t)).toBe(
      "New project: Northwind Summer Series",
    );
    expect(notificationText(event({ eventType: "invoice.issued" }), t)).toBe(
      "An invoice was issued in Northwind Summer Series.",
    );
    expect(notificationText(event({ eventType: "incident.reported" }), t)).toContain(
      "Open Atlas for details",
    );
    expect(notificationText(event({ eventType: "po.approved" }), t)).toBe(
      "po.approved in Northwind Summer Series.",
    );
    expect(notificationText(event({ eventType: "po.approved", projectName: null }), t)).toBe(
      "po.approved.",
    );
    expect(notificationText(event({ data: {} }), t)).toBe(
      "New record in Northwind Summer Series: ",
    );
    expect(integrationsTranslator("es-US")("chat.event.projectCreated", { name: "Feria" })).toBe(
      "Nuevo proyecto: Feria",
    );
  });

  it("never sends a raw key or a missing argument", () => {
    expect(() => t("chat.nothing")).toThrow("Missing integrations message chat.nothing in en-US.");
    expect(() => t("chat.event.projectCreated")).toThrow("needs the name argument");
    expect(() => t("chat")).toThrow("Missing integrations message");
  });
});

describe("Slack delivery", () => {
  it("posts routed events and advances the cursor", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://slack.com/api/chat.postMessage",
        respond: () => ({ json: { ok: true, ts: "1" } }),
      },
    ]);
    const outcome = await chatConnector(
      slackProvider,
      source([event(), event({ eventId: "e-2", eventType: "po.approved" })]),
      t,
    ).sync(contextFor("slack", { http, store: memoryStore().store, run, cursor: "e-0" }));
    expect(bodyOf(requests[0])).toEqual({
      channel: "C0PROD",
      text: "New Meeting in Northwind Summer Series: Production Meeting",
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(outcome).toEqual({
      counts: { read: 2, written: 2, skipped: 0, failed: 0 },
      cursorAfter: "e-2",
    });
  });

  it("records a missing channel and stops on refused tokens and rate limits", async () => {
    const missing = scriptedHttp([
      {
        match: "POST https://slack.com",
        respond: (r) => ({
          json:
            (bodyOf(r) as { channel: string }).channel === "C0GONE"
              ? { ok: false, error: "channel_not_found" }
              : { ok: true },
        }),
      },
    ]);
    const memory = memoryStore();
    const outcome = await chatConnector(
      slackProvider,
      source([event({ channelId: "C0GONE" }), event({ eventId: "e-2" })]),
      t,
    ).sync(contextFor("slack", { http: missing.http, store: memory.store, run }));
    expect(memory.itemErrors[0]).toMatchObject({
      code: "slack_channel_not_found",
      ref: { externalId: "C0GONE" },
    });
    expect(outcome.cursorAfter).toBe("e-2");
    expect(outcome.counts.failed).toBe(1);
    for (const [error, expected] of [
      ["token_revoked", { connectionError: true }],
      ["ratelimited", { retryable: true }],
    ] as const) {
      const http = scriptedHttp([
        { match: "POST https://slack.com", respond: () => ({ json: { ok: false, error } }) },
      ]);
      await expect(
        chatConnector(slackProvider, source([event()]), t).sync(
          contextFor("slack", { http: http.http, store: memory.store, run }),
        ),
      ).rejects.toMatchObject(expected);
    }
    const noCode = scriptedHttp([
      { match: "POST https://slack.com", respond: () => ({ json: { ok: false } }) },
    ]);
    const unknown = memoryStore();
    await chatConnector(slackProvider, source([event()]), t).sync(
      contextFor("slack", { http: noCode.http, store: unknown.store, run }),
    );
    expect(unknown.itemErrors[0]).toMatchObject({
      code: "provider_rejected",
      message: "Slack returned unknown_error.",
    });
    await expect(
      chatConnector(slackProvider, source([event()]), t).sync(
        contextFor("slack", { http: noCode.http, store: memory.store, run, credential: null }),
      ),
    ).rejects.toMatchObject({ code: "credential_required" });
    const thrown = { ...slackProvider, post: () => Promise.reject(new Error("socket hang up")) };
    await expect(
      chatConnector(thrown, source([event()]), t).sync(
        contextFor("slack", { http: noCode.http, store: memory.store, run }),
      ),
    ).rejects.toThrow("socket hang up");
    expect(slackFailure("missing_scope").connectionError).toBe(true);
  });
});

describe("Teams delivery", () => {
  it("posts escaped HTML to the team channel", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://graph.microsoft.com/v1.0/teams/team-1/channels/19%3Achan/messages",
        respond: () => ({ status: 201, json: { id: "m" } }),
      },
    ]);
    await chatConnector(
      teamsProvider,
      source([
        event({
          channelId: "team-1/19:chan",
          data: { record_kind: "Meeting", title: "Load-in <Dock & Pier>" },
        }),
      ]),
      t,
    ).sync(contextFor("microsoft_teams", { http, store: memoryStore().store, run }));
    expect(bodyOf(requests[0])).toEqual({
      body: {
        contentType: "html",
        content: "New Meeting in Northwind Summer Series: Load-in &lt;Dock &amp; Pier&gt;",
      },
    });
    const memory = memoryStore();
    await chatConnector(teamsProvider, source([event({ channelId: "no-slash" })]), t).sync(
      contextFor("microsoft_teams", { http, store: memory.store, run }),
    );
    expect(memory.itemErrors[0]?.code).toBe("teams_channel_malformed");
    expect(chatConnectors(source(), t).map((c) => c.provider)).toEqual([
      "slack",
      "microsoft_teams",
    ]);
  });
});

describe("request signatures", () => {
  const now = new Date("2027-06-30T12:00:00Z");
  const ts = String(now.getTime() / 1000);
  it("verifies Slack signatures within five minutes", () => {
    const body = "command=%2Fxos&text=help";
    const signature = `v0=${createHmac("sha256", "fixture-signing-secret").update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(verifySlackRequest("fixture-signing-secret", ts, signature, body, now)).toBe(true);
    expect(verifySlackRequest("fixture-signing-secret", ts, signature, `${body}x`, now)).toBe(
      false,
    );
    expect(
      verifySlackRequest("fixture-signing-secret", String(Number(ts) - 301), signature, body, now),
    ).toBe(false);
    expect(verifySlackRequest("fixture-signing-secret", "soon", signature, body, now)).toBe(false);
    expect(verifySlackRequest("other", ts, signature, body, now)).toBe(false);
  });

  it("verifies Teams outgoing webhook signatures", () => {
    const secret = Buffer.from("fixture-teams-secret").toString("base64");
    const body = '{"text":"<at>XOS</at> record NWL-12"}';
    const mac = createHmac("sha256", Buffer.from(secret, "base64")).update(body).digest("base64");
    expect(verifyTeamsRequest(secret, `HMAC ${mac}`, body)).toBe(true);
    expect(verifyTeamsRequest(secret, `HMAC ${mac}`, `${body} `)).toBe(false);
    expect(verifyTeamsRequest(secret, `Bearer ${mac}`, body)).toBe(false);
  });
});

describe("slash commands and unfurls", () => {
  function deps(
    member = true,
    record: Record<string, unknown> | null = {
      title: "Production Meeting",
      record_kind: "Meeting",
      record_state: "Scheduled",
    },
  ) {
    const users: string[] = [];
    const value: ChatRequestDeps = {
      source: source([], member),
      translate: t,
      clientFor: async (userId) => {
        users.push(userId);
        return recordingDb({
          "from:projects": [okData({ id: "prj-1" }), okData({ id: "prj-1" }), okData(null)],
          "from:records": [okData(record), okData(record)],
        }).db;
      },
    };
    return { value, users };
  }
  const command = (text: string) => ({
    provider: "slack" as const,
    externalAccountId: "T0NORTH",
    externalUserId: "U0DAVE",
    text,
  });

  it("answers as the linked person", async () => {
    const d = deps();
    expect(await handleSlashCommand(command("record nwl-12"), d.value)).toBe(
      "NWL-12 Production Meeting: Meeting, Scheduled.",
    );
    expect(d.users).toEqual(["u-dave"]);
    expect(await handleSlashCommand(command(""), d.value)).toContain("Commands:");
    expect(await handleSlashCommand(command("dance"), d.value)).toContain("not one XOS knows");
    expect(await handleSlashCommand(command("record"), d.value)).toContain("Add a record key");
  });

  it("explains unlinked users and records they cannot see", async () => {
    expect(await handleSlashCommand(command("record NWL-12"), deps(false).value)).toContain(
      "not linked to XOS yet",
    );
    expect(
      await handleSlashCommand(
        { ...command("record NWL-12"), externalAccountId: "T0OTHER" },
        deps().value,
      ),
    ).toContain("not linked");
    expect(await handleSlashCommand(command("record NWL-12"), deps(true, null).value)).toBe(
      "No record NWL-12 exists, or you cannot see it. Check the key and try again.",
    );
    expect(await handleSlashCommand(command("record not-a-key!"), deps().value)).toContain(
      "No record NOT-A-KEY!",
    );
  });

  it("finds records only through the person's client", async () => {
    const missingProject = recordingDb({ "from:projects": [okData(null)] });
    expect(await findRecordAs(missingProject.db, "ZZZ-1")).toBeNull();
    const found = recordingDb({
      "from:projects": [okData({ id: "p" })],
      "from:records": [okData({ title: "T", record_kind: "Task", record_state: "Active" })],
    });
    expect(await findRecordAs(found.db, "nwl-7")).toEqual({
      key: "NWL-7",
      title: "T",
      kind: "Task",
      state: "Active",
    });
    expect(found.calls[1]?.steps).toContainEqual(["eq", ["record_number", 7]]);
  });

  it("unfurls Atlas record links the person can see", async () => {
    const origin = "https://atlas.example.com";
    expect(
      recordKeysIn(
        [
          "not a url",
          "https://evil.example.com/x?peek=NWL-1",
          `${origin}/org/work?peek=NWL-12`,
          `${origin}/org/home?peek=NWL-12`,
          `${origin}/org`,
        ],
        origin,
      ),
    ).toEqual(["NWL-12"]);
    const urls = [
      `${origin}/o/work?peek=NWL-12`,
      "https://elsewhere.example.com",
      `${origin}/o/work?peek=NWL-13`,
    ];
    const result = await unfurlLinks(
      { provider: "slack", externalAccountId: "T0NORTH", externalUserId: "U0DAVE", urls },
      origin,
      deps().value,
    );
    expect(result).toEqual({
      [urls[0] as string]: "NWL-12 Production Meeting: Meeting, Scheduled.",
      [urls[2] as string]: "NWL-13 Production Meeting: Meeting, Scheduled.",
    });
    expect(
      await unfurlLinks(
        {
          provider: "slack",
          externalAccountId: "T0NORTH",
          externalUserId: "U0DAVE",
          urls: ["https://elsewhere.example.com"],
        },
        origin,
        deps().value,
      ),
    ).toEqual({});
    expect(
      await unfurlLinks(
        { provider: "slack", externalAccountId: "T0OTHER", externalUserId: "U0DAVE", urls },
        origin,
        deps().value,
      ),
    ).toEqual({});
    const hidden = deps(true, null);
    expect(
      await unfurlLinks(
        {
          provider: "slack",
          externalAccountId: "T0NORTH",
          externalUserId: "U0DAVE",
          urls: [urls[0] as string],
        },
        origin,
        hidden.value,
      ),
    ).toEqual({});
  });
});

describe("communication source", () => {
  it("reads routed events after the cursor and resolves chat identity", async () => {
    const { db, calls } = recordingDb({
      "from:integration_route_events": [
        okData([
          {
            domain_event_id: "e",
            external_channel_id: "C",
            event_type: "record.created",
            project_name: null,
            data: null,
          },
        ]),
        okData([]),
      ],
      "rpc:find_chat_connection": [okData("conn")],
      "rpc:resolve_chat_member": [
        okData([{ person_id: "p", user_id: "u", org_id: "o" }]),
        okData([]),
      ],
    });
    const s = supabaseCommunicationSource(db);
    expect(await s.routedEvents("conn", "e-0", 10)).toEqual([
      { eventId: "e", channelId: "C", eventType: "record.created", projectName: null, data: {} },
    ]);
    expect(calls[0]?.steps).toContainEqual(["gt", ["domain_event_id", "e-0"]]);
    await s.routedEvents("conn", null, 10);
    expect(calls[1]?.steps.some(([step]) => step === "gt")).toBe(false);
    expect(await s.findConnection("slack", "T")).toBe("conn");
    expect(await s.resolveMember("conn", "U")).toEqual({ personId: "p", userId: "u", orgId: "o" });
    expect(await s.resolveMember("conn", "U")).toBeNull();
  });
});
