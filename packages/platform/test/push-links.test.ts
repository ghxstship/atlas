import { describe, expect, it } from "vitest";
import {
  RecordingPushClient,
  RecordingWebPushClient,
  compassLink,
  dispatchPush,
  pushMessage,
  pushStore,
  webPushLink,
  webPushStore,
  type ClaimedPush,
  type PlatformDb,
} from "../src/index.ts";

/**
 * Where a push opens (A101, RRR-147): the record a notification carries the key of (message_args.recordKey, 1600)
 * without reading the record again, the record read from its id otherwise, and in Gateway the page the notification
 * names, so a marketplace match opens its listing or Explore Alerts.
 */

type Row = Readonly<Record<string, unknown>>;

function fakeDb(
  tables: Record<string, readonly Row[]>,
  rpcs: Record<string, (args: Row) => unknown> = {},
) {
  const reads: string[] = [];
  const calls: { fn: string; args: Row }[] = [];
  const db: PlatformDb = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      return rpcs[fn]?.(args) ?? null;
    },
    async selectOne(table, _columns, match) {
      reads.push(table);
      return (
        (tables[table] ?? []).find((row) =>
          Object.entries(match).every(([k, v]) => row[k] === v),
        ) ?? null
      );
    },
  };
  return { db, reads, calls };
}

const TABLES = {
  organizations: [{ id: "o1", slug: "northwind" }],
  records: [{ id: "r1", project_id: "pr1", record_number: 42 }],
  projects: [{ id: "pr1", project_key: "NWS" }],
};

describe("push links read the record key a notification carries", () => {
  it("opens the carried key in Atlas and Compass without reading the record", async () => {
    const { db, reads } = fakeDb(TABLES);
    const claim = {
      orgId: "o1",
      subjectTable: "app.records",
      subjectId: "r-not-read",
      messageArgs: { title: "Hang the delay towers", recordKey: "NWS-7" },
    };
    await expect(webPushLink(db, claim, "Atlas")).resolves.toBe("/northwind/r/NWS-7");
    await expect(compassLink(db, claim)).resolves.toBe("compass://r/NWS-7?org=northwind");
    expect(reads).toEqual(["organizations", "organizations"]);
  });

  it("falls back to the record and its project when the key is missing or malformed", async () => {
    const { db } = fakeDb(TABLES);
    const claim = { orgId: "o1", subjectTable: "records", subjectId: "r1" };
    await expect(compassLink(db, claim)).resolves.toBe("compass://r/NWS-42?org=northwind");
    await expect(
      compassLink(db, { ...claim, messageArgs: { recordKey: "not a key" } }),
    ).resolves.toBe("compass://r/NWS-42?org=northwind");
    await expect(
      webPushLink(db, { ...claim, messageArgs: { recordKey: 7 } }, "Atlas"),
    ).resolves.toBe("/northwind/r/NWS-42");
  });

  it("opens the Compass Inbox when the org is unknown, whatever key is carried", async () => {
    const { db } = fakeDb(TABLES);
    await expect(
      compassLink(db, {
        orgId: "gone",
        subjectTable: "app.records",
        subjectId: "r1",
        messageArgs: { recordKey: "NWS-7" },
      }),
    ).resolves.toBe("compass://inbox");
  });
});

describe("Gateway push links open the page the notification names", () => {
  const match = {
    orgId: "o1",
    subjectTable: "opportunities",
    subjectId: "op1",
    kind: "opportunity.matched",
  };

  it("opens a single match's listing and several matches' Explore Alerts", async () => {
    const { db, reads } = fakeDb(TABLES);
    await expect(
      webPushLink(
        db,
        { ...match, messageArgs: { gatewayPath: "/explore/OPP-01J8000000E00800000002510A" } },
        "Gateway",
      ),
    ).resolves.toBe("/explore/OPP-01J8000000E00800000002510A");
    await expect(
      webPushLink(db, { ...match, messageArgs: { gatewayPath: "/explore/alerts" } }, "Gateway"),
    ).resolves.toBe("/explore/alerts");
    expect(reads).toEqual([]);
  });

  it("opens Explore Alerts for a match that names no safe page, and Home for anything else", async () => {
    const { db } = fakeDb(TABLES);
    for (const gatewayPath of [
      undefined,
      "https://elsewhere.test/explore",
      "//elsewhere.test",
      "/explore?x=1",
    ]) {
      await expect(
        webPushLink(
          db,
          { ...match, messageArgs: gatewayPath === undefined ? {} : { gatewayPath } },
          "Gateway",
        ),
      ).resolves.toBe("/explore/alerts");
    }
    await expect(
      webPushLink(
        db,
        { orgId: "o1", subjectTable: null, subjectId: null, kind: "invoice.paid" },
        "Gateway",
      ),
    ).resolves.toBe("/home");
    await expect(
      webPushLink(
        db,
        {
          orgId: "o1",
          subjectTable: null,
          subjectId: null,
          kind: "invoice.paid",
          messageArgs: { gatewayPath: "/money/invoices" },
        },
        "Gateway",
      ),
    ).resolves.toBe("/money/invoices");
  });
});

describe("a marketplace user's push through the sender", () => {
  it("pushes their own Compass device and Gateway browser with the record key and the listing", async () => {
    const claim: ClaimedPush = {
      deliveryId: "d1",
      notificationId: "01920000-0000-7000-8000-00000000a101",
      orgId: "o1",
      recipientPersonId: "nina",
      kind: "opportunity.matched",
      categoryCode: "opportunities",
      messageArgs: {
        title: "Summer Series Delay Towers",
        orgName: "Northwind Live",
        searchName: "Delay towers",
        count: 1,
        gatewayPath: "/explore/OPP-01J8000000E00800000002510A",
      },
      subjectTable: "opportunities",
      subjectId: "op1",
      devices: [{ subscriptionId: "own-compass", token: "ExponentPushToken[nina-compass-001]" }],
      browsers: ["own-browser"],
    };
    const { db, calls } = fakeDb(
      { ...TABLES, people: [] },
      {
        claim_notification_deliveries: () => [
          {
            delivery_id: claim.deliveryId,
            notification_id: claim.notificationId,
            org_id: claim.orgId,
            recipient_person_id: claim.recipientPersonId,
            kind: claim.kind,
            category_code: claim.categoryCode,
            message_args: claim.messageArgs,
            subject_table: claim.subjectTable,
            subject_id: claim.subjectId,
            push_devices: [
              { subscriptionId: "own-compass", token: "ExponentPushToken[nina-compass-001]" },
              { subscriptionId: "own-browser", token: null },
            ],
          },
        ],
        web_push_devices: () => [
          {
            subscription_id: "own-browser",
            endpoint: "https://push.example.test/send/gateway-nina",
            p256dh: "B".repeat(87),
            auth: "A".repeat(22),
            app: "Gateway",
          },
        ],
      },
    );
    const expo = new RecordingPushClient();
    const web = new RecordingWebPushClient();
    const summary = await dispatchPush(pushStore(db), expo, {
      web: { store: webPushStore(db), client: web },
    });
    expect(summary).toMatchObject({ attempted: 1, sent: 1, devices: 2 });
    expect(expo.sent.map((m) => [m.to, m.data["url"], m.data["recordKey"]])).toEqual([
      ["ExponentPushToken[nina-compass-001]", "compass://inbox", null],
    ]);
    expect(web.sent.map((s) => s.payload.url)).toEqual(["/explore/OPP-01J8000000E00800000002510A"]);
    expect(calls.map((c) => c.fn)).toContain("record_web_push_tickets");
  });

  it("carries the record key of a notification about a record in the push data", () => {
    const message = pushMessage(
      {
        deliveryId: "d2",
        notificationId: "01920000-0000-7000-8000-00000000a102",
        orgId: "o1",
        recipientPersonId: "ivy",
        kind: "assignment.created",
        categoryCode: "assignments",
        messageArgs: {
          actorName: "Carol Nguyen",
          title: "Hang the delay towers",
          recordKey: "NWS-7",
        },
        subjectTable: "app.records",
        subjectId: "r1",
        devices: [],
      },
      { subscriptionId: "own-compass", token: "ExponentPushToken[ivy-compass-0001]" },
      { name: "Ivy", locale: "en-US", timeZone: "UTC" },
      "compass://r/NWS-7?org=northwind",
    );
    expect(message.data).toMatchObject({
      recordKey: "NWS-7",
      url: "compass://r/NWS-7?org=northwind",
    });
  });
});
