import { describe, expect, it } from "vitest";
import {
  actRequest,
  APPROVAL_CATEGORY,
  DEFAULT_ACTION,
  inboxRecordKey,
  inboxTarget,
  isApprovalTap,
  needsRecordLookup,
  notificationRoute,
  readActionResponse,
  readActOutcome,
  tapRoute,
  type ActionResponseLike,
  type InboxNotificationRow,
} from "../src/domain/notifications";

/** Journey 57: an approval request approved or rejected from the push notification itself. */
const NOTE = "01920000-0000-7000-8000-00000000f057";

function response(
  actionIdentifier: string,
  data: Record<string, unknown> | null,
  categoryIdentifier: string | null = APPROVAL_CATEGORY,
  userText?: string,
): ActionResponseLike {
  return {
    actionIdentifier,
    ...(userText === undefined ? {} : { userText }),
    notification: { request: { identifier: "req-1", content: { categoryIdentifier, data } } },
  };
}

describe("actionable notifications", () => {
  it("reads Approve on an approval request", () => {
    expect(
      readActionResponse(response("approve", { notificationId: NOTE, title: "Timesheet Fran" })),
    ).toEqual({ notificationId: NOTE, action: "approve", comment: null, title: "Timesheet Fran" });
  });

  it("reads Reject with the typed reason", () => {
    expect(
      readActionResponse(
        response("reject", { notificationId: NOTE }, APPROVAL_CATEGORY, "  Missing a day "),
      ),
    ).toEqual({ notificationId: NOTE, action: "reject", comment: "Missing a day", title: null });
  });

  it("takes the category from the data when the payload carries it there", () => {
    expect(
      readActionResponse(
        response("approve", { notificationId: NOTE, categoryId: APPROVAL_CATEGORY }, null),
      )?.action,
    ).toBe("approve");
  });

  it("ignores taps, other categories, other actions and malformed ids", () => {
    expect(readActionResponse(response(DEFAULT_ACTION, { notificationId: NOTE }))).toBeNull();
    expect(readActionResponse(response("approve", { notificationId: NOTE }, "shift"))).toBeNull();
    expect(readActionResponse(response("snooze", { notificationId: NOTE }))).toBeNull();
    expect(readActionResponse(response("approve", { notificationId: "x" }))).toBeNull();
    expect(readActionResponse(response("approve", null))).toBeNull();
  });

  it("opens the Inbox for a tap on an approval request", () => {
    expect(isApprovalTap(response(DEFAULT_ACTION, { notificationId: NOTE }))).toBe(true);
    expect(isApprovalTap(response(DEFAULT_ACTION, { categoryId: APPROVAL_CATEGORY }, null))).toBe(
      true,
    );
    expect(isApprovalTap(response("approve", { notificationId: NOTE }))).toBe(false);
    expect(isApprovalTap(response(DEFAULT_ACTION, {}, "shift"))).toBe(false);
  });

  it("answers through notifications.act with the person's own token", () => {
    const call = actRequest(
      "http://localhost:3145/",
      { notificationId: NOTE, action: "reject", comment: "Missing a day", title: null },
      "jwt",
    );
    expect(call.url).toBe(`http://localhost:3145/api/v1/notifications/${NOTE}/act`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      Authorization: "Bearer jwt",
      "Idempotency-Key": `push-${NOTE}-reject`,
    });
    expect(JSON.parse(String(call.init.body))).toEqual({
      action: "reject",
      comment: "Missing a day",
    });
    const approve = actRequest(
      "http://a",
      { notificationId: NOTE, action: "approve", comment: null, title: null },
      "jwt",
    );
    expect(JSON.parse(String(approve.init.body))).toEqual({ action: "approve" });
  });

  it("reads the answer: done, refused with the rule, or failed", async () => {
    const req = { notificationId: NOTE, action: "approve" as const, comment: null, title: null };
    const json = (body: unknown) => () => Promise.resolve(body);
    expect(await readActOutcome(req, { status: 200, json: json({}) })).toEqual({
      kind: "done",
      action: "approve",
    });
    expect(
      await readActOutcome(req, {
        status: 422,
        json: json({ detail: "The submitter of a timesheet cannot approve it." }),
      }),
    ).toEqual({ kind: "refused", detail: "The submitter of a timesheet cannot approve it." });
    expect(
      await readActOutcome(req, { status: 404, json: () => Promise.reject(new Error("x")) }),
    ).toEqual({ kind: "refused", detail: "" });
    expect(await readActOutcome(req, { status: 503, json: json({}) })).toEqual({ kind: "failed" });
  });
});

/** A101: every tap opens its target, the record a notification carries the key of first. */
describe("taps open their target", () => {
  const tap = (data: Record<string, unknown> | null, category: string | null = null) =>
    tapRoute(response(DEFAULT_ACTION, data, category));

  it("opens the record a notification carries the key of, in its link's org", () => {
    expect(tap({ recordKey: "NWS-7", url: "compass://r/NWS-7?org=northwind" })).toBe(
      "/r/NWS-7?org=northwind",
    );
    expect(tap({ message_args: { recordKey: "NWS-7" }, url: "compass://inbox" })).toBe("/r/NWS-7");
    expect(notificationRoute({ recordKey: "NWS-7", org: "northwind" })).toBe(
      "/r/NWS-7?org=northwind",
    );
    expect(notificationRoute({ recordKey: "NWS-7", org: "Not A Slug" })).toBe("/r/NWS-7");
  });

  it("falls back to the deep link, which the sender resolved from the record and its project", () => {
    expect(tap({ recordKey: "not a key", url: "compass://r/NWS-42?org=northwind" })).toBe(
      "/r/NWS-42?org=northwind",
    );
    expect(tap({ url: "https://atlas.example.test/northwind/r/NWS-3" })).toBe(
      "/r/NWS-3?org=northwind",
    );
    expect(tap({ url: "compass://e/ENG-01J8000000E008000000025101" })).toBe(
      "/e/ENG-01J8000000E008000000025101",
    );
  });

  it("opens the route of a Compass link, else the Inbox", () => {
    expect(tap({ url: "compass://inbox" })).toBe("/inbox");
    expect(tap({ url: "compass:///schedule?day=2026-10-23" })).toBe("/schedule?day=2026-10-23");
    expect(tap({ url: "/schedule" })).toBe("/schedule");
    expect(tap({ url: "//elsewhere.test/r/NWS-1" })).toBe("/inbox");
    expect(tap({ url: "https://elsewhere.test/somewhere" })).toBe("/inbox");
    expect(tap({ url: 7 })).toBe("/inbox");
    expect(tap(null)).toBe("/inbox");
  });

  it("reads the data a simulator push nests in its body", () => {
    expect(tap({ body: { recordKey: "NWS-9", url: "compass://r/NWS-9?org=northwind" } })).toBe(
      "/r/NWS-9?org=northwind",
    );
    expect(tap({ body: JSON.stringify({ url: "compass://inbox" }) })).toBe("/inbox");
  });

  it("keeps an approval request's tap on the Inbox and leaves action buttons to the approval", () => {
    expect(tap({ notificationId: NOTE, recordKey: "NWS-7" }, APPROVAL_CATEGORY)).toBe("/inbox");
    expect(tapRoute(response("approve", { notificationId: NOTE }))).toBeNull();
  });
});

describe("the in-app Inbox opens notifications the same way", () => {
  const row = (overrides: Partial<InboxNotificationRow> = {}): InboxNotificationRow => ({
    id: "n1",
    kind: "assignment.created",
    createdAt: "2026-10-23T15:00:00Z",
    read: false,
    args: {},
    subjectTable: "app.records",
    subjectId: "r1",
    orgSlug: "northwind",
    lookedUpRecordKey: null,
    ...overrides,
  });

  it("opens the carried record key, or the one read from the record and its project", () => {
    expect(inboxTarget(row({ args: { recordKey: "NWS-7" } }))).toEqual({
      kind: "route",
      route: "/r/NWS-7?org=northwind",
    });
    expect(needsRecordLookup(row({ args: { recordKey: "NWS-7" } }))).toBe(false);
    expect(needsRecordLookup(row())).toBe(true);
    expect(inboxTarget(row({ lookedUpRecordKey: "NWS-42" }))).toEqual({
      kind: "route",
      route: "/r/NWS-42?org=northwind",
    });
    expect(inboxRecordKey(row({ lookedUpRecordKey: "NWS-42" }))).toBe("NWS-42");
    expect(inboxRecordKey(row({ args: { recordKey: "NWS-7" } }))).toBe("NWS-7");
    expect(inboxRecordKey(row({ lookedUpRecordKey: "bad" }))).toBeNull();
  });

  it("opens a Gateway page for what Compass has no screen for, and otherwise only informs", () => {
    const match = row({
      kind: "opportunity.matched",
      subjectTable: "opportunities",
      subjectId: "op1",
      args: { gatewayPath: "/explore/OPP-01J8000000E00800000002510A" },
    });
    expect(needsRecordLookup(match)).toBe(false);
    expect(inboxTarget(match)).toEqual({
      kind: "gateway",
      path: "/explore/OPP-01J8000000E00800000002510A",
    });
    expect(
      inboxTarget(row({ subjectTable: null, args: { gatewayPath: "https://x.test" } })),
    ).toBeNull();
    expect(needsRecordLookup(row({ subjectId: null }))).toBe(false);
  });
});
