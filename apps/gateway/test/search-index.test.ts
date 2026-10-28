import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import { toDisplayKey, type GatewaySearchHit } from "@xos/data/gateway";
import { sitemap } from "../ia/sitemap.generated";
import {
  actionItems,
  hitGroups,
  hitItem,
  matchesWords,
  settingItems,
} from "../lib/shell/search-index";
import { navContext } from "../lib/shell/standing";

/**
 * Gateway search (A126, RRR-171, Section 11.10 item 1): how a result reads and opens, the actions and the
 * settings one search reaches, on the pages the viewer may open.
 */

const messages = getMessages("en-US") as unknown as Record<string, unknown>;

/** The en-US catalog with `{name}` arguments filled, enough for these labels (no plurals). */
function t(key: string, values: Record<string, string | number> = {}): string {
  const found = key.split(".").reduce<unknown>((node, part) => {
    return node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }, messages);
  if (typeof found !== "string") throw new Error(`missing message ${key}`);
  return found.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? ""));
}

const individual = navContext({
  standing: "individual",
  companyAccount: false,
  platformDomain: true,
  desktop: false,
});
const unpaid = navContext({
  standing: "individual",
  companyAccount: false,
  platformDomain: true,
  desktop: false,
  paidWork: false,
});

const ENGAGEMENT = "01920000-0000-7000-8000-000000228401";
const THREAD = "01920000-0000-7000-8000-000000228501";

function hit(over: Partial<GatewaySearchHit>): GatewaySearchHit {
  return {
    type: "document",
    id: "01920000-0000-7000-8000-000000228601",
    parentId: ENGAGEMENT,
    kind: "Agreement",
    title: "Crew Addendum",
    detail: "Northwind Summer Series",
    orgId: "o1",
    orgName: "Northwind Live",
    datedAt: null,
    rank: 1,
    ...over,
  };
}

describe("matchesWords", () => {
  it("needs every word, ignoring case and accents", () => {
    expect(matchesWords("Configuración de notificaciones", ["configuracion", "NOTIF"])).toBe(true);
    expect(matchesWords("Time zone", ["time", "money"])).toBe(false);
    expect(matchesWords("Anything", [])).toBe(false);
  });
});

describe("results", () => {
  it("names a document with its kind and org and opens its engagement's documents", () => {
    expect(hitItem(hit({}), t)).toEqual({
      label: "Crew Addendum · Agreement · Northwind Live",
      icon: "FileText",
      href: `/work/engagements/${toDisplayKey("engagement", ENGAGEMENT)}/documents`,
    });
  });

  it("shows the message that matched and opens the conversation", () => {
    const item = hitItem(
      hit({
        type: "message",
        id: THREAD,
        parentId: null,
        kind: "engagement",
        title: "Availability",
        detail: "I am open most weekends",
      }),
      t,
    );
    expect(item?.label).toBe("Availability: I am open most weekends");
    expect(item?.href).toBe(`/messages/${toDisplayKey("thread", THREAD)}`);
    expect(
      hitItem(
        hit({ type: "message", id: THREAD, parentId: null, title: "Availability", detail: null }),
        t,
      )?.label,
    ).toBe("Availability · Northwind Live");
  });

  it("names an engagement by its job title, or its role type when it has none", () => {
    const engagement = hit({ type: "engagement", id: ENGAGEMENT, parentId: null, kind: "Crew" });
    expect(hitItem({ ...engagement, title: "Rigger" }, t)?.label).toBe(
      "Rigger · Northwind Summer Series",
    );
    expect(hitItem({ ...engagement, title: null }, t)?.label).toBe(
      "Crew · Northwind Summer Series",
    );
  });

  it("drops a document it cannot place and groups the rest in the menu's order", () => {
    expect(hitItem(hit({ parentId: null }), t)).toBeNull();
    const groups = hitGroups(
      [
        hit({ type: "opportunity", id: THREAD, title: "Rigging Lead" }),
        hit({}),
        hit({ type: "message", id: THREAD, title: "Availability", detail: null }),
      ],
      t,
    );
    expect(groups.map((g) => [g.id, g.label, g.items.length])).toEqual([
      ["documents", "Documents", 1],
      ["messages", "Messages", 1],
      ["opportunities", "Opportunities", 1],
    ]);
  });
});

describe("actions", () => {
  it("finds a verb on a page the viewer can open", () => {
    expect(actionItems({ words: ["sign"], sitemap, nav: individual, t })).toEqual([
      { label: "Sign documents", icon: "FileCheck", href: "/documents" },
    ]);
  });

  it("leaves out an action whose page the viewer cannot open", () => {
    expect(actionItems({ words: ["timesheets"], sitemap, nav: individual, t })).toHaveLength(1);
    expect(actionItems({ words: ["timesheets"], sitemap, nav: unpaid, t })).toEqual([]);
  });
});

describe("settings", () => {
  it("reaches a personal setting in one search and opens its section at the field", () => {
    const items = settingItems({ words: ["time", "zone"], sitemap, nav: individual, t });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.href).toMatch(/^\/settings\/[a-z-]+#setting-[a-z0-9_-]+$/);
    expect(items[0]?.label).toMatch(/ · /);
  });

  it("finds nothing without words", () => {
    expect(settingItems({ words: [], sitemap, nav: individual, t })).toEqual([]);
  });
});
