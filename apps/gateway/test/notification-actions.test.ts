import type * as Notifications from "@xos/schemas/notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A104: Gateway's notification save actions write only the channels a party category's kinds reach (partyChannels,
 * from the notification registry). A person's preferences form saves every party category on those channels, and a
 * company's defaults form saves only the one category it posts, so saving Finance never turns Opportunities off.
 * A crafted form that posts a channel the category cannot deliver on writes nothing for it.
 */

const calls = vi.hoisted(() => ({
  prefs: [] as { category: string; channel: string; enabled: boolean }[],
  defaults: [] as { accountId: string; defaults: { category: string; channel: string }[] }[],
  /** When set, Opportunities' kinds stop reaching Push, as if the registry narrowed it. */
  narrow: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/sitemap", () => ({
  requireNode: async () => ({ db: {}, personId: "person-1" }),
}));
vi.mock("@/lib/shell/context", () => ({
  getGatewayContext: async () => ({
    db: {},
    personId: "person-1",
    acting: { id: "account-1", roles: ["Account Owner"] },
  }),
}));
vi.mock("@xos/schemas/notifications", async (importOriginal) => {
  const real = await importOriginal<typeof Notifications>();
  return {
    ...real,
    notificationCategoryChannels: (category: string) =>
      real
        .notificationCategoryChannels(category)
        .filter((channel) => !(calls.narrow && category === "opportunities" && channel === "Push")),
  };
});
vi.mock("@xos/data/party-notifications", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setMyNotificationPreference: async (
    _db: unknown,
    input: { category: string; channel: string; enabled: boolean },
  ) => {
    calls.prefs.push({ category: input.category, channel: input.channel, enabled: input.enabled });
    return { ok: true, data: null };
  },
}));
vi.mock("@xos/data/company-settings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveAccountNotificationDefaults: async (
    _db: unknown,
    accountId: string,
    defaults: { category: string; channel: string }[],
  ) => {
    calls.defaults.push({ accountId, defaults });
    return { ok: true, data: null };
  },
}));

const { PARTY_CATEGORIES, PARTY_CHANNELS, partyChannels } =
  await import("@xos/data/party-notifications");
const { saveNotificationPreferencesAction } = await import("@/lib/actions/notifications");
const { saveCompanyDefaultsAction } = await import("@/lib/actions/surfaces");

/** A form with every party category's Email and Push checked, and a Text (SMS) box no party form offers. */
function everyBoxChecked(): FormData {
  const form = new FormData();
  for (const category of PARTY_CATEGORIES) {
    for (const channel of [...PARTY_CHANNELS, "SMS"]) form.set(`${category}.${channel}`, "on");
  }
  return form;
}

beforeEach(() => {
  calls.prefs.length = 0;
  calls.defaults.length = 0;
  calls.narrow = false;
});

describe("a person's Gateway notification preferences save only the channels a category reaches", () => {
  it("writes every party category on exactly its reached channels, checked or not", async () => {
    const form = everyBoxChecked();
    form.delete("finance.Email");
    expect(await saveNotificationPreferencesAction({}, form)).toEqual({ saved: 1 });
    expect(calls.prefs).toEqual(
      PARTY_CATEGORIES.flatMap((category) =>
        partyChannels(category).map((channel) => ({
          category,
          channel,
          enabled: !(category === "finance" && channel === "Email"),
        })),
      ),
    );
    expect(calls.prefs.some((p) => p.channel === "SMS")).toBe(false);
  });

  it("writes nothing for a channel the category's kinds stop reaching, even when the form posts it", async () => {
    calls.narrow = true;
    expect(await saveNotificationPreferencesAction({}, everyBoxChecked())).toEqual({ saved: 1 });
    const opportunities = calls.prefs.filter((p) => p.category === "opportunities");
    expect(opportunities.map((p) => p.channel)).toEqual(["Email"]);
    expect(calls.prefs.filter((p) => p.category === "finance").map((p) => p.channel)).toEqual(
      partyChannels("finance"),
    );
  });
});

describe("a company's Gateway notification defaults save one category per form", () => {
  it("writes only the posted category, on its reached channels, and leaves the others alone", async () => {
    const form = everyBoxChecked();
    form.set("category", "finance");
    form.delete("finance.Push");
    expect(await saveCompanyDefaultsAction({}, form)).toEqual({ done: true });
    expect(calls.defaults).toEqual([
      {
        accountId: "account-1",
        defaults: partyChannels("finance").map((channel) => ({
          category: "finance",
          channel,
          enabled: channel !== "Push",
        })),
      },
    ]);
  });

  it("writes nothing for a channel the category's kinds stop reaching", async () => {
    calls.narrow = true;
    const form = everyBoxChecked();
    form.set("category", "opportunities");
    expect(await saveCompanyDefaultsAction({}, form)).toEqual({ done: true });
    expect(calls.defaults).toEqual([
      {
        accountId: "account-1",
        defaults: [{ category: "opportunities", channel: "Email", enabled: true }],
      },
    ]);
  });

  it("refuses a form that names no category, or one that is not a party category", async () => {
    expect(await saveCompanyDefaultsAction({}, everyBoxChecked())).toEqual({ outcome: "invalid" });
    const form = everyBoxChecked();
    form.set("category", "safety");
    expect(await saveCompanyDefaultsAction({}, form)).toEqual({ outcome: "invalid" });
    expect(calls.defaults).toEqual([]);
  });
});
