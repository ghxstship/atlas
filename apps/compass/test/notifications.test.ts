import { describe, expect, it } from "vitest";
import {
  actRequest,
  APPROVAL_CATEGORY,
  DEFAULT_ACTION,
  isApprovalTap,
  readActionResponse,
  readActOutcome,
  type ActionResponseLike,
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
    expect(call.init.headers).toMatchObject({ Authorization: "Bearer jwt" });
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
