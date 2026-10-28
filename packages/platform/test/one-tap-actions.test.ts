import { readFileSync } from "node:fs";
import { RecordingTransport } from "@xos/email";
import { describe, expect, it } from "vitest";
import {
  ENGAGEMENT_OFFER_CATEGORY,
  MESSAGE_REPLY_CATEGORY,
  SHIFT_OFFER_CATEGORY,
  actionLinks,
  actionPath,
  dispatchEmail,
  isActionToken,
  notificationStore,
  pushCategoryFor,
  pushMessage,
  type ClaimedEmail,
  type ClaimedPush,
  type NotificationStore,
  type PlatformDb,
} from "../src/index.ts";

/** One-tap actions (A127, ADR 0086): email action links minted at dispatch, and the push categories of offers. */

const TOKEN = `xact_${"a".repeat(48)}.${"b".repeat(32)}`;
const TOKEN_2 = `xact_${"c".repeat(48)}.${"d".repeat(32)}`;
const BASES = { atlasUrl: "https://atlas.xos.test/", gatewayUrl: "https://gateway.xos.test" };

describe("action link signing and shape", () => {
  it("accepts only the minted shape: xact_, a 48 hex digit nonce, a dot and a 32 hex digit signature", () => {
    expect(isActionToken(TOKEN)).toBe(true);
    for (const bad of [
      "",
      `xact_${"a".repeat(47)}.${"b".repeat(32)}`,
      `xact_${"a".repeat(48)}.${"b".repeat(31)}`,
      `xact_${"A".repeat(48)}.${"b".repeat(32)}`,
      `xact_${"a".repeat(48)}${"b".repeat(32)}`,
      `${TOKEN}/../../admin`,
      `token_${"a".repeat(48)}.${"b".repeat(32)}`,
      42,
      null,
    ])
      expect(isActionToken(bad), String(bad)).toBe(false);
  });

  it("puts the confirm page at /auth/act/{token} and refuses to build a path for anything else", () => {
    expect(actionPath(TOKEN)).toBe(`/auth/act/${TOKEN}`);
    expect(() => actionPath("xact_nope")).toThrow(/Not an action token/);
  });

  it("links each minted token to its app's confirm page, leaving out what it cannot link safely", () => {
    expect(
      actionLinks(
        [
          { action: "approve", token: TOKEN, audience: "Atlas" },
          { action: "accept", token: TOKEN_2, audience: "Gateway" },
          { action: "delete", token: TOKEN, audience: "Atlas" },
          { action: "reject", token: "xact_short", audience: "Atlas" },
          { action: "reject", token: TOKEN, audience: "Console" },
        ],
        BASES,
      ),
    ).toEqual([
      { action: "approve", url: `https://atlas.xos.test/auth/act/${TOKEN}` },
      { action: "accept", url: `https://gateway.xos.test/auth/act/${TOKEN_2}` },
    ]);
    // Without Gateway's URL its links are left out; the email keeps its Open link.
    expect(
      actionLinks([{ action: "accept", token: TOKEN_2, audience: "Gateway" }], {
        atlasUrl: BASES.atlasUrl,
        gatewayUrl: null,
      }),
    ).toEqual([]);
  });
});

describe("minting at dispatch", () => {
  function fakeDb(minted: unknown) {
    const calls: { fn: string; args: Readonly<Record<string, unknown>> }[] = [];
    const db: PlatformDb = {
      async rpc(fn, args) {
        calls.push({ fn, args });
        if (fn === "mint_notification_action_tokens") return minted;
        if (fn === "claim_notification_deliveries")
          return [
            {
              delivery_id: "nd1",
              org_id: "org-1",
              recipient_person_id: "p1",
              address: "carol@northwind.test",
              kind: "approval.requested",
              email_template_code: "notification",
              message_args: { title: "Timesheet week 44" },
              subject_table: "timesheets",
              subject_id: "ts1",
              notification_id: "n1",
            },
          ];
        return null;
      },
      async selectOne() {
        return { slug: "northwind-live", name: "Northwind Live" };
      },
    };
    return { db, calls };
  }

  it("mints the delivery's tokens through app.mint_notification_action_tokens and links them", async () => {
    const { db, calls } = fakeDb([
      { action: "approve", token: TOKEN, audience: "Atlas", expires_at: "2026-11-03T00:00:00Z" },
      { action: "reject", token: TOKEN_2, audience: "Atlas", expires_at: "2026-11-03T00:00:00Z" },
    ]);
    const store = notificationStore(db, {
      appUrl: "https://atlas.xos.test",
      gatewayUrl: "https://gateway.xos.test",
      fromAddress: "notifications@mail.xos.test",
      postalAddress: "100 Harbor Way",
      unsubscribeUrl: async () => "https://fn.xos.test/u",
      inboundDomain: null,
    });
    const [claimed] = await store.claimEmail(10);
    expect(claimed?.notificationId).toBe("n1");
    if (!claimed) throw new Error("claim expected");
    await expect(store.actionLinksFor?.(claimed)).resolves.toEqual([
      { action: "approve", url: `https://atlas.xos.test/auth/act/${TOKEN}` },
      { action: "reject", url: `https://atlas.xos.test/auth/act/${TOKEN_2}` },
    ]);
    expect(calls.find((c) => c.fn === "mint_notification_action_tokens")?.args).toEqual({
      p_delivery_id: "nd1",
    });
  });

  it("renders the buttons in the email, approve before reject, each to its own confirm page", async () => {
    const claim: ClaimedEmail = {
      deliveryId: "nd1",
      orgId: "org-1",
      recipientPersonId: "p1",
      address: "carol@northwind.test",
      kind: "approval.requested",
      emailTemplateCode: "notification",
      messageArgs: { actorName: "Frank Ortiz", title: "Timesheet week 44" },
      subjectTable: "timesheets",
      subjectId: "ts1",
      notificationId: "n1",
    };
    const store = (actions: NotificationStore["actionLinksFor"]): NotificationStore => ({
      claimEmail: async () => [claim],
      senderFor: async () => ({
        orgName: "Northwind Live",
        postalAddress: "100 Harbor Way, Miami, FL 33132",
        preferencesUrl: "https://atlas.xos.test/northwind-live/me/notifications",
        unsubscribeUrl: "https://fn.xos.test/u",
        from: "Northwind Live <notifications@mail.xos.test>",
      }),
      recipient: async () => ({ name: "Carol", locale: "en-US", timeZone: "UTC" }),
      linkFor: async () => "https://atlas.xos.test/northwind-live/inbox",
      replyAddressFor: async () => null,
      record: async () => undefined,
      ...(actions ? { actionLinksFor: actions } : {}),
    });
    const transport = new RecordingTransport();
    await dispatchEmail(
      store(async () => [
        { action: "reject", url: `https://atlas.xos.test/auth/act/${TOKEN_2}` },
        { action: "approve", url: `https://atlas.xos.test/auth/act/${TOKEN}` },
      ]),
      transport,
    );
    const html = transport.sent[0]?.html ?? "";
    expect(html.indexOf(`/auth/act/${TOKEN}`)).toBeGreaterThan(-1);
    expect(html.indexOf(`/auth/act/${TOKEN}`)).toBeLessThan(html.indexOf(`/auth/act/${TOKEN_2}`));
    expect(transport.sent[0]?.text).toContain("Approve");
    expect(transport.sent[0]?.text).toContain("Reject");
    // A store that mints nothing sends the plain notification.
    const plain = new RecordingTransport();
    await dispatchEmail(store(undefined), plain);
    expect(plain.sent[0]?.html).not.toContain("/auth/act/");
  });
});

describe("push categories of offers and messages", () => {
  const claim = (kind: string, messageArgs: Record<string, unknown>): ClaimedPush => ({
    deliveryId: "d1",
    notificationId: "0197f3a2-1111-7000-8000-000000000001",
    orgId: "org-1",
    recipientPersonId: "p1",
    kind,
    categoryCode: "schedule",
    messageArgs,
    subjectTable: "app.shifts",
    subjectId: "s1",
    devices: [],
  });
  const recipient = { name: "Frank", locale: "en-US", timeZone: "UTC" };
  const device = { subscriptionId: "sub-1", token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]" };

  it("offers Accept only on a shift still Published, and always on an offer sent and a message", () => {
    expect(pushCategoryFor("shift.assigned", { shiftState: "Published" })).toBe(
      SHIFT_OFFER_CATEGORY,
    );
    expect(pushCategoryFor("shift.changed", { shiftState: "Published" })).toBe(
      SHIFT_OFFER_CATEGORY,
    );
    expect(pushCategoryFor("shift.assigned", { shiftState: "Accepted" })).toBeNull();
    expect(pushCategoryFor("shift.assigned", {})).toBeNull();
    expect(pushCategoryFor("offer.sent", {})).toBe(ENGAGEMENT_OFFER_CATEGORY);
    expect(pushCategoryFor("message.received", {})).toBe(MESSAGE_REPLY_CATEGORY);
    expect(pushCategoryFor("approval.requested", {})).toBe("approval_request");
    expect(pushCategoryFor("comment.created", {})).toBeNull();
  });

  it("sends a shift offer at high priority and a message's Reply at the default", () => {
    const shift = pushMessage(
      claim("shift.assigned", {
        title: "Rigger (Summer Series)",
        startsAt: "2026-11-03T14:00:00Z",
        shiftState: "Published",
      }),
      device,
      recipient,
      "compass://inbox",
    );
    expect(shift).toMatchObject({ categoryId: SHIFT_OFFER_CATEGORY, priority: "high" });
    const message = pushMessage(
      claim("message.received", { actorName: "Carol", conversation_id: "c1" }),
      device,
      recipient,
      "compass://inbox",
    );
    expect(message).toMatchObject({ categoryId: MESSAGE_REPLY_CATEGORY, priority: "default" });
  });

  it("uses only categories Compass registers with their actions in offer-actions.ts", () => {
    const compass = readFileSync(
      new URL("../../../apps/compass/src/domain/offer-actions.ts", import.meta.url),
      "utf8",
    );
    const registered = [...compass.matchAll(/export const \w+_CATEGORY = "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    for (const category of [
      SHIFT_OFFER_CATEGORY,
      ENGAGEMENT_OFFER_CATEGORY,
      MESSAGE_REPLY_CATEGORY,
    ])
      expect(registered).toContain(category);
  });
});
