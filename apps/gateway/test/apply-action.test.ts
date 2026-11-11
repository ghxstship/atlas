import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Apply (Section 4.4.3), from the 4.9 surface crawl: someone acting for their company applies for a Contractor opportunity
 * as that company, so the application and the engagement it becomes are the company's; acting for nobody they still apply
 * as themselves. A sealed bid line with a negative unit price is refused on its line, never saved as positive.
 */

const state = vi.hoisted(() => ({
  acting: null as { id: string; name: string } | null,
  roleType: "Contractor" as string,
  rateType: "Day" as string | null,
  applied: [] as Record<string, unknown>[],
  bids: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@/lib/shell/context", () => ({
  getGatewayContext: async () => ({
    db: {},
    personId: "person-1",
    personName: "Demo Contractor",
    email: "contractor@example.com",
    acting: state.acting,
  }),
}));
vi.mock("@xos/data/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xos/data/gateway")>()),
  getOpportunity: async () => ({
    ok: true,
    data: {
      id: OPPORTUNITY,
      orgId: "org-1",
      roleType: state.roleType,
      rateType: state.rateType,
      currency: "USD",
      questions: [],
    },
  }),
  shareProfile: async () => ({ ok: true, data: { profileShareId: "share-1" } }),
  applyToOpportunity: async (_db: unknown, input: Record<string, unknown>) => {
    state.applied.push(input);
    return { ok: true, data: { applicationId: "application-1" } };
  },
  submitBid: async (_db: unknown, input: Record<string, unknown>) => {
    state.bids.push(input);
    return { ok: true, data: null };
  },
}));

const { applyAction } = await import("../lib/actions/marketplace");

const OPPORTUNITY = "0192f1e2-7c3a-7b4d-9e8f-000000000001";

function form(values: readonly [string, string][]): FormData {
  const data = new FormData();
  data.set("opportunityId", OPPORTUNITY);
  data.set("available", "on");
  for (const [k, v] of values) data.append(k, v);
  return data;
}

beforeEach(() => {
  state.acting = null;
  state.roleType = "Contractor";
  state.rateType = "Day";
  state.applied = [];
  state.bids = [];
});

describe("a contractor acting for their company", () => {
  it("applies as the company it was invited as", async () => {
    state.acting = { id: "studio", name: "Demo Design Studio" };
    expect(await applyAction({}, form([["fee", "1200"]]))).toEqual({ sent: true });
    expect(state.applied[0]).toMatchObject({
      applicantPersonId: null,
      applicantOrganizationId: "studio",
      proposedFeeMinor: 120000,
    });
  });

  it("applies as themselves when they act for nobody", async () => {
    await applyAction({}, form([]));
    expect(state.applied[0]).toMatchObject({
      applicantPersonId: "person-1",
      applicantOrganizationId: null,
    });
  });
});

describe("a sealed bid line", () => {
  beforeEach(() => {
    state.acting = { id: "supply", name: "Demo Staging Supply" };
    state.roleType = "Vendor";
    state.rateType = "Bid";
  });

  const lines = (price: string): [string, string][] => [
    ["lineDescription", "Truss"],
    ["lineQuantity", "2"],
    ["linePrice", "3800"],
    ["lineDescription", "Rigging hardware"],
    ["lineQuantity", "1"],
    ["linePrice", price],
  ];

  it("with a negative unit price is refused on that line and nothing is sent", async () => {
    expect(await applyAction({}, form(lines("-5")))).toEqual({
      fieldError: "bidLinePrice",
      line: 2,
    });
    expect(state.applied).toEqual([]);
    expect(state.bids).toEqual([]);
  });

  it("with a price that is not an amount is refused the same way", async () => {
    expect(await applyAction({}, form(lines("abc")))).toEqual({
      fieldError: "bidLinePrice",
      line: 2,
    });
  });

  it("with no price stays unpriced, never zero", async () => {
    expect(await applyAction({}, form(lines("")))).toEqual({ sent: true });
    expect(
      (state.bids[0]?.["lines"] as { unitPriceMinor: unknown }[])[1]?.unitPriceMinor,
    ).toBeNull();
  });

  it("with prices of zero or more is sent as typed", async () => {
    expect(await applyAction({}, form(lines("0")))).toEqual({ sent: true });
    expect(state.bids[0]?.["lines"]).toEqual([
      { description: "Truss", quantity: 2, unitPriceMinor: 380000 },
      { description: "Rigging hardware", quantity: 1, unitPriceMinor: 0 },
    ]);
  });
});

describe("parseMoneyInput", () => {
  it("keeps the sign while cleaning, so a negative amount is refused, not read as positive", async () => {
    const { parseMoneyInput } = await import("../lib/format");
    expect(parseMoneyInput("-5", "USD")).toBeNull();
    expect(parseMoneyInput("$ -1,200.50", "USD")).toBeNull();
    expect(parseMoneyInput("-", "USD")).toBeNull();
    expect(parseMoneyInput("5", "USD")).toBe(500);
    expect(parseMoneyInput("$1,200.50", "USD")).toBe(120050);
    expect(parseMoneyInput("0", "USD")).toBe(0);
    expect(parseMoneyInput("", "USD")).toBeNull();
  });
});
