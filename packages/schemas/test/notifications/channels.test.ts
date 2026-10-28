import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  categoryChannels,
  notificationCategoryChannels,
  preferenceMatrix,
  type KindDefinition,
  type NotificationChannel,
} from "../../src/notifications/index.ts";

/**
 * A104: a preference grid offers a switch only for the channels a category's kinds reach. A switch for any other
 * channel (SMS for opportunities, whose one kind names In App, Email and Push) could never deliver anything.
 */

function kind(name: string, category: string, channels: readonly NotificationChannel[]) {
  return {
    kind: name,
    category,
    emailTemplate: "notification",
    pushCategory: null,
    quietHoursBypass: null,
    channels,
    copy: { subject: `kinds.${name}.subject`, body: `kinds.${name}.body` },
  } satisfies KindDefinition;
}

describe("the channels a category's kinds reach", () => {
  it("joins the channels of every kind in the category, in matrix order", () => {
    const kinds = [
      kind("report.delivered", "reports", ["Push", "In App"]),
      kind("import.finished", "imports", ["In App", "Email"]),
      kind("export.ready", "imports", ["Push", "Email"]),
    ];
    expect(categoryChannels({ kinds }, "reports")).toEqual(["In App", "Push"]);
    expect(categoryChannels({ kinds }, "imports")).toEqual(["In App", "Email", "Push"]);
    expect(categoryChannels({ kinds }, "safety")).toEqual([]);
  });

  it("offers no SMS switch for opportunities, whose only kind is never texted", () => {
    expect(
      NOTIFICATION_KINDS.filter((k) => k.category === "opportunities").map((k) => k.kind),
    ).toEqual(["opportunity.matched"]);
    expect(notificationCategoryChannels("opportunities")).toEqual(["In App", "Email", "Push"]);
    expect(notificationCategoryChannels("not-a-category")).toEqual([]);
  });

  it("reads the generated registry for every category, as the preference matrix does", () => {
    const matrix = preferenceMatrix({
      categories: NOTIFICATION_CATEGORIES,
      kinds: NOTIFICATION_KINDS,
    });
    for (const row of matrix) {
      expect(notificationCategoryChannels(row.code), row.code).toEqual(row.channels);
      // Each channel is offered exactly when some kind of the category is delivered on it.
      for (const channel of NOTIFICATION_CHANNELS) {
        const reached = NOTIFICATION_KINDS.some(
          (k) => k.category === row.code && k.channels.includes(channel),
        );
        expect(row.channels.includes(channel), `${row.code} ${channel}`).toBe(reached);
      }
    }
  });
});
