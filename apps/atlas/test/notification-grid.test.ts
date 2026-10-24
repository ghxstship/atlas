/**
 * A104: the notification grids of Personal settings, Notifications and Settings, Notifications offer a switch only
 * for the channels a category's kinds reach (notificationCategoryChannels, from the notification registry). The
 * other columns of the row stay, empty, with a sentence for assistive technology, and the save actions never write
 * a choice for them. Opportunities, whose one kind is never texted, has no SMS switch.
 */
import { getMessages } from "@xos/i18n";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  notificationCategoryChannels,
} from "@xos/schemas/notifications";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({
  mine: [] as unknown[],
  org: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { id: "org-1", slug: "demo" }, viewer: { db: {} } }),
}));
vi.mock("@xos/data/notification-settings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveMyNotificationPreferences: async (_db: unknown, _org: string, choices: unknown[]) => {
    saved.mine.push(...choices);
    return { ok: true, data: null };
  },
  saveMyNotificationSettings: async () => ({ ok: true, data: null }),
  recordMySmsConsent: async () => ({ ok: true, data: null }),
  saveOrgNotificationDefaults: async (
    _db: unknown,
    _org: string,
    input: { defaults: unknown[] },
  ) => {
    saved.org.push(...input.defaults);
    return { ok: true, data: null };
  },
}));

const { MyNotificationsForm, OrgNotificationDefaultsForm } =
  await import("@/components/settings/notification-forms");
const { saveMyNotificationsAction, saveOrgNotificationDefaultsAction } =
  await import("@/app/[org]/settings/notification-actions");

const messages = getMessages("en-US");
type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

/** The rows the A80 panels build: each category on the channels its kinds reach. */
const memberRows = NOTIFICATION_CATEGORIES.map((c) => ({
  category: c.code,
  urgent: c.urgent,
  cells: notificationCategoryChannels(c.code).map((channel) => ({
    channel,
    enabled: true,
    locked: false,
  })),
}));
const orgRows = NOTIFICATION_CATEGORIES.map((c) => ({
  category: c.code,
  urgent: c.urgent,
  mandatory: false,
  cells: notificationCategoryChannels(c.code).map((channel) => ({ channel, enabled: true })),
}));

const settings = {
  timeZone: "UTC",
  quietStart: "",
  quietEnd: "",
  digestFrequency: "Off",
  digestHour: 8,
};

/** The table row of a category, by its label. */
function row(html: string, label: string): string {
  const at = html.indexOf(`>${label}</span>`);
  expect(at, label).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
}

beforeEach(() => {
  saved.mine.length = 0;
  saved.org.length = 0;
});

describe("notification grids show only the channels a category reaches", () => {
  it("leaves Opportunities without an SMS switch on a member's grid, and says why", () => {
    const html = render(
      createElement(MyNotificationsForm, {
        org: "demo",
        rows: memberRows,
        settings,
        timeZones: [{ value: "UTC", label: "UTC" }],
        sms: { phone: null, mayText: false },
      }),
    );
    const opportunities = row(html, "Opportunities");
    expect(opportunities).not.toContain('name="cell.opportunities.SMS"');
    expect(opportunities).toContain('name="cell.opportunities.Email"');
    expect(opportunities).toContain("Nothing in Opportunities is sent by Text (SMS).");
    expect(html).not.toContain('name="was.opportunities.SMS"');
    // Every row keeps one cell per column, so the switches line up under their channel.
    expect(opportunities.match(/<td/g)).toHaveLength(NOTIFICATION_CHANNELS.length);
    expect(row(html, "Safety")).toContain('name="cell.safety.SMS"');
  });

  it("offers a switch on every grid exactly where a kind of the category is delivered", () => {
    const mine = render(
      createElement(MyNotificationsForm, {
        org: "demo",
        rows: memberRows,
        settings,
        timeZones: [{ value: "UTC", label: "UTC" }],
        sms: { phone: null, mayText: false },
      }),
    );
    const org = render(
      createElement(OrgNotificationDefaultsForm, { org: "demo", rows: orgRows, canEdit: true }),
    );
    for (const c of NOTIFICATION_CATEGORIES) {
      const reached = notificationCategoryChannels(c.code);
      for (const channel of NOTIFICATION_CHANNELS) {
        expect(mine.includes(`name="cell.${c.code}.${channel}"`), `${c.code} ${channel}`).toBe(
          reached.includes(channel),
        );
        expect(org.includes(`name="default.${c.code}.${channel}"`), `${c.code} ${channel}`).toBe(
          reached.includes(channel),
        );
      }
    }
  });

  it("saves no choice for a channel the category never reaches", async () => {
    const mine = new FormData();
    mine.set("org", "demo");
    mine.set("timeZone", "UTC");
    mine.set("digestFrequency", "Off");
    mine.set("digestHour", "8");
    // A crafted form that still posts an SMS cell for Opportunities.
    mine.set("was.opportunities.SMS", "off");
    mine.set("cell.opportunities.SMS", "on");
    mine.set("was.opportunities.Push", "off");
    mine.set("cell.opportunities.Push", "on");
    expect(await saveMyNotificationsAction({}, mine)).toEqual({ ok: true });
    expect(saved.mine).toEqual([{ category: "opportunities", channel: "Push", enabled: true }]);

    const org = new FormData();
    org.set("org", "demo");
    org.set("default.opportunities.SMS", "on");
    expect(await saveOrgNotificationDefaultsAction({}, org)).toEqual({ ok: true });
    const written = saved.org as { category: string; channel: string }[];
    expect(written.some((d) => d.category === "opportunities" && d.channel === "SMS")).toBe(false);
    expect(written.filter((d) => d.category === "opportunities").map((d) => d.channel)).toEqual(
      notificationCategoryChannels("opportunities"),
    );
  });
});
