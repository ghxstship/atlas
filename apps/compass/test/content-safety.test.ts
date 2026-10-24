import { readFileSync } from "node:fs";
import { getMessages, launchLocales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  canBlock,
  CONTENT_ACTIONS_TEST_ID,
  CONTENT_REPORT_REASONS,
  firstStep,
  nounKey,
  REASON_KEYS,
  REASON_TEST_IDS,
  REPORT_RESPONSE_HOURS,
} from "../src/domain/contentSafety";

/** Report and block in Compass (owner decision 19, App Store Review Guideline 1.2). */

const post = {
  kind: "Feed Post" as const,
  id: "p1",
  authorMembershipId: "m1",
  authorName: "Ana",
};

function lookup(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], catalog);
}

describe("the content safety sheet's rules", () => {
  it("offers Block only when the item names its author's membership, and opens on Report otherwise", () => {
    expect(canBlock(post)).toBe(true);
    expect(firstStep(post)).toBe("menu");
    const unknownAuthor = { ...post, authorMembershipId: null, authorName: null };
    expect(canBlock(unknownAuthor)).toBe(false);
    expect(firstStep(unknownAuthor)).toBe("report");
  });

  it("names every reason the database takes, each with its own key and test id", () => {
    expect(Object.keys(REASON_KEYS)).toEqual([...CONTENT_REPORT_REASONS]);
    expect(new Set(Object.values(REASON_TEST_IDS)).size).toBe(CONTENT_REPORT_REASONS.length);
    for (const id of Object.values(REASON_TEST_IDS)) expect(id).toMatch(/^report-reason-[a-z-]+$/);
  });

  it("promises the moderators' 24 hours", () => {
    expect(REPORT_RESPONSE_HOURS).toBe(24);
  });

  it("maps each noun to its copy", () => {
    expect([nounKey("post"), nounKey("message"), nounKey("shoutOut")]).toEqual([
      "Post",
      "Message",
      "ShoutOut",
    ]);
  });
});

describe("the copy, in every launch locale", () => {
  const sheet = readFileSync(
    new URL("../src/screens/ContentSafetySheet.tsx", import.meta.url),
    "utf8",
  );
  const blocked = readFileSync(
    new URL("../app/settings/profile-privacy.tsx", import.meta.url),
    "utf8",
  );
  const used = [
    ...`${sheet}\n${blocked}`.matchAll(/"(compass\.(?:safety|blocked)\.[A-Za-z.]+)"/g),
  ].map((m) => m[1] ?? "");
  const keys = [
    ...used,
    ...(["Post", "Message", "ShoutOut"] as const).flatMap((n) => [
      `compass.safety.actions${n}`,
      `compass.safety.report${n}`,
    ]),
    ...Object.values(REASON_KEYS).map((k) => `compass.safety.reasons.${k}`),
    "compass.settings.blockedPeople",
    "compass.settings.blockedPeopleHelp",
    "workforce.refusals.content_report_own",
    "workforce.refusals.content_report_removed",
    "workforce.refusals.block_self",
  ];

  it.each(launchLocales)("%s has every string the sheet and Blocked People use", (locale) => {
    expect(used.length).toBeGreaterThan(20);
    const catalog = getMessages(locale);
    for (const key of keys) expect(typeof lookup(catalog, key), `${locale} ${key}`).toBe("string");
  });

  it("names the author in each button's accessible name", () => {
    const catalog = getMessages("en-US");
    for (const n of ["Post", "Message", "ShoutOut"]) {
      expect(lookup(catalog, `compass.safety.actions${n}`)).toContain("{name}");
    }
    expect(CONTENT_ACTIONS_TEST_ID).toBe("content-actions");
  });
});
