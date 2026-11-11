import { describe, expect, it, vi } from "vitest";

/**
 * A104: a party category is offered only the party channels its kinds reach. The registry is narrowed here as
 * report.delivered is (In App and Push only), so finance reaches Push and no Email switch is listed for it.
 */
vi.mock("@xos/schemas/notifications", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notificationCategoryChannels: (category: string) =>
    category === "finance" ? ["In App", "Push"] : ["In App", "Email", "SMS", "Push"],
}));

const { PARTY_CATEGORIES, listMyNotificationPreferences, partyChannels } =
  await import("../src/party-notifications.ts");
const { commercialClient, okResponse } = await import("./commercial-fake.ts");

describe("party channels (A104)", () => {
  it("offers each party category only the outside channels its kinds reach", () => {
    expect(PARTY_CATEGORIES.map((c) => [c, partyChannels(c)])).toEqual([
      ["finance", ["Push"]],
      ["opportunities", ["Email", "Push"]],
      ["expiry_reminders", ["Email", "Push"]],
    ]);
  });

  it("lists no preference for a channel the category never reaches", async () => {
    const { db } = commercialClient({
      "from:person_notification_preferences": [
        okResponse([{ category_code: "finance", channel: "Email", enabled: false }]),
      ],
    });
    const listed = await listMyNotificationPreferences(db);
    expect(listed.ok && listed.data.filter((p) => p.category === "finance")).toEqual([
      { category: "finance", channel: "Push", enabled: true },
    ]);
  });
});
