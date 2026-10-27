import type { XosClient } from "@xos/data";
import {
  saveMyNotificationPreferences,
  saveMyNotificationSettings,
} from "@xos/data/notification-settings";
import { setMyNotificationPreference, setMyQuietHours } from "@xos/data/party-notifications";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_KINDS } from "@xos/schemas/notifications";
import type { Mutation } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { partyPreferenceRoute, settingsRoutes } from "../src/data/settingsRoutes";
import {
  cellId,
  channelWrite,
  matrixRows,
  matrixView,
  orgSettingsOf,
  orgSettingsRow,
  orgSettingsWrite,
  PARTY_PREFERENCE_TARGET,
  partyChannels,
  partyRows,
  partyView,
  partyWrite,
  quietHoursOf,
  quietHoursRow,
  quietHoursWrite,
  reachedChannels,
  withSmsConsent,
} from "../src/settings/notifications";

/**
 * The notification matrix in Compass (A111, S4.3-15 part 3): each category on the channels its kinds reach, the
 * member's matrix per org with the org's locks, the party preferences for everyone, and the writes, which call the
 * same RPCs with the same arguments as Atlas and Gateway.
 */

const ORG = "01920000-0000-7000-8000-000000000001";
const PERSON = "01920000-0000-7000-8000-000000000104";

const KINDS = [
  { category: "mentions", channels: ["In App", "Email"] },
  { category: "mentions", channels: ["Push"] },
  { category: "reports", channels: ["In App", "Push"] },
  { category: "opportunities", channels: ["In App", "Email", "Push"] },
  { category: "finance", channels: ["Email", "SMS", "In App"] },
] as const;

const CATEGORIES = [
  { code: "reports", urgent: false, order: 9 },
  { code: "mentions", urgent: false, order: 1 },
  { code: "safety", urgent: true, order: 7 },
];

/** The value, or a failed test when it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/** A fake client that records each RPC and table write, the way the shared data functions call it. */
function recordingClient() {
  const calls: { kind: string; name: string; args: unknown }[] = [];
  const chain = (name: string, kind: string, args: unknown) => {
    calls.push({ kind, name, args });
    const result = { data: [{ id: "row" }], error: null };
    const builder: Record<string, unknown> = {
      eq: () => builder,
      is: () => builder,
      select: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return builder;
  };
  const db = {
    rpc: (name: string, args: unknown) => {
      calls.push({ kind: "rpc", name, args });
      return Promise.resolve({ data: 1, error: null });
    },
    from: (table: string) => ({
      update: (values: unknown) => chain(table, "update", values),
      insert: (values: unknown) => chain(table, "insert", values),
    }),
  };
  return { db: db as unknown as XosClient, calls };
}

describe("the channels a category reaches", () => {
  it("are the channels its kinds are delivered on, in matrix order", () => {
    expect(reachedChannels("mentions", KINDS)).toEqual(["In App", "Email", "Push"]);
    expect(reachedChannels("finance", KINDS)).toEqual(["In App", "Email", "SMS"]);
    expect(reachedChannels("reports", KINDS)).toEqual(["In App", "Push"]);
  });

  it("are none for a category without kinds", () => {
    expect(reachedChannels("safety", KINDS)).toEqual([]);
  });

  it("follow the generated registry by default", () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const channels = new Set(
        NOTIFICATION_KINDS.filter((k) => k.category === category.code).flatMap((k) => k.channels),
      );
      expect(new Set(reachedChannels(category.code))).toEqual(channels);
    }
  });

  it("offer a party category only Email and Push, and only where its kinds reach them", () => {
    expect(partyChannels("opportunities", KINDS)).toEqual(["Email", "Push"]);
    expect(partyChannels("finance", KINDS)).toEqual(["Email"]);
    expect(partyChannels("expiry_reminders", KINDS)).toEqual([]);
  });
});

describe("the member's matrix in an org", () => {
  const cells = [
    { category: "mentions", channel: "Email" as const, enabled: true, locked: false },
    { category: "mentions", channel: "SMS" as const, enabled: true, locked: false },
    { category: "reports", channel: "Push" as const, enabled: true, locked: true },
  ];
  const rows = matrixRows(ORG, cells, CATEGORIES, KINDS);

  it("holds a row per category and reached channel, categories in display order", () => {
    expect(rows.map((r) => r.id)).toEqual([
      cellId(ORG, "mentions", "In App"),
      cellId(ORG, "mentions", "Email"),
      cellId(ORG, "mentions", "Push"),
      cellId(ORG, "reports", "In App"),
      cellId(ORG, "reports", "Push"),
    ]);
  });

  it("never offers a channel the category does not reach, even when the server sent it", () => {
    expect(rows.some((r) => r["channel"] === "SMS")).toBe(false);
    expect(rows.some((r) => r["category"] === "safety")).toBe(false);
  });

  it("reads a cell the server did not send as off and unlocked", () => {
    const push = rows.find((r) => r.id === cellId(ORG, "mentions", "Push"));
    expect(push).toMatchObject({ enabled: false, locked: false });
  });

  it("draws one card per category with its channels in order, and only the selected org's", () => {
    const other = matrixRows("01920000-0000-7000-8000-000000000002", cells, CATEGORIES, KINDS);
    const view = matrixView([...other, ...rows].reverse(), ORG);
    expect(view.map((v) => v.category)).toEqual(["mentions", "reports"]);
    expect(view[0]?.cells.map((c) => c.channel)).toEqual(["In App", "Email", "Push"]);
    expect(view[1]?.cells.find((c) => c.channel === "Push")).toMatchObject({
      enabled: true,
      locked: true,
    });
  });

  it("marks urgent categories", () => {
    const urgent = matrixRows(ORG, [], CATEGORIES, [{ category: "safety", channels: ["Push"] }]);
    expect(matrixView(urgent, ORG)).toEqual([
      {
        category: "safety",
        urgent: true,
        cells: [
          { rowId: cellId(ORG, "safety", "Push"), channel: "Push", enabled: false, locked: false },
        ],
      },
    ]);
  });
});

describe("changing a channel", () => {
  const rows = matrixRows(
    ORG,
    [
      { category: "mentions", channel: "Email", enabled: true, locked: false },
      { category: "reports", channel: "Push", enabled: true, locked: true },
    ],
    CATEGORIES,
    KINDS,
  );
  const email = must(rows.find((r) => r.id === cellId(ORG, "mentions", "Email")));
  const locked = must(rows.find((r) => r.id === cellId(ORG, "reports", "Push")));

  it("queues one choice for the org with its optimistic cell", () => {
    expect(channelWrite(email, false)).toEqual({
      op: "rpc",
      target: "set_my_notification_preferences",
      table: "_me_notification_matrix",
      rowId: cellId(ORG, "mentions", "Email"),
      payload: {
        p_org_id: ORG,
        p_preferences: [{ category: "mentions", channel: "Email", enabled: false }],
      },
      policy: "append",
      optimistic: { ...email, enabled: false },
    });
  });

  it("sends nothing when the cell already holds the value", () => {
    expect(channelWrite(email, true)).toBeNull();
  });

  it("never turns off a channel the org locked on, which the database refuses", () => {
    expect(channelWrite(locked, false)).toBeNull();
  });

  it("calls the RPC Atlas calls, with the same arguments", async () => {
    const { db, calls } = recordingClient();
    await saveMyNotificationPreferences(db, ORG, [
      { category: "mentions", channel: "Email", enabled: false },
    ]);
    const write = must(channelWrite(email, false));
    expect(calls).toEqual([{ kind: "rpc", name: write.target, args: write.payload }]);
  });
});

describe("the member's quiet hours, digest and texts in an org", () => {
  it("start from the zone texts are timed by, the digest off at 08:00, and the phone's last four digits", () => {
    const row = orgSettingsRow(ORG, null, "America/Chicago", "America/New_York", {
      phone: "+13055550142",
      mayText: false,
    });
    expect(row).toEqual({
      id: ORG,
      org_id: ORG,
      time_zone: "America/Chicago",
      quiet_hours_start: null,
      quiet_hours_end: null,
      digest_frequency: "Off",
      digest_hour: 8,
      phone_last4: "0142",
      may_text: false,
    });
    expect(
      orgSettingsRow(ORG, null, null, "America/New_York", { phone: null, mayText: false }),
    ).toMatchObject({
      time_zone: "America/New_York",
      phone_last4: null,
    });
  });

  it("keep what the member saved", () => {
    const row = orgSettingsRow(
      ORG,
      {
        timeZone: "America/Los_Angeles",
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
        digestFrequency: "Daily",
        digestHour: 6,
      },
      "America/Chicago",
      "UTC",
      { phone: null, mayText: false },
    );
    expect(orgSettingsOf(row)).toEqual({
      timeZone: "America/Los_Angeles",
      quietStart: "22:00",
      quietEnd: "07:00",
      digestFrequency: "Daily",
      digestHour: 6,
      phoneLast4: null,
      mayText: false,
    });
  });

  it("read a damaged device row safely", () => {
    expect(orgSettingsOf(undefined)).toBeNull();
    expect(
      orgSettingsOf({ id: ORG, digest_frequency: "Hourly", digest_hour: 31, time_zone: "" }),
    ).toMatchObject({ digestFrequency: "Off", digestHour: 8, timeZone: "UTC" });
  });

  it("queue as Atlas saves them, with the same arguments", async () => {
    const row = orgSettingsRow(ORG, null, "America/Chicago", "UTC", { phone: null, mayText: true });
    const write = orgSettingsWrite(
      row,
      { start: "22:00", end: "07:00", timeZone: "America/Chicago" },
      { frequency: "Weekly", hour: 9 },
    );
    expect(write.optimistic).toMatchObject({
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      digest_frequency: "Weekly",
      digest_hour: 9,
      may_text: true,
    });
    const { db, calls } = recordingClient();
    await saveMyNotificationSettings(db, ORG, {
      timeZone: "America/Chicago",
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      digestFrequency: "Weekly",
      digestHour: 9,
    });
    expect(calls).toEqual([{ kind: "rpc", name: write.target, args: write.payload }]);
  });

  it("send null times to turn quiet hours off", () => {
    const row = orgSettingsRow(ORG, null, null, "UTC", { phone: null, mayText: false });
    const write = orgSettingsWrite(
      row,
      { start: null, end: null, timeZone: "UTC" },
      { frequency: "Off", hour: 8 },
    );
    expect(write.payload).toMatchObject({ p_quiet_hours_start: null, p_quiet_hours_end: null });
  });

  it("show consent to texts once the server recorded it", () => {
    const row = orgSettingsRow(ORG, null, null, "UTC", { phone: "+13055550142", mayText: false });
    expect(orgSettingsOf(withSmsConsent(row, true))?.mayText).toBe(true);
  });
});

describe("everyone's party preferences", () => {
  const rows = partyRows(
    [
      { category: "finance", channel: "Email", enabled: false },
      { category: "finance", channel: "Push", enabled: true },
      { category: "opportunities", channel: "Email", enabled: true },
      { category: "opportunities", channel: "Push", enabled: false },
    ],
    KINDS,
  );

  it("hold each party category on the channels it reaches", () => {
    expect(rows.map((r) => r.id)).toEqual([
      "finance:Email",
      "opportunities:Email",
      "opportunities:Push",
    ]);
    expect(partyView(rows)).toEqual([
      {
        category: "finance",
        cells: [{ rowId: "finance:Email", channel: "Email", enabled: false }],
      },
      {
        category: "opportunities",
        cells: [
          { rowId: "opportunities:Email", channel: "Email", enabled: true },
          { rowId: "opportunities:Push", channel: "Push", enabled: false },
        ],
      },
    ]);
  });

  it("default to on where nothing was resolved", () => {
    expect(partyRows([], KINDS).every((r) => r["enabled"] === true)).toBe(true);
  });

  it("queue a change for the uploader's route, which writes the row as Gateway does", async () => {
    const row = must(rows.find((r) => r.id === "finance:Email"));
    expect(partyWrite(row, PERSON, false)).toBeNull();
    const write = must(partyWrite(row, PERSON, true));
    expect(write).toMatchObject({
      target: PARTY_PREFERENCE_TARGET,
      table: "_me_party_preferences",
      payload: { person_id: PERSON, category: "finance", channel: "Email", enabled: true },
      optimistic: { ...row, enabled: true },
    });

    const gateway = recordingClient();
    await setMyNotificationPreference(gateway.db, {
      personId: PERSON,
      category: "finance",
      channel: "Email",
      enabled: true,
    });
    const compass = recordingClient();
    const outcome = await must(settingsRoutes(compass.db)[PARTY_PREFERENCE_TARGET])({
      ...write,
      id: "m1",
      seq: 1,
      target: must(write.target),
      base: null,
      policy: "append",
      dependsOn: [],
      queuedAt: "2026-10-24T08:00:00Z",
      attempts: 0,
      nextAttemptAt: 0,
      status: "pending",
      lastError: null,
      serverRow: null,
    } as Mutation);
    expect(outcome).toEqual({ kind: "applied", serverRow: null });
    expect(compass.calls).toEqual(gateway.calls);
  });

  it("refuse a queued payload that is not a party preference, without sending it", async () => {
    const { db, calls } = recordingClient();
    const outcome = await partyPreferenceRoute(db)({
      payload: { person_id: PERSON, category: "mentions", channel: "SMS", enabled: true },
    } as unknown as Mutation);
    expect(outcome.kind).toBe("refused");
    expect(calls).toEqual([]);
  });
});

describe("the person's own quiet hours", () => {
  it("start in the fallback zone with quiet hours off", () => {
    expect(quietHoursOf(quietHoursRow(null, "America/New_York"), "UTC")).toEqual({
      timeZone: "America/New_York",
      start: null,
      end: null,
    });
    expect(quietHoursOf(undefined, "America/Denver")).toEqual({
      timeZone: "America/Denver",
      start: null,
      end: null,
    });
  });

  it("queue as Gateway saves them, with the same arguments", async () => {
    const row = quietHoursRow({ timeZone: "UTC", start: null, end: null }, "UTC");
    for (const value of [
      { timeZone: "Europe/Rome", start: "23:00", end: "06:30" },
      { timeZone: "Europe/Rome", start: null, end: null },
    ]) {
      const write = quietHoursWrite(row, value);
      expect(write.optimistic).toMatchObject({
        time_zone: value.timeZone,
        quiet_hours_start: value.start,
        quiet_hours_end: value.end,
      });
      const { db, calls } = recordingClient();
      await setMyQuietHours(db, value);
      expect(calls).toEqual([{ kind: "rpc", name: write.target, args: write.payload }]);
    }
  });
});
