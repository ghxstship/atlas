import { describe, expect, it } from "vitest";
import {
  APPROVAL_CATEGORY,
  DEFAULT_ACTION,
  readActionResponse,
  tapRoute,
} from "../src/domain/notifications";
import type { ActionResponseLike } from "../src/domain/notifications";
import {
  CATEGORY_ACTIONS,
  doneMessageKey,
  ENGAGEMENT_OFFER_CATEGORY,
  MESSAGE_REPLY_CATEGORY,
  needsUnlock,
  offerActRequest,
  readOfferOutcome,
  readOfferResponse,
  SHIFT_OFFER_CATEGORY,
} from "../src/domain/offer-actions";

/** A127: a shift offer, an engagement offer and a message answered from the push notification itself. */
const NOTE = "01920000-0000-7000-8000-00000000a127";

function response(
  actionIdentifier: string,
  data: Record<string, unknown> | null,
  categoryIdentifier: string | null,
  userText?: string,
): ActionResponseLike {
  return {
    actionIdentifier,
    ...(userText === undefined ? {} : { userText }),
    notification: { request: { identifier: "req-1", content: { categoryIdentifier, data } } },
  };
}

describe("offer and message push actions", () => {
  it("reads Accept and Decline on a shift offer", () => {
    expect(
      readOfferResponse(
        response("accept", { notificationId: NOTE, title: "Rigger" }, SHIFT_OFFER_CATEGORY),
      ),
    ).toEqual({
      notificationId: NOTE,
      category: SHIFT_OFFER_CATEGORY,
      action: "accept",
      comment: null,
      title: "Rigger",
    });
    expect(
      readOfferResponse(response("decline", { notificationId: NOTE }, SHIFT_OFFER_CATEGORY))
        ?.action,
    ).toBe("decline");
  });

  it("reads Accept on an engagement offer, taking the category from the data when it is there", () => {
    expect(
      readOfferResponse(
        response("accept", { notificationId: NOTE, categoryId: ENGAGEMENT_OFFER_CATEGORY }, null),
      )?.category,
    ).toBe(ENGAGEMENT_OFFER_CATEGORY);
  });

  it("reads a reply with its text, trimmed, and ignores an empty one", () => {
    expect(
      readOfferResponse(
        response("reply", { notificationId: NOTE }, MESSAGE_REPLY_CATEGORY, "  On my way "),
      ),
    ).toMatchObject({ action: "reply", comment: "On my way" });
    expect(
      readOfferResponse(response("reply", { notificationId: NOTE }, MESSAGE_REPLY_CATEGORY, "  ")),
    ).toBeNull();
  });

  it("reads the APNs body a simulator push hands over whole", () => {
    expect(
      readOfferResponse(
        response(
          "accept",
          { body: JSON.stringify({ notificationId: NOTE }) },
          SHIFT_OFFER_CATEGORY,
        ),
      )?.notificationId,
    ).toBe(NOTE);
  });

  it("ignores taps, approvals, actions a category does not carry and malformed ids", () => {
    expect(
      readOfferResponse(response(DEFAULT_ACTION, { notificationId: NOTE }, SHIFT_OFFER_CATEGORY)),
    ).toBeNull();
    expect(
      readOfferResponse(response("approve", { notificationId: NOTE }, APPROVAL_CATEGORY)),
    ).toBeNull();
    expect(
      readOfferResponse(response("reply", { notificationId: NOTE }, SHIFT_OFFER_CATEGORY, "Hi")),
    ).toBeNull();
    expect(
      readOfferResponse(response("accept", { notificationId: NOTE }, MESSAGE_REPLY_CATEGORY)),
    ).toBeNull();
    expect(
      readOfferResponse(response("accept", { notificationId: "x" }, SHIFT_OFFER_CATEGORY)),
    ).toBeNull();
  });

  it("never answers the approval listener's actions, nor that listener these", () => {
    expect(
      readActionResponse(response("accept", { notificationId: NOTE }, SHIFT_OFFER_CATEGORY)),
    ).toBeNull();
    expect(
      readActionResponse(response("decline", { notificationId: NOTE }, ENGAGEMENT_OFFER_CATEGORY)),
    ).toBeNull();
    // A tap on the body still opens its target, as A101 routes every tap.
    expect(
      tapRoute(
        response(
          DEFAULT_ACTION,
          { notificationId: NOTE, url: "compass://inbox" },
          SHIFT_OFFER_CATEGORY,
        ),
      ),
    ).toBe("/inbox");
  });

  it("accepts a shift from the lock screen and asks for an unlock for an offer or a reply", () => {
    expect(needsUnlock(SHIFT_OFFER_CATEGORY, "accept")).toBe(false);
    expect(needsUnlock(SHIFT_OFFER_CATEGORY, "decline")).toBe(false);
    expect(needsUnlock(ENGAGEMENT_OFFER_CATEGORY, "accept")).toBe(true);
    expect(needsUnlock(MESSAGE_REPLY_CATEGORY, "reply")).toBe(true);
    expect(CATEGORY_ACTIONS[MESSAGE_REPLY_CATEGORY]).toEqual(["reply"]);
  });

  it("answers through notifications.act with the person's token and one key per action", () => {
    const call = offerActRequest(
      "https://atlas.xos.test/",
      {
        notificationId: NOTE,
        category: MESSAGE_REPLY_CATEGORY,
        action: "reply",
        comment: "On my way",
        title: null,
      },
      "token-1",
    );
    expect(call.url).toBe(`https://atlas.xos.test/api/v1/notifications/${NOTE}/act`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "Idempotency-Key": `push-${NOTE}-reply`,
    });
    expect(JSON.parse(String(call.init.body))).toEqual({ action: "reply", comment: "On my way" });
    const accept = offerActRequest(
      "https://atlas.xos.test",
      {
        notificationId: NOTE,
        category: SHIFT_OFFER_CATEGORY,
        action: "accept",
        comment: null,
        title: null,
      },
      "t",
    );
    expect(JSON.parse(String(accept.init.body))).toEqual({ action: "accept" });
  });

  it("reads the answer and names the confirmation", async () => {
    const request = {
      notificationId: NOTE,
      category: SHIFT_OFFER_CATEGORY,
      action: "accept",
      comment: null,
      title: null,
    } as const;
    await expect(
      readOfferOutcome(request, { status: 200, json: async () => ({}) }),
    ).resolves.toEqual({ kind: "done", request });
    await expect(
      readOfferOutcome(request, {
        status: 422,
        json: async () => ({
          detail: "Only a published shift you have not accepted can be declined.",
        }),
      }),
    ).resolves.toEqual({
      kind: "refused",
      detail: "Only a published shift you have not accepted can be declined.",
    });
    await expect(
      readOfferOutcome(request, { status: 503, json: async () => ({}) }),
    ).resolves.toEqual({
      kind: "failed",
    });
    expect(doneMessageKey(request)).toBe("compass.offerActions.shiftAccepted");
    expect(
      doneMessageKey({ ...request, category: ENGAGEMENT_OFFER_CATEGORY, action: "decline" }),
    ).toBe("compass.offerActions.offerDeclined");
    expect(doneMessageKey({ ...request, category: MESSAGE_REPLY_CATEGORY, action: "reply" })).toBe(
      "compass.offerActions.replied",
    );
  });
});
