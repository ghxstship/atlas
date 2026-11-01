import { describe, expect, it } from "vitest";
import {
  hasSearchCriteria,
  isPlainSearch,
  normalizeState,
  parseSearchDay,
  parseSearchQuery,
  resolveSearchDay,
  searchRequest,
  semanticText,
  shiftSearchDay,
} from "../src/search-query.ts";

/** A87 (RRR-132, finding A65-005): the global search operator grammar. */

describe("parseSearchQuery: words, phrases and negation", () => {
  it("keeps plain words as terms", () => {
    const q = parseSearchQuery("  load   in ");
    expect(q.terms).toEqual(["load", "in"]);
    expect(q.phrases).toEqual([]);
    expect(isPlainSearch(q)).toBe(true);
    expect(hasSearchCriteria(q)).toBe(true);
  });

  it("reads quoted phrases, including curly quotes and an unclosed quote", () => {
    expect(parseSearchQuery('"load in" truss').phrases).toEqual(["load in"]);
    expect(parseSearchQuery("“stage  left”").phrases).toEqual(["stage left"]);
    const open = parseSearchQuery('rigging "north   dock');
    expect(open.terms).toEqual(["rigging"]);
    expect(open.phrases).toEqual(["north dock"]);
  });

  it("negates words and phrases with a leading minus, and ignores a lone minus", () => {
    const q = parseSearchQuery('truss -ground -"load out" - ');
    expect(q.terms).toEqual(["truss"]);
    expect(q.excludeTerms).toEqual(["ground"]);
    expect(q.excludePhrases).toEqual(["load out"]);
    expect(isPlainSearch(q)).toBe(false);
  });

  it("leaves words with a colon that are not operators as text", () => {
    const q = parseSearchQuery("call 10:30 https://example.org foo:bar");
    expect(q.terms).toEqual(["call", "10:30", "https://example.org", "foo:bar"]);
    expect(q.tokens.every((t) => t.kind === "term")).toBe(true);
  });

  it("drops duplicates and caps terms, phrases and values", () => {
    const q = parseSearchQuery(
      `a a b c d e f g h i j k l m n "p1" "p2" "p3" "p4" "p5" status:${Array.from({ length: 12 }, (_, i) => `s${i}`).join(",")}`,
    );
    expect(q.terms).toHaveLength(12);
    expect(q.terms.filter((t) => t === "a")).toHaveLength(1);
    expect(q.phrases).toHaveLength(4);
    expect(q.statuses).toHaveLength(8);
  });

  it("reads at most 200 characters", () => {
    const q = parseSearchQuery(`${"x".repeat(199)} overflow`);
    // The word past 200 characters is cut, and one word is at most 100 characters.
    expect(q.terms).toEqual(["x".repeat(100)]);
  });

  it("finds nothing to search in an empty query or a lone empty operator", () => {
    expect(hasSearchCriteria(parseSearchQuery(""))).toBe(false);
    const q = parseSearchQuery("type:");
    expect(q.tokens).toEqual([
      { kind: "filter", operator: "type", typed: "type", value: "", negated: false, valid: false },
    ]);
    expect(hasSearchCriteria(q)).toBe(false);
  });
});

describe("parseSearchQuery: operators", () => {
  it("maps type values to result types and record kinds, with aliases", () => {
    const q = parseSearchQuery(
      "type:people kind:Task,permit tipo:documento -type:incident -kind:risk",
    );
    expect(q.types).toEqual(["person", "document"]);
    expect(q.kinds).toEqual(["task", "permit"]);
    expect(q.excludeTypes).toEqual(["incident"]);
    expect(q.excludeKinds).toEqual(["risk"]);
    expect(q.tokens[1]).toEqual({
      kind: "filter",
      operator: "type",
      typed: "kind",
      value: "Task,permit",
      negated: false,
      valid: true,
    });
  });

  it("reads quoted operator values as one value", () => {
    const q = parseSearchQuery('project:"North Stage" assignee:"Ana Ruiz" catering');
    expect(q.projects).toEqual(["North Stage"]);
    expect(q.assignees).toEqual(["Ana Ruiz"]);
    expect(q.terms).toEqual(["catering"]);
  });

  it("reads assignee me in English and Spanish, and negated assignees", () => {
    expect(parseSearchQuery("assignee:me").assignees).toEqual(["me"]);
    expect(parseSearchQuery("owner:@me").assignees).toEqual(["me"]);
    expect(parseSearchQuery("asignado:yo").assignees).toEqual(["me"]);
    expect(parseSearchQuery("-assignee:@ana").excludeAssignees).toEqual(["ana"]);
  });

  it("normalizes states and maps open and closed", () => {
    const q = parseSearchQuery("status:In-Review,blocked state:open -status:done");
    expect(q.statuses).toEqual(["inreview", "blocked", "open"]);
    expect(q.excludeStatuses).toEqual(["closed"]);
    expect(normalizeState("In Review")).toBe("inreview");
    expect(normalizeState("in_review")).toBe("inreview");
  });

  it("collects phase, urid and dept, and refuses their negation", () => {
    const q = parseSearchQuery("phase:ADV urid:5000.01 dept:audio -phase:SCP");
    expect(q.phases).toEqual(["ADV"]);
    expect(q.urids).toEqual(["5000.01"]);
    expect(q.depts).toEqual(["audio"]);
    expect(q.tokens.at(-1)).toMatchObject({ operator: "phase", negated: true, valid: false });
  });

  it("reads is: values, flips negated open and closed, and flags the rest", () => {
    const q = parseSearchQuery("is:blocked is:mine,overdue -is:open is:everything -is:mine");
    expect(q.is).toEqual(["blocked", "mine", "overdue", "closed"]);
    expect(q.tokens[3]).toMatchObject({ operator: "is", valid: false });
    expect(q.tokens[4]).toMatchObject({ operator: "is", negated: true, valid: false });
  });

  it("reads is:archived, in English or Spanish, for the archived records and documents (A124)", () => {
    expect(parseSearchQuery("truss is:archived").is).toEqual(["archived"]);
    expect(parseSearchQuery("es:archivado").is).toEqual(["archived"]);
  });

  it("accepts Spanish operator names", () => {
    const q = parseSearchQuery(
      "estado:bloqueado proyecto:NWS antes:hoy después:ayer fase:ADV es:abierto",
    );
    expect(q.statuses).toEqual(["bloqueado"]);
    expect(q.projects).toEqual(["NWS"]);
    expect(q.before).toBe("0");
    expect(q.after).toBe("-1");
    expect(q.is).toEqual(["open"]);
  });

  it("is case-insensitive about operator names", () => {
    expect(parseSearchQuery("TYPE:task").kinds).toEqual(["task"]);
    expect(parseSearchQuery("Status:Blocked").statuses).toEqual(["blocked"]);
  });
});

describe("parseSearchQuery: dates", () => {
  it("reads calendar dates, words and day or week counts for before and after", () => {
    expect(parseSearchQuery("before:2026-10-01").before).toBe("2026-10-01");
    expect(parseSearchQuery("after:today").after).toBe("0");
    expect(parseSearchQuery("after:yesterday").after).toBe("-1");
    expect(parseSearchQuery("before:tomorrow").before).toBe("1");
    expect(parseSearchQuery("after:-7d").after).toBe("-7");
    expect(parseSearchQuery("after:7d").after).toBe("-7");
    expect(parseSearchQuery("before:+2w").before).toBe("14");
  });

  it("flags impossible dates, lists and negated dates", () => {
    for (const text of [
      "before:2026-02-30",
      "after:someday",
      "before:1,2",
      "-after:today",
      "after:9999d",
    ]) {
      const q = parseSearchQuery(text);
      expect(q.before ?? q.after).toBeNull();
      expect(q.tokens[0]).toMatchObject({ kind: "filter", valid: false });
    }
  });

  it("turns due values into day bounds that look ahead", () => {
    expect(parseSearchQuery("due:<7d")).toMatchObject({ dueBefore: "7", dueAfter: null });
    expect(parseSearchQuery("due:<=7d")).toMatchObject({ dueBefore: "8", dueAfter: null });
    expect(parseSearchQuery("due:>2026-11-01")).toMatchObject({
      dueAfter: "2026-11-01",
      dueBefore: null,
    });
    expect(parseSearchQuery("due:>=2026-11-01")).toMatchObject({ dueAfter: "2026-10-31" });
    expect(parseSearchQuery("due:today")).toMatchObject({ dueAfter: "-1", dueBefore: "1" });
    expect(parseSearchQuery("due:2026-12-31")).toMatchObject({
      dueAfter: "2026-12-30",
      dueBefore: "2027-01-01",
    });
    const overdue = parseSearchQuery("due:overdue");
    expect(overdue).toMatchObject({ dueBefore: "0", dueAfter: null });
    expect(overdue.is).toEqual(["open"]);
    expect(parseSearchQuery("due:<later").tokens[0]).toMatchObject({ valid: false });
    expect(parseSearchQuery("due:soon").tokens[0]).toMatchObject({ valid: false });
  });

  it("parses, shifts and resolves day bounds", () => {
    expect(parseSearchDay("2026-10-21", -1)).toBe("2026-10-21");
    expect(parseSearchDay("3", -1)).toBeNull();
    expect(parseSearchDay("3d", 1)).toBe("3");
    expect(parseSearchDay("mañana", -1)).toBe("1");
    expect(shiftSearchDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftSearchDay("-7", 1)).toBe("-6");
    expect(resolveSearchDay("-1", "2026-03-01")).toBe("2026-02-28");
    expect(resolveSearchDay("2026-10-21", "2026-03-01")).toBe("2026-10-21");
  });
});

describe("searchRequest and semanticText", () => {
  it("builds the RPC body with resolved kinds", () => {
    const q = parseSearchQuery('"load in" -truss type:tarea due:<7d is:mine project:NWS');
    const request = searchRequest(q, { kinds: ["Task"] });
    expect(request).toEqual({
      terms: [],
      phrases: ["load in"],
      exclude_terms: ["truss"],
      exclude_phrases: [],
      types: [],
      exclude_types: [],
      kinds: ["Task"],
      exclude_kinds: [],
      projects: ["NWS"],
      exclude_projects: [],
      assignees: [],
      exclude_assignees: [],
      statuses: [],
      exclude_statuses: [],
      phases: [],
      urids: [],
      depts: [],
      is: ["mine"],
      after: null,
      before: null,
      due_after: null,
      due_before: "7",
    });
    expect(searchRequest(q).kinds).toEqual(["tarea"]);
    expect(semanticText(q)).toBe("load in");
    expect(semanticText(parseSearchQuery("crowd safety status:open"))).toBe("crowd safety");
  });
});
