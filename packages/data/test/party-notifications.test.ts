import { describe, expect, it } from "vitest";
import {
  listMyNotificationPreferences,
  listMyNotifications,
  setMyNotificationPreference,
} from "../src/party-notifications.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

describe("party notifications", () => {
  it("lists the latest notifications with display arguments only, and their subject", async () => {
    const { db, calls } = commercialClient({
      "from:notifications": [
        okResponse([
          {
            id: "n1",
            kind: "invoice.paid",
            created_at: "2027-06-06T10:00:00Z",
            read_at: null,
            archived_at: null,
            message_args: { title: "DSS-1", count: 2, nested: { no: true } },
            subject_table: null,
            subject_id: null,
          },
          {
            id: "n2",
            kind: "roster_entry.project_facts_entered",
            created_at: "2027-06-05T10:00:00Z",
            read_at: "2027-06-05T11:00:00Z",
            archived_at: null,
            message_args: { kind: "vehicle" },
            subject_table: "engagement_roster_entries",
            subject_id: "r1",
          },
        ]),
        errorResponse("08006", "down"),
      ],
    });
    const listed = await listMyNotifications(db, 3);
    expect(listed).toEqual({
      ok: true,
      data: [
        {
          id: "n1",
          kind: "invoice.paid",
          createdAt: "2027-06-06T10:00:00Z",
          read: false,
          args: { title: "DSS-1", count: "2" },
          subject: null,
        },
        {
          id: "n2",
          kind: "roster_entry.project_facts_entered",
          createdAt: "2027-06-05T10:00:00Z",
          read: true,
          args: { kind: "vehicle" },
          subject: { table: "engagement_roster_entries", id: "r1" },
        },
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["limit", [3]]);
    expect((await listMyNotifications(db)).ok).toBe(false);
  });

  it("fills preferences with the channel defaults", async () => {
    const { db } = commercialClient({
      "from:person_notification_preferences": [
        okResponse([{ category_code: "finance", channel: "Push", enabled: false }]),
      ],
    });
    expect(await listMyNotificationPreferences(db)).toEqual({
      ok: true,
      data: [
        { category: "finance", channel: "Email", enabled: true },
        { category: "finance", channel: "Push", enabled: false },
        { category: "opportunities", channel: "Email", enabled: true },
        { category: "opportunities", channel: "Push", enabled: true },
        { category: "expiry_reminders", channel: "Email", enabled: true },
        { category: "expiry_reminders", channel: "Push", enabled: true },
      ],
    });
  });

  it("updates a live preference or adds one", async () => {
    const { db, calls } = commercialClient({
      "from:person_notification_preferences": [
        okResponse([{ id: "p1" }]),
        okResponse([]),
        okResponse(null),
        errorResponse("42501", "denied"),
      ],
    });
    const input = {
      personId: "me",
      category: "finance",
      channel: "Email",
      enabled: false,
    } as const;
    expect(await setMyNotificationPreference(db, input)).toEqual({ ok: true, data: null });
    expect(await setMyNotificationPreference(db, input)).toEqual({ ok: true, data: null });
    expect(calls[2]?.steps).toContainEqual([
      "insert",
      [{ person_id: "me", category_code: "finance", channel: "Email", enabled: false }],
    ]);
    expect((await setMyNotificationPreference(db, input)).ok).toBe(false);
  });
});
