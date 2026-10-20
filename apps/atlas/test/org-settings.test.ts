import type { ResolvedSetting } from "@xos/data/settings";
import { describe, expect, it } from "vitest";
import { weekStartOf } from "../lib/crew/time";
import {
  allowedVisibilities,
  devicePreference,
  engagementsToRate,
  feedSwitchDefaults,
  legalEntityDefaults,
  orgSupportOf,
  ratingPromptsOn,
  reviewRemovesUnreviewed,
  shellSettingsOf,
  startPageOf,
  startPath,
} from "../lib/shell/org-settings";

/**
 * The registered settings the Atlas shell and its pages apply (A65-001): each setting is changed here and the
 * shell's or the form's behavior observed.
 */

function resolved(values: Record<string, unknown>): Map<string, ResolvedSetting> {
  return new Map(
    Object.entries(values).map(([key, value]) => [
      key,
      { key, value: value as ResolvedSetting["value"], source: "Organization", locked: false },
    ]),
  );
}

const lookup = (values: Record<string, unknown>) => (key: string) => values[key];

describe("start page (shell.start_page)", () => {
  it("opens the chosen page after sign-in, Home otherwise", () => {
    expect(startPageOf(resolved({ "shell.start_page": "my-work" }))).toBe("my-work");
    expect(startPageOf(resolved({ "shell.start_page": "inbox" }))).toBe("inbox");
    expect(startPageOf(resolved({ "shell.start_page": "nowhere" }))).toBe("home");
    expect(startPageOf(resolved({}))).toBe("home");
    expect(startPath("northwind-live", "projects")).toBe("/northwind-live/projects");
  });
});

describe("org support contacts (help.support_email, help.support_hours, help.custom_link)", () => {
  it("shows what the org set in the help panel", () => {
    expect(orgSupportOf(resolved({}))).toBeNull();
    expect(
      orgSupportOf(
        resolved({
          "help.support_email": " ops@northwind.test ",
          "help.support_hours": "Monday to Friday, 9 AM to 6 PM Eastern",
          "help.custom_link": "https://wiki.northwind.test/crew",
        }),
      ),
    ).toEqual({
      email: "ops@northwind.test",
      hours: "Monday to Friday, 9 AM to 6 PM Eastern",
      link: "https://wiki.northwind.test/crew",
    });
  });

  it("drops a link that is not http or https", () => {
    expect(
      orgSupportOf(
        resolved({ "help.custom_link": "javascript:alert(1)", "help.support_hours": "Weekdays" }),
      ),
    ).toEqual({ email: null, hours: "Weekdays", link: null });
  });
});

describe("display preferences through the shell", () => {
  it("encodes what the person chose so the cookie can follow", () => {
    const settings = shellSettingsOf(
      resolved({
        "shell.density": "compact",
        "me.text_size": "large",
        "shell.start_page": "inbox",
      }),
    );
    expect(settings.preferences.density).toBe("compact");
    expect(settings.encoded).toBe("t.large|d.compact");
    expect(settings.startPage).toBe("inbox");
    expect(shellSettingsOf(resolved({})).encoded).toBe("");
  });

  it("starts weeks on the chosen day (payroll.week_start)", () => {
    // 2027-06-09 is a Wednesday.
    expect(weekStartOf("2027-06-09", 0)).toBe("2027-06-06");
    expect(weekStartOf("2027-06-09", 1)).toBe("2027-06-07");
    expect(weekStartOf("2027-06-06", 0)).toBe("2027-06-06");
  });
});

describe("form defaults from org settings", () => {
  it("starts the feed composer from the org's reaction and comment defaults", () => {
    expect(feedSwitchDefaults(lookup({}))).toEqual(["reactionsEnabled", "commentsEnabled"]);
    expect(
      feedSwitchDefaults(
        lookup({
          "communication.feed_reactions_default": false,
          "communication.feed_comments_default": true,
        }),
      ),
    ).toEqual(["commentsEnabled"]);
    expect(
      feedSwitchDefaults(
        lookup({
          "communication.feed_reactions_default": false,
          "communication.feed_comments_default": false,
        }),
      ),
    ).toEqual([]);
  });

  it("starts a new access review from access_reviews.remove_unreviewed", () => {
    expect(reviewRemovesUnreviewed(lookup({ "access_reviews.remove_unreviewed": true }))).toBe(
      true,
    );
    expect(reviewRemovesUnreviewed(lookup({}))).toBe(false);
  });

  it("starts a new legal entity from org.fiscal_year_start_month and org.base_currency", () => {
    expect(legalEntityDefaults(lookup({}))).toEqual({ month: "1", currency: "USD" });
    expect(
      legalEntityDefaults(lookup({ "org.fiscal_year_start_month": 7, "org.base_currency": "cad" })),
    ).toEqual({ month: "7", currency: "CAD" });
  });

  it("offers only the posting visibilities gateway.marketplace_visibility allows", () => {
    const all = ["Invited", "Pool", "Network", "Public"] as const;
    expect(allowedVisibilities(lookup({}), all)).toEqual(["Invited", "Pool", "Network"]);
    expect(
      allowedVisibilities(lookup({ "gateway.marketplace_visibility": "public" }), all),
    ).toEqual([...all]);
    expect(
      allowedVisibilities(lookup({ "gateway.marketplace_visibility": "private" }), all),
    ).toEqual(["Invited", "Pool"]);
  });
});

describe("rating prompts (gateway.ratings_enabled, ADR 0038)", () => {
  const completed = [
    { id: "unrated", orgRated: false },
    { id: "rated", orgRated: true },
  ];

  it("prompts members to rate completed engagements by default", () => {
    expect(ratingPromptsOn(lookup({}))).toBe(true);
    expect(engagementsToRate(lookup({}), completed).map((e) => e.id)).toEqual(["unrated"]);
  });

  it("drops only the prompts when they are off, never the engagements or their ratings", () => {
    const off = lookup({ "gateway.ratings_enabled": false });
    expect(ratingPromptsOn(off)).toBe(false);
    expect(engagementsToRate(off, completed)).toEqual([]);
    // The input is untouched: ratings and engagements are read and shown as before.
    expect(completed.map((e) => e.id)).toEqual(["unrated", "rated"]);
  });
});

describe("device preferences saved on settings pages (me.theme, locale.language)", () => {
  it("names the cookie a saved theme or language sets on this device", () => {
    const themes = ["dark", "light"];
    const locales = ["en-US", "es-US"];
    expect(devicePreference("me.theme", "light", themes, locales)).toEqual({
      cookie: "theme",
      value: "light",
    });
    expect(devicePreference("me.theme", "system", themes, locales)).toBeNull();
    expect(devicePreference("locale.language", "es-US", themes, locales)).toEqual({
      cookie: "locale",
      value: "es-US",
    });
    expect(devicePreference("locale.language", "fr-FR", themes, locales)).toBeNull();
    expect(devicePreference("shell.density", "compact", themes, locales)).toBeNull();
  });
});
