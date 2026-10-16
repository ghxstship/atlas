import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getMessages, locales } from "@xos/i18n";
import { MemoryStore } from "@xos/sync";
import { workforceScreens } from "@xos/workforce-native";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { CACHE_TABLE, cachedRead } from "../src/workforce/cache";
import * as labels from "../src/workforce/labels";
import { WORKFORCE_ROUTES, hubEntries } from "../src/workforce/routes";
import { actionMessage } from "../src/workforce/messages";
import { myCourses } from "../src/workforce/training";

const appDir = fileURLToPath(new URL("../app", import.meta.url));

function routeFile(route: string): boolean {
  const base = `${appDir}${route}`;
  return existsSync(`${base}.tsx`) || existsSync(`${base}/index.tsx`);
}

async function translator(locale: string): Promise<labels.T> {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    resources: { [locale]: { translation: getMessages(locale as never) } },
    interpolation: { prefix: "{", suffix: "}", escapeValue: false },
  });
  return instance.t.bind(instance) as unknown as labels.T;
}

/** Every string in a label set, calling the label functions with sample values. */
const AT = "2027-06-01T12:00:00Z";

/** Sample arguments for the label functions that take something other than names, counts and times. */
const SAMPLES: Readonly<Record<string, readonly unknown[]>> = {
  reaction: ["thumbs_up", 2, true],
  level: [90],
  courseMeta: ["2027-06-10", 30],
  score: [7, 10, 6],
  plusOnes: [1, 2],
  count: [120, 400],
};

function strings(value: unknown, key = ""): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    return strings(fn(...(SAMPLES[key] ?? [AT, AT, AT, AT])));
  }
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => strings(v, k));
  return [];
}

describe("Workforce screens mounted in Compass", () => {
  it("gives every screen in workforceScreens a route file", () => {
    for (const screen of workforceScreens) {
      const mount = WORKFORCE_ROUTES[screen.name];
      expect(mount, screen.name).toBeDefined();
      expect(routeFile(mount.route), `${screen.name} at ${mount.route}`).toBe(true);
    }
    expect(routeFile("/workforce/survey/[surveyId]")).toBe(true);
    expect(routeFile("/workforce/forms/[templateId]")).toBe(true);
    expect(routeFile("/workforce")).toBe(true);
  });

  it("lists crew screens for every member and site operations by capability", () => {
    const none = hubEntries([]);
    expect(none.crew.map((e) => e.name)).toEqual([
      "FeedScreen",
      "SurveyScreen",
      "ConversationsScreen",
      "DirectoryScreen",
      "EventsScreen",
      "FormFillScreen",
      "TrainingScreen",
      "HandbookScreen",
      "RecognitionScreen",
      "HelpDeskScreen",
    ]);
    expect(none.siteOps).toEqual([]);
    expect(hubEntries(["credentials.scan.write"]).siteOps.map((e) => e.name)).toEqual([
      "DoorCheckInScreen",
    ]);
    expect(hubEntries(["safety.incident.write"]).siteOps.map((e) => e.node)).toEqual([
      "site-ops.occupancy",
      "site-ops.weather",
      "site-ops.lost-and-found",
    ]);
  });

  it.each(locales)("has every label of every screen in %s", async (locale) => {
    const t = await translator(locale);
    const sets = [
      labels.feedLabels(t),
      labels.surveyLabels(t, "Pulse"),
      labels.conversationsLabels(t),
      labels.threadLabels(t, "Crew"),
      labels.directoryLabels(t),
      labels.formLabels(t, "Rigging Check", "Near 25.77, -80.19"),
      labels.trainingLabels(t),
      labels.handbookLabels(t),
      labels.recognitionLabels(t),
      labels.helpDeskLabels(t),
      labels.occupancyLabels(t),
      labels.weatherLabels(t),
      labels.doorLabels(t),
      labels.lostFoundLabels(t),
    ];
    const all = sets.flatMap((set) => strings(set));
    expect(all.filter((s) => s.startsWith("workforce."))).toEqual([]);
    const events = labels.eventsLabels(t);
    expect(events.counts({ Going: 3, Maybe: 1, Declined: 0 })).toContain("3");
    expect(events.when("2027-06-01T12:00:00Z", "2027-06-01T13:00:00Z", "Gate B")).toContain(
      "Gate B",
    );
    expect(Object.values(events.kinds).every((v) => !v.startsWith("workforce."))).toBe(true);
    for (const key of ["title", "crew", "siteOps", "surveysEmpty", "formsEmpty"]) {
      expect(t(`workforce.compass.hub.${key}`)).not.toContain("workforce.");
    }
    for (const route of Object.values(WORKFORCE_ROUTES)) {
      expect(t(`workforce.compass.hub.screens.${route.label}`)).not.toContain("workforce.");
    }
  });
});

describe("Workforce reads and refusals", () => {
  it("keeps a device copy for offline reads and never serves it after a refusal", async () => {
    const store = new MemoryStore();
    const template = { id: "tpl-1", name: "Rigging Check" };
    expect(
      await cachedRead(store, "form_template:tpl-1", async () => ({ ok: true, data: template })),
    ).toEqual({ ok: true, data: template });
    expect((await store.list(CACHE_TABLE)).length).toBe(1);
    const offline = await cachedRead(store, "form_template:tpl-1", async () => ({
      ok: false,
      error: { kind: "unexpected", message: "Network request failed" },
    }));
    expect(offline).toEqual({ ok: true, data: template });
    const refused = await cachedRead(store, "form_template:tpl-1", async () => ({
      ok: false,
      error: { kind: "not-found" },
    }));
    expect(refused.ok).toBe(false);
    expect(
      (await cachedRead(null, "x", async () => ({ ok: false, error: { kind: "not-found" } }))).ok,
    ).toBe(false);
  });

  it("says a refusal in the person's language, or the server's sentence for an unknown rule", async () => {
    await i18next.init({
      lng: "en-US",
      resources: { "en-US": { translation: getMessages("en-US") } },
      interpolation: { prefix: "{", suffix: "}", escapeValue: false },
    });
    const t = i18next.t.bind(i18next) as unknown as (key: string) => string;
    expect(
      actionMessage({ kind: "refusal", rule: "poll_already_voted", message: "x" }, t),
    ).not.toContain("workforce.");
    expect(
      actionMessage({ kind: "refusal", rule: "no_such_rule", message: "Server says no." }, t),
    ).toBe("Server says no.");
    expect(actionMessage({ kind: "unexpected", message: "boom" }, t)).not.toContain("workforce.");
  });

  it("builds the person's courses from assignments, progress and results", () => {
    const lesson = (id: string) => ({ id }) as never;
    const course = (id: string, state = "Published") =>
      ({ id, state, lessons: [lesson(`${id}-l1`), lesson(`${id}-l2`)] }) as never;
    const mine = myCourses(
      [course("c1"), course("c2"), course("c3", "Draft")],
      [
        {
          id: "a1",
          courseId: "c1",
          membershipId: "me",
          name: null,
          dueOn: "2027-06-10",
          reason: null,
        },
        { id: "a2", courseId: "c2", membershipId: "me", name: null, dueOn: null, reason: null },
        { id: "a3", courseId: "c3", membershipId: "me", name: null, dueOn: null, reason: null },
        {
          id: "a4",
          courseId: "c2",
          membershipId: "other",
          name: null,
          dueOn: "2027-01-01",
          reason: null,
        },
      ],
      ["c1-l1", "zz"],
      [
        { courseId: "c2", membershipId: "me", passed: false, completedAt: "2027-01-01" },
        { courseId: "c2", membershipId: "me", passed: true, completedAt: "2027-02-01" },
      ] as never,
      ["me"],
    );
    expect(mine.map((m) => [m.course.id, m.dueOn, m.completedLessonIds, m.result])).toEqual([
      ["c1", "2027-06-10", ["c1-l1"], null],
      ["c2", null, [], "passed"],
    ]);
  });
});
