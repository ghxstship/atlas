import { describe, expect, it } from "vitest";
import {
  actionDocs,
  closeness,
  COMPASS_SEARCH_ACTIONS,
  foldText,
  groupHits,
  relevance,
  searchLocal,
  words,
  type LocalSearchDoc,
} from "../src/domain/search";

/**
 * Compass Today search (A126, RRR-171, Section 11.10 item 1): ranks what the device holds, offline, as the
 * command menus rank the server's results (ADR 0043): a full code first, title words above body words,
 * then closeness to now.
 */

const now = Date.UTC(2026, 9, 27, 12, 0, 0);
const day = 86_400_000;
const at = (days: number) => new Date(now + days * day).toISOString();

const docs: LocalSearchDoc[] = [
  {
    kind: "shift",
    id: "s-today",
    title: "Rigger",
    body: "Northwind Pier",
    at: at(0),
    href: "/schedule",
  },
  {
    kind: "shift",
    id: "s-old",
    title: "Rigger",
    body: "Northwind Pier",
    at: at(-60),
    href: "/schedule",
  },
  {
    kind: "shift",
    id: "s-next",
    title: "Rigger",
    body: "Northwind Pier",
    at: at(2),
    href: "/schedule",
  },
  {
    kind: "reference",
    id: "sop",
    title: "Working at Height",
    body: "Wear a harness whenever you climb the rigging.",
    code: "SOP-101",
    href: "/reference/sops",
  },
  {
    kind: "reference",
    id: "ch4",
    title: "Rigging crew",
    code: "4",
    href: "/reference/radio-channels",
  },
  {
    kind: "record",
    id: "inc",
    title: "Truss failure at stage left",
    code: "12",
    at: at(-1),
    href: "/incidents",
  },
  { kind: "person", id: "p1", title: "Inés Marchetti", href: "/crew" },
  { kind: "task", id: "t1", title: "Upload your rigging certificate", href: "/onboarding" },
];

const ids = (input: string, perKind?: number) =>
  searchLocal(docs, input, { now, ...(perKind ? { perKind } : {}) }).map((h) => h.id);

describe("text", () => {
  it("folds case and accents and splits on anything but letters and digits", () => {
    expect(foldText("Inspección")).toBe("inspeccion");
    expect(words("SOP-101: Working at Height")).toEqual(["sop", "101", "working", "at", "height"]);
  });
});

describe("closeness", () => {
  it("is 1 now and when undated, and decays toward 0.7 either side of now", () => {
    expect(closeness(at(0), now)).toBe(1);
    expect(closeness(null, now)).toBe(1);
    expect(closeness("not a date", now)).toBe(1);
    expect(closeness(at(45), now)).toBeCloseTo(closeness(at(-45), now));
    expect(closeness(at(45), now)).toBeCloseTo(0.7 + 0.3 / Math.E);
    expect(closeness(at(400), now)).toBeGreaterThan(0.7);
  });
});

describe("relevance", () => {
  const q = (terms: string[], extra: Partial<Parameters<typeof relevance>[1]> = {}) => ({
    terms,
    phrases: [],
    excludeTerms: [],
    excludePhrases: [],
    ...extra,
  });
  const sop = docs[3] as LocalSearchDoc;

  it("ranks a title word above a body word, and a whole word above a prefix", () => {
    const title = relevance(sop, q(["height"])) ?? 0;
    const prefix = relevance(sop, q(["heig"])) ?? 0;
    const body = relevance(sop, q(["harness"])) ?? 0;
    expect(title).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(body);
    expect(body).toBeGreaterThan(0);
  });

  it("needs every word and phrase, and drops what an exclusion names", () => {
    expect(relevance(sop, q(["height", "ladder"]))).toBeNull();
    expect(relevance(sop, q([], { phrases: ["climb the rigging"] }))).toBeGreaterThan(0);
    expect(relevance(sop, q([], { phrases: ["rigging the climb"] }))).toBeNull();
    expect(relevance(sop, q(["height"], { excludeTerms: ["harness"] }))).toBeNull();
    expect(relevance(sop, q(["height"], { excludePhrases: ["wear a harness"] }))).toBeNull();
    expect(relevance(sop, q([]))).toBeNull();
  });

  it("ranks a code typed in full first", () => {
    expect(relevance(sop, q(["SOP-101"]))).toBe(1.5);
    expect(relevance(sop, q(["sop"]))).toBeLessThan(1);
  });

  it("counts a phrase in the title above one in the body", () => {
    const inTitle = relevance(sop, q([], { phrases: ["working at height"] })) ?? 0;
    const inBody = relevance(sop, q([], { phrases: ["wear a harness"] })) ?? 0;
    expect(inTitle).toBeGreaterThan(inBody);
  });
});

describe("searchLocal", () => {
  it("finds a shift by its role, today's first, then the next, the old one last", () => {
    expect(ids("rigger")).toEqual(["s-today", "s-next", "s-old"]);
  });

  it("finds shifts by a typed prefix and by their place", () => {
    const rig = ids("rig");
    expect(rig[0]).toBe("s-today");
    expect(rig.filter((id) => id.startsWith("s-"))).toEqual(["s-today", "s-next", "s-old"]);
    expect(ids("pier")).toEqual(["s-today", "s-next", "s-old"]);
  });

  it("puts a full code first: an incident number, a radio channel, an SOP", () => {
    expect(ids("12")[0]).toBe("inc");
    expect(ids("4")[0]).toBe("ch4");
    expect(ids("SOP-101")[0]).toBe("sop");
  });

  it("matches without accents and keeps to a few results of each kind", () => {
    expect(ids("ines")).toEqual(["p1"]);
    expect(ids("rigger", 2)).toEqual(["s-today", "s-next"]);
  });

  it("finds nothing for an empty query or one with only exclusions", () => {
    expect(ids("")).toEqual([]);
    expect(ids("-rigger")).toEqual([]);
  });

  it("orders equal scores by title", () => {
    const tie: LocalSearchDoc[] = [
      { kind: "action", id: "b", title: "Open settings", href: "/settings" },
      { kind: "action", id: "a", title: "Open inbox", href: "/inbox" },
    ];
    expect(searchLocal(tie, "open", { now }).map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("groups and actions", () => {
  it("groups hits in Today's order", () => {
    const groups = groupHits(searchLocal(docs, "rigging", { now }));
    expect(groups.map((g) => g.kind)).toEqual(["task", "reference"]);
  });

  it("offers an action only with its feature", () => {
    const label = (key: string) => `label:${key}`;
    const none = actionDocs(() => false, label);
    const all = actionDocs(() => true, label);
    expect(all).toHaveLength(COMPASS_SEARCH_ACTIONS.length);
    expect(none.map((d) => d.id)).not.toContain("reportIncident");
    expect(none.map((d) => d.id)).toContain("openSchedule");
    expect(all.find((d) => d.id === "reportIncident")).toEqual({
      kind: "action",
      id: "reportIncident",
      title: "label:reportIncident",
      href: "/incidents/new",
    });
  });
});
