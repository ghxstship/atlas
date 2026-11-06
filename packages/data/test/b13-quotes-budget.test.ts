import { describe, expect, it } from "vitest";
import { compareBudgetLines, liveCompareLine, type CompareLine } from "../src/budget-versions.ts";
import { clientUnitPrice, mergeSavedLine, type BudgetLine } from "../src/finance.ts";
import { getQuote, quoteLinkWindow, signingLinkHours } from "../src/quotes.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/**
 * B13 (RRR-237): client price arithmetic, compare, and the signing link's lifetime. The price table is
 * the one supabase/tests/3020_budget_client_pricing.test.sql checks against private.client_unit_price_minor,
 * so TypeScript and SQL agree on rounding.
 */

describe("clientUnitPrice", () => {
  // [unit price, markup bp, expected], shared with pgTAP 3020.
  const CASES: readonly (readonly [number | null, number | null, number | null])[] = [
    [10000, 2500, 12500],
    [10000, 0, 10000],
    [333, 1000, 366],
    [5, 5000, 8],
    [1, 2500, 1],
    [3, 5000, 5],
    [null, 2500, null],
    [10000, null, null],
  ];
  it.each(CASES)("%s marked up %s bp is %s, half away from zero", (unit, bp, want) => {
    expect(clientUnitPrice(unit, bp)).toBe(want);
  });
});

const line = (over: Partial<CompareLine> & { budgetLineId: string }): CompareLine => ({
  lineNumber: 1,
  description: "Stage deck",
  lineType: "Cost",
  urid: "5000.04.02",
  quantity: 2,
  unitBasis: null,
  unitPriceMinor: 1000,
  effectiveMarkupBp: 2500,
  clientUnitPriceMinor: 1250,
  excludedFromQuote: false,
  ...over,
});

describe("compareBudgetLines", () => {
  it("lists added, removed, changed and unchanged lines by id, with field changes", () => {
    const result = compareBudgetLines(
      [
        line({ budgetLineId: "same" }),
        line({ budgetLineId: "gone", lineNumber: 2 }),
        line({ budgetLineId: "edit", lineNumber: 3 }),
      ],
      [
        line({ budgetLineId: "same" }),
        line({
          budgetLineId: "edit",
          lineNumber: 3,
          quantity: 3,
          effectiveMarkupBp: 5000,
          clientUnitPriceMinor: 1500,
        }),
        line({ budgetLineId: "new", lineNumber: 4 }),
      ],
    );
    const by = new Map(result.lines.map((l) => [l.budgetLineId, l]));
    expect(by.get("same")?.status).toBe("unchanged");
    expect(by.get("gone")?.status).toBe("removed");
    expect(by.get("new")?.status).toBe("added");
    expect(by.get("edit")?.status).toBe("changed");
    expect(by.get("edit")?.changed).toEqual(["quantity", "markup", "clientPrice"]);
    expect(by.get("edit")?.costDeltaMinor).toBe(1000);
    expect(by.get("edit")?.clientDeltaMinor).toBe(4500 - 2500);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.changed).toBe(1);
  });

  it("gives the total delta as live total minus snapshot total", () => {
    const result = compareBudgetLines(
      [line({ budgetLineId: "a" }), line({ budgetLineId: "b", lineNumber: 2, quantity: 1 })],
      [line({ budgetLineId: "a", quantity: 5 })],
    );
    expect(result.costDeltaMinor).toBe(5 * 1000 - (2 * 1000 + 1000));
  });

  it("blanks a delta and the total when either side is unpriced, never reading it as zero", () => {
    const result = compareBudgetLines(
      [line({ budgetLineId: "a", unitPriceMinor: null, clientUnitPriceMinor: null })],
      [line({ budgetLineId: "a" })],
    );
    expect(result.lines[0]?.costDeltaMinor).toBeNull();
    expect(result.costDeltaMinor).toBeNull();
    expect(result.clientDeltaMinor).toBeNull();
  });

  it("leaves a line excluded from the quote out of the client figures, priced or not", () => {
    const off = { excludedFromQuote: true };
    const result = compareBudgetLines(
      [
        line({ budgetLineId: "kept" }),
        line({ budgetLineId: "off", lineNumber: 2, ...off }),
        line({ budgetLineId: "blank", lineNumber: 3, clientUnitPriceMinor: null, ...off }),
      ],
      [
        line({ budgetLineId: "kept" }),
        line({ budgetLineId: "off", lineNumber: 2, quantity: 9, ...off }),
        line({ budgetLineId: "blank", lineNumber: 3, clientUnitPriceMinor: null, ...off }),
      ],
    );
    const by = new Map(result.lines.map((l) => [l.budgetLineId, l]));
    expect(by.get("off")?.clientBeforeMinor).toBe(0);
    expect(by.get("off")?.clientDeltaMinor).toBe(0);
    expect(by.get("off")?.costDeltaMinor).toBe(7000);
    expect(result.clientDeltaMinor).toBe(0);
  });

  it("names a line moved on or off the quote as a change, with the client delta it causes", () => {
    const result = compareBudgetLines(
      [line({ budgetLineId: "a" })],
      [line({ budgetLineId: "a", excludedFromQuote: true })],
    );
    expect(result.lines[0]?.status).toBe("changed");
    expect(result.lines[0]?.changed).toEqual(["onQuote"]);
    expect(result.clientDeltaMinor).toBe(-2500);
  });

  it("orders lines by number", () => {
    const result = compareBudgetLines(
      [line({ budgetLineId: "z", lineNumber: 9 })],
      [line({ budgetLineId: "a", lineNumber: 1 })],
    );
    expect(result.lines.map((l) => l.lineNumber)).toEqual([1, 9]);
  });
});

const budgetLine = (over: Partial<BudgetLine> = {}): BudgetLine => ({
  id: "l1",
  budgetId: "b1",
  lineNumber: 1,
  description: "Stage deck",
  lineType: "Cost",
  urid: "5000.04.02",
  costCenterId: null,
  gradeCode: null,
  elementId: null,
  quantity: 2,
  unitBasis: null,
  unitPriceMinor: 1000,
  xyz: "X",
  xyzBasis: "Declared",
  extendedMinor: 2000,
  accountCode: "5400",
  actualMinor: 300,
  drawnInMinor: 0,
  drawnOutMinor: 0,
  committedMinor: null,
  committedWithheld: false,
  poLineCount: 0,
  otherCurrencyPoLineCount: 0,
  markupBp: null,
  clientUnitPriceMinor: null,
  excludedFromQuote: false,
  etcMinor: null,
  effectiveMarkupBp: 2500,
  effectiveClientUnitPriceMinor: 1250,
  clientExtendedMinor: 2500,
  marginMinor: 500,
  currentBudgetMinor: 2000,
  remainingCommitmentMinor: 0,
  forecastEtcMinor: 1700,
  etcSource: "Derived",
  efcMinor: 2000,
  forwardExposureMinor: 1700,
  varianceAtCompletionMinor: 0,
  forecastWithheld: false,
  laborActualMinor: 0,
  laborUnpricedMinutes: 0,
  laborOtherCurrencyCount: 0,
  updatedAt: "2026-11-01T00:00:00Z",
  ...over,
});

describe("live lines", () => {
  it("compares a live line by its client price in force", () => {
    const shown = liveCompareLine(budgetLine());
    expect(shown.clientUnitPriceMinor).toBe(1250);
    expect(shown.effectiveMarkupBp).toBe(2500);
  });

  it("merges a saved line's new fields so a live merge and the conflict dialog cover them", () => {
    const merged = mergeSavedLine(
      budgetLine(),
      budgetLine({
        markupBp: 1000,
        clientUnitPriceMinor: 1500,
        excludedFromQuote: true,
        etcMinor: 42,
        actualMinor: 0,
        updatedAt: "2026-11-02T00:00:00Z",
      }),
    );
    expect(merged.markupBp).toBe(1000);
    expect(merged.clientUnitPriceMinor).toBe(1500);
    expect(merged.excludedFromQuote).toBe(true);
    expect(merged.etcMinor).toBe(42);
    expect(merged.updatedAt).toBe("2026-11-02T00:00:00Z");
    // Derived amounts are kept until the page rereads them.
    expect(merged.actualMinor).toBe(300);
  });
});

describe("signingLinkHours", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  it("is at most 14 days", () => {
    expect(signingLinkHours("2027-06-01", "UTC", now)).toBe(14 * 24);
  });
  it("stops at the end of valid until in the project's zone", () => {
    // The end of Nov 7 in New York (UTC-5) is 04:59 UTC on Nov 8: 40 whole hours away.
    expect(signingLinkHours("2026-11-07", "America/New_York", now)).toBe(40);
    expect(signingLinkHours("2026-11-07", "UTC", now)).toBe(35);
  });
  it("is below one hour when valid until is about to end", () => {
    expect(signingLinkHours("2026-11-06", "UTC", new Date("2026-11-06T23:30:00Z"))).toBeLessThan(1);
    expect(signingLinkHours("2026-11-05", "UTC", now)).toBeLessThan(1);
  });
});

describe("getQuote", () => {
  const status = {
    quote_id: "q1",
    org_id: "o1",
    project_id: "p1",
    budget_id: "b1",
    engagement_id: "e1",
    quote_key: "NWF26-Q-14",
    title: "Frozen title",
    client_name: "Coral Group",
    current_version_id: "v1",
    current_version_number: 1,
    display_state: "Sent",
    valid_until: "2026-12-01",
    sent_at: "2026-11-01T15:00:00Z",
    accepted_at: null,
    currency_code: "USD",
    client_total_minor: 5000,
    margin_minor: 1000,
    has_draft: true,
  };
  const version = (id: string, number: number, state: string, capture: string | null) => ({
    id,
    quote_id: "q1",
    version_number: number,
    quote_version_state: state,
    valid_until: "2026-12-01",
    terms: null,
    budget_version_id: capture,
    content_sha256: null,
    engagement_document_id: null,
    sent_at: capture ? "2026-11-01T15:00:00Z" : null,
    sent_by: null,
    accepted_at: null,
    accepted_by: null,
    accepted_name: null,
    sent_title: capture ? "Frozen title" : null,
    sent_client_name: capture ? "Coral Group" : null,
    updated_at: "2026-11-02T15:00:00Z",
  });

  it("follows a Draft beside a sent version: live lines and totals, since Send acts on it", async () => {
    const { db, calls } = fakeClient({
      "from:quote_statuses": [okResponse([status])],
      "from:quotes": [okResponse([{ title: "Retitled" }])],
      "from:quote_versions": [
        okResponse([version("v2", 2, "Draft", null), version("v1", 1, "Sent", "capture-1")]),
      ],
      "from:budget_lines": [
        okResponse([
          { id: "l1", line_number: 1, description: "Deck", quantity: 2, unit_basis: "day" },
        ]),
      ],
      "from:budget_line_prices": [
        okResponse([
          {
            budget_line_id: "l1",
            client_unit_price_minor: 4000,
            client_extended_minor: 8000,
            cost_extended_minor: 6000,
            margin_minor: 2000,
          },
        ]),
      ],
      "from:budget_price_totals": [
        okResponse({ client_total_minor: 8000, margin_minor: 2000, currency_code: "USD" }),
      ],
    });
    const result = await getQuote(db, "q1");
    if (!result.ok) throw new Error("the quote did not load");
    expect(result.data.shownVersionId).toBe("v2");
    expect(result.data.draftTitle).toBe("Retitled");
    expect(result.data.lines[0]?.clientAmountMinor).toBe(8000);
    expect(result.data.clientTotalMinor).toBe(8000);
    expect(result.data.marginMinor).toBe(2000);
    expect(result.data.costTotalMinor).toBe(6000);
    // The list's row still names the sent version.
    expect(result.data.status.clientTotalMinor).toBe(5000);
    expect(calls.map((c) => c.target)).not.toContain("from:budget_version_lines");
  });

  it("shows a sent version's frozen capture when there is no Draft", async () => {
    const { db } = fakeClient({
      "from:quote_statuses": [okResponse([{ ...status, has_draft: false }])],
      "from:quotes": [okResponse([{ title: "Retitled" }])],
      "from:quote_versions": [okResponse([version("v1", 1, "Sent", "capture-1")])],
      "from:budget_version_lines": [
        okResponse([
          {
            id: "c1",
            line_number: 1,
            description: "Deck",
            quantity: 2,
            unit_basis: "day",
            unit_price_minor: 2000,
            client_unit_price_minor: 2500,
          },
        ]),
      ],
    });
    const result = await getQuote(db, "q1");
    if (!result.ok) throw new Error("the quote did not load");
    expect(result.data.shownVersionId).toBe("v1");
    expect(result.data.lines[0]?.clientAmountMinor).toBe(5000);
    expect(result.data.clientTotalMinor).toBe(5000);
  });
});

describe("quoteLinkWindow", () => {
  it("reads the version's date and the project's zone from the database", async () => {
    const { db, calls } = fakeClient({
      "from:quote_versions": [okResponse({ valid_until: "2026-12-01", quote_id: "q1" })],
      "from:quote_statuses": [okResponse({ project_id: "p1" })],
      "from:projects": [okResponse({ time_zone: "America/New_York" })],
    });
    const result = await quoteLinkWindow(db, { documentId: "d1" });
    expect(result).toEqual({
      ok: true,
      data: { validUntil: "2026-12-01", timeZone: "America/New_York" },
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["engagement_document_id", "d1"]]);
  });

  it("answers not found for a document that is not a quote's", async () => {
    const { db } = fakeClient({ "from:quote_versions": [okResponse(null)] });
    expect((await quoteLinkWindow(db, { documentId: "d1" })).ok).toBe(false);
  });
});
