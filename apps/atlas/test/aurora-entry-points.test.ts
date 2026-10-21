import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  draft,
  extractDocument,
  loadModelConfig,
  NeverSendList,
  summarize,
  suggestCatalogBinding,
  buildFilter,
  type AuroraContext,
  type AuroraStore,
  type ProposedChange,
} from "@xos/ai";
import type { ActivityEntry } from "@xos/data/activity";
import type { Invoice } from "@xos/data/finance";
import { AI_FEATURE_ORDER } from "@xos/data/ai";
import { describe, expect, it } from "vitest";
import {
  applyConditions,
  catalogForApi,
  describeCondition,
  fits,
  type AskCatalog,
} from "@/lib/aurora/ask";
import { AI_ENTRY_POINTS } from "@/lib/aurora/entry-points";
import { isOverdue } from "@/lib/aurora/finance-ask";
import { FIXTURE_DOCUMENTS } from "@/lib/aurora/fixture-entry";
import { FixtureModelClient } from "@/lib/aurora/fixture-model";
import { MAX_SUMMARY_ITEMS, weekOfActivity } from "@/lib/aurora/summary-items";
import { applySuggestions, suggestionIds, SUGGESTION_FIELD } from "@/lib/aurora/suggestions";

/**
 * The A95 Aurora entry points (finding A65-020): every AI Features switch names where it takes
 * effect, a plain-language filter only ever sets the page's own filters, overdue reads the org's
 * calendar, a week of activity is bounded, saved forms close their suggestions, and the fixture
 * model answers each entry point through the real feature code, silence rule included.
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("every AI Features switch takes effect somewhere (A65-001's guard for app.ai_settings)", () => {
  it("lists every feature", () => {
    expect(Object.keys(AI_ENTRY_POINTS).sort()).toEqual([...AI_FEATURE_ORDER].sort());
  });

  for (const feature of AI_FEATURE_ORDER) {
    it(`${feature} is read by its consumers and changed by their tests`, () => {
      const points = AI_ENTRY_POINTS[feature];
      expect(points.length, feature).toBeGreaterThan(0);
      for (const { consumer, test } of points) {
        const [file = "", symbol = ""] = consumer.split("#");
        expect(existsSync(join(repoRoot, file)), file).toBe(true);
        const source = read(file);
        expect(source.includes(`"${feature}"`), `${file} reads "${feature}"`).toBe(true);
        expect(source.includes(symbol), `${file} defines ${symbol}`).toBe(true);
        expect(existsSync(join(repoRoot, test)), test).toBe(true);
        expect(read(test).includes(feature), `${test} names ${feature}`).toBe(true);
      }
    });
  }
});

const invoices: AskCatalog = {
  collection: "invoices",
  label: "invoices",
  fields: [
    {
      name: "state",
      label: "State",
      type: "enum",
      values: [
        { value: "Issued", label: "Issued" },
        { value: "Approved", label: "Approved" },
      ],
      description: "The invoice's state.",
      op: "eq",
    },
    {
      name: "overdue",
      label: "Overdue",
      type: "boolean",
      values: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
      description: "Past due on the org's calendar.",
      op: "eq",
    },
    { name: "q", label: "Search", type: "string", description: "Number or party.", op: "contains" },
  ],
};

describe("plain-language filters over a page's own filters", () => {
  it("offers the model names, types, enum values, meanings and the one operator each takes", () => {
    expect(catalogForApi(invoices)).toEqual([
      {
        name: "state",
        type: "enum",
        values: ["Issued", "Approved"],
        description: "The invoice's state.",
        ops: ["eq"],
      },
      {
        name: "overdue",
        type: "boolean",
        description: "Past due on the org's calendar.",
        ops: ["eq"],
      },
      { name: "q", type: "string", description: "Number or party.", ops: ["contains"] },
    ]);
  });

  it("applies only conditions that fit, replacing the page's filters and keeping the view", () => {
    const current = new URLSearchParams("view=table&sort=-due&state=Approved&peek=abc&create=1");
    const { query, skipped } = applyConditions(invoices, current, [
      { field: "overdue", op: "eq", value: "true" },
      { field: "q", op: "contains", value: " Acme " },
      { field: "state", op: "eq", value: "Lost" },
      { field: "q", op: "contains", value: "Again" },
      { field: "total", op: "gt", value: "5" },
    ]);
    expect(new URLSearchParams(query)).toEqual(
      new URLSearchParams("view=table&sort=-due&overdue=true&q=Acme"),
    );
    expect(skipped.map((c) => c.field)).toEqual(["state", "q", "total"]);
    expect(fits(invoices, { field: "overdue", op: "contains", value: "true" })).toBe(false);
    expect(fits(invoices, { field: "q", op: "contains", value: "" })).toBe(false);
  });

  it("describes conditions with the person's labels", () => {
    expect(describeCondition(invoices, { field: "overdue", op: "eq", value: "true" })).toBe(
      "Overdue: Yes",
    );
    expect(describeCondition(invoices, { field: "nope", op: "eq", value: "x" })).toBe("nope: x");
  });
});

describe("overdue on the org's calendar", () => {
  const invoice = (over: Partial<Invoice>): Invoice =>
    ({
      state: "Issued",
      dueOn: "2026-10-20",
      totalMinor: 1000,
      appliedMinor: 0,
      ...over,
    }) as Invoice;

  it("counts an unpaid Issued, Approved or Disputed invoice due before today there", () => {
    // 20 October in New York, though UTC is already 21 October at 22:30 there.
    expect(isOverdue(invoice({}), "2026-10-21")).toBe(true);
    expect(isOverdue(invoice({}), "2026-10-20")).toBe(false);
    expect(isOverdue(invoice({ state: "Approved", totalMinor: null }), "2026-10-21")).toBe(true);
    expect(isOverdue(invoice({ state: "Canceled" }), "2026-10-21")).toBe(false);
    expect(isOverdue(invoice({ state: "Proposed" }), "2026-10-21")).toBe(false);
    expect(isOverdue(invoice({ appliedMinor: 1000 }), "2026-10-21")).toBe(false);
    expect(isOverdue(invoice({ dueOn: null }), "2026-10-21")).toBe(false);
  });
});

describe("a project's week of activity", () => {
  const entry = (id: string, at: string) => ({ id, at }) as ActivityEntry;

  it("pages back to the week's first instant and stops there", async () => {
    const pages: Record<string, { entries: ActivityEntry[]; next: string | null }> = {
      first: {
        entries: [entry("a", "2026-10-21T12:00:00Z"), entry("b", "2026-10-18T09:00:00Z")],
        next: "2026-10-18T09:00:00Z",
      },
      "2026-10-18T09:00:00Z": {
        entries: [entry("c", "2026-10-15T04:00:01Z"), entry("d", "2026-10-15T03:59:59Z")],
        next: "x",
      },
    };
    const seen: (string | null)[] = [];
    const week = await weekOfActivity(async (before) => {
      seen.push(before);
      return pages[before ?? "first"] ?? { entries: [], next: null };
    }, "2026-10-15T04:00:00.000Z");
    expect(week).toEqual({
      entries: [
        pages["first"]?.entries[0],
        pages["first"]?.entries[1],
        pages["2026-10-18T09:00:00Z"]?.entries[0],
      ],
      truncated: false,
    });
    expect(seen).toEqual([null, "2026-10-18T09:00:00Z"]);
  });

  it("keeps at most one summary's worth and says so", async () => {
    const many = Array.from({ length: MAX_SUMMARY_ITEMS + 5 }, (_, i) =>
      entry(`e${i}`, "2026-10-20T12:00:00Z"),
    );
    const week = await weekOfActivity(async () => ({ entries: many, next: null }), "2026-10-14");
    expect(week.entries).toHaveLength(MAX_SUMMARY_ITEMS);
    expect(week.truncated).toBe(true);
    const ended = await weekOfActivity(async () => ({ entries: [], next: null }), "2026-10-14");
    expect(ended).toEqual({ entries: [], truncated: false });
  });
});

describe("saving a form Aurora filled closes its suggestions", () => {
  const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;

  it("reads only well-formed ids, each once", () => {
    const form = new FormData();
    for (const v of [id(1), id(1), "not-an-id", id(2)]) form.append(SUGGESTION_FIELD, v);
    expect(suggestionIds(form)).toEqual([id(1), id(2)]);
  });

  it("confirms then applies each with the record written, and counts what stays open", async () => {
    const calls: Record<string, unknown>[] = [];
    const db = {
      rpc: async (_name: string, args: Record<string, unknown>) => {
        calls.push(args);
        return args["p_suggestion_id"] === id(2) && args["p_next"] === "Applied"
          ? { data: null, error: { code: "XR001", message: "expired: Too late.", hint: "expired" } }
          : { data: null, error: null };
      },
    } as never;
    expect(await applySuggestions(db, [id(1), id(2)], id(9), "Saved.")).toBe(1);
    expect(calls).toEqual([
      { p_suggestion_id: id(1), p_expected: "Proposed", p_next: "Confirmed", p_reason: "Saved." },
      {
        p_suggestion_id: id(1),
        p_expected: "Confirmed",
        p_next: "Applied",
        p_reason: "Saved.",
        p_applied_id: id(9),
      },
      { p_suggestion_id: id(2), p_expected: "Proposed", p_next: "Confirmed", p_reason: "Saved." },
      {
        p_suggestion_id: id(2),
        p_expected: "Confirmed",
        p_next: "Applied",
        p_reason: "Saved.",
        p_applied_id: id(9),
      },
    ]);
  });
});

/** The real feature code over the fixture model, with an in-memory store. */
function fixtureContext(): { ctx: AuroraContext; proposals: ProposedChange[] } {
  const proposals: ProposedChange[] = [];
  const store: AuroraStore = {
    begin: async () => ({ ok: true, data: "request-1" }),
    complete: async () => ({ ok: true, data: null }),
    propose: async (_id, change) => {
      proposals.push(change);
      return { ok: true, data: `suggestion-${proposals.length}` };
    },
  };
  return {
    ctx: {
      orgId: "org-1",
      client: new FixtureModelClient(),
      store,
      config: loadModelConfig({}),
      today: "2026-10-20",
    },
    proposals,
  };
}

const neverSend = new NeverSendList([]);

describe("the fixture model answers each entry point and keeps the silence rule", () => {
  it("filters by the recorded words and refuses anything else", async () => {
    const { ctx } = fixtureContext();
    const catalog = [{ collection: "invoices", fields: catalogForApi(invoices) }];
    expect(
      await buildFilter(ctx, { sentence: "overdue invoices from Acme", catalog, timeZone: "UTC" }),
    ).toMatchObject({
      kind: "answer",
      value: {
        conditions: [
          { field: "overdue", op: "eq", value: "true" },
          { field: "q", op: "contains", value: "Acme" },
        ],
      },
    });
    expect(
      await buildFilter(ctx, { sentence: "invoices on rainy days", catalog, timeZone: "UTC" }),
    ).toMatchObject({ kind: "no-answer" });
  });

  it("drafts from the instructions and leaves a price as a gap", async () => {
    const { ctx } = fixtureContext();
    const result = await draft(ctx, {
      kind: "change_order_description",
      instructions: "Four more rigging points at the agreed price",
      context: [{ table: "app.budgets", id: "b1", data: { title: "Main Stage Budget" } }],
      verbiage: [],
      neverSend,
      subject: null,
    });
    expect(result).toMatchObject({
      kind: "answer",
      value: { gaps: ["the agreed price"], title: "Four more rigging points at the agreed price" },
    });
    expect(result.kind === "answer" ? result.value.body : "").toContain("Main Stage Budget");
  });

  it("summarizes with every point citing an item, and counts gate readiness", async () => {
    const { ctx } = fixtureContext();
    expect(
      await summarize(ctx, {
        kind: "record_activity",
        subject: { table: "app.records", id: "r1" },
        items: [{ id: "r1", table: "app.records", data: { title: "Fire marshal walk" } }],
        neverSend,
      }),
    ).toMatchObject({
      kind: "answer",
      value: { bullets: [{ text: "Fire marshal walk.", citations: ["r1"] }] },
    });
    expect(
      await summarize(ctx, {
        kind: "gate_readiness",
        subject: { table: "app.projects", id: "p1" },
        items: [
          {
            id: "p1",
            table: "app.gate_criteria_status",
            data: {
              gate_readiness: [
                { criterion_id: "G2.BUDGET", blocking: true, satisfied: false },
                { criterion_id: "G2.VENUE", blocking: true, satisfied: true },
              ],
            },
          },
        ],
        neverSend,
      }),
    ).toMatchObject({
      kind: "answer",
      value: {
        headline: "1 of 2 criteria have evidence",
        bullets: [{ text: "Blocking without evidence: G2.BUDGET.", citations: ["p1"] }],
      },
    });
  });

  it("binds a code to the candidate the label names, or answers NO ANSWER", async () => {
    const { ctx, proposals } = fixtureContext();
    const candidates = [
      { elementId: "E-1", name: "LED Wall Panel", urid: "9000.02.03" },
      { elementId: "E-2", name: "Steel Deck Platform", urid: "5000.01.02" },
    ];
    expect(
      await suggestCatalogBinding(ctx, {
        code: "0012345678905",
        description: "LED PANEL 500MM",
        candidates,
      }),
    ).toMatchObject({ kind: "answer", value: { elementId: "E-1" } });
    expect(proposals[0]?.fields).toEqual([
      expect.objectContaining({ field_path: "element_id", value: "E-1" }),
      expect.objectContaining({ field_path: "name", value: "LED Wall Panel" }),
    ]);
    expect(
      await suggestCatalogBinding(ctx, { code: "1", description: "mystery box", candidates }),
    ).toMatchObject({ kind: "no-answer" });
  });

  it("reads the recorded invoice, receipt and quote, and leaves an unprinted price empty", async () => {
    const documents: Record<string, string> = {
      invoice: [
        "INVOICE",
        "Bluewater Audio Rentals",
        FIXTURE_DOCUMENTS["invoice"]?.marker ?? "",
        "Invoice date: 2026-09-02",
        "Payment due: 2026-10-02",
        "Total due: USD 18,450.00",
      ].join("\n"),
      receipt: [
        "HARBOR HARDWARE",
        "10/03/2026 14:22",
        "Gaffer tape 2in black x6",
        "TOTAL USD 89.94",
      ].join("\n"),
      quote: [
        "QUOTE Q-5521 from Lumen Video Systems",
        "Valid until 2026-12-31",
        "1. LED Wall Panel 500mm, Qty 48, $125.00 each",
        "2. Video processor, Qty 2",
        "All prices USD.",
      ].join("\n"),
    };
    for (const kind of ["invoice", "receipt", "quote"] as const) {
      const { ctx, proposals } = fixtureContext();
      const result = await extractDocument(ctx, {
        kind,
        document: { type: "document", mediaType: "text/plain", data: documents[kind] ?? "" },
        fileName: `${kind}.txt`,
        subject: null,
      });
      expect(result.kind, kind).toBe("answer");
      const header = proposals[0]?.fields ?? [];
      expect(
        header.every((f) => f.refusal === undefined),
        kind,
      ).toBe(true);
      if (kind === "quote") {
        expect(proposals.map((p) => p.operationId)).toEqual([
          "rfqResponses.create",
          "rfqResponseLines.create",
          "rfqResponseLines.create",
        ]);
        expect(proposals[2]?.fields.find((f) => f.field_path === "unit_price_minor")).toMatchObject(
          {
            refusal: "NO_ANSWER",
          },
        );
      }
    }
    const { ctx } = fixtureContext();
    expect(
      await extractDocument(ctx, {
        kind: "invoice",
        document: { type: "document", mediaType: "text/plain", data: "Some other paper" },
        fileName: "other.txt",
        subject: null,
      }),
    ).toMatchObject({ kind: "no-answer" });
  });
});
