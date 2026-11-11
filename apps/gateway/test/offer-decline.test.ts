import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 4.9 surface crawl: declining an offer is confirmed and carries the person's own reason to the organization; a blank
 * reason falls back to the ledger's "Declined from Gateway.", and one over 500 characters never reaches the write.
 */

const state = vi.hoisted(() => ({ declined: [] as unknown[] }));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@xos/data/gateway", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  declineOffer: async (_db: unknown, input: unknown) => {
    state.declined.push(input);
    return { ok: true, data: null };
  },
}));

const { declineOfferAction } = await import("../lib/actions/offers");

const OFFER = "0192f1e2-7c3a-7b4d-9e8f-000000000009";

beforeEach(() => {
  state.declined = [];
});

describe("declining an offer", () => {
  it("sends the person's reason to the organization", async () => {
    expect(await declineOfferAction(OFFER, "  The dates clash with a tour.  ")).toEqual({
      ok: true,
    });
    expect(state.declined).toEqual([{ offerId: OFFER, reason: "The dates clash with a tour." }]);
  });

  it("falls back to the ledger's own reason when the field is blank", async () => {
    await declineOfferAction(OFFER, " ");
    await declineOfferAction(OFFER);
    expect(state.declined).toEqual([
      { offerId: OFFER, reason: "Declined from Gateway." },
      { offerId: OFFER, reason: "Declined from Gateway." },
    ]);
  });

  it("refuses a reason over 500 characters", async () => {
    expect(await declineOfferAction(OFFER, "x".repeat(501))).toEqual({
      ok: false,
      outcome: "invalid",
    });
    expect(state.declined).toEqual([]);
  });
});
