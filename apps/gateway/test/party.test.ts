import type { XosClient } from "@xos/data/client";
import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { listEngagedGuests, requestEngagedGuest, respondToSettlement } from "../lib/party";

type Call = { fn: string; args: Record<string, unknown> };

function fakeDb(reply: {
  data?: unknown;
  error?: { code: string; message: string; hint?: string };
}) {
  const calls: Call[] = [];
  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
    },
  } as unknown as XosClient;
  return { db, calls };
}

const ENGAGEMENT = "0192f1e2-7c3a-7b4d-9e8f-000000000001";

describe("guest list", () => {
  it("reads the engagement's guests through app.engaged_guest_list", async () => {
    const { db, calls } = fakeDb({
      data: [
        {
          id: "g1",
          scope_node_id: null,
          guest_name: "Dana Reyes",
          plus_ones: 1,
          note: "Tour manager.",
          entry_state: "Approved",
          checked_in_at: null,
          created_at: "2027-06-01T12:00:00Z",
        },
      ],
    });
    const result = await listEngagedGuests(db, ENGAGEMENT);
    expect(calls).toEqual([{ fn: "engaged_guest_list", args: { p_engagement_id: ENGAGEMENT } }]);
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "g1",
          guestName: "Dana Reyes",
          plusOnes: 1,
          note: "Tour manager.",
          state: "Approved",
          checkedInAt: null,
          requestedAt: "2027-06-01T12:00:00Z",
        },
      ],
    });
  });

  it("returns not-found when the engagement area is closed to the caller", async () => {
    const { db } = fakeDb({ error: { code: "42501", message: "engagement not found" } });
    const result = await listEngagedGuests(db, ENGAGEMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not-found");
  });

  it("requests a guest and leaves out an empty note", async () => {
    const { db, calls } = fakeDb({ data: "g2" });
    const result = await requestEngagedGuest(db, {
      engagementId: ENGAGEMENT,
      guestName: "Lee Park",
      plusOnes: 0,
      note: null,
    });
    expect(result).toEqual({ ok: true, data: { id: "g2" } });
    expect(calls[0]).toEqual({
      fn: "request_engaged_guest",
      args: { p_engagement_id: ENGAGEMENT, p_guest_name: "Lee Park", p_plus_ones: 0 },
    });
  });
});

describe("settlement answer", () => {
  it("accepts or disputes through app.respond_to_settlement", async () => {
    const { db, calls } = fakeDb({ data: "ledger" });
    expect(
      await respondToSettlement(db, { settlementId: "s1", accept: false, reason: "Wrong rate." }),
    ).toEqual({ ok: true, data: null });
    expect(calls[0]).toEqual({
      fn: "respond_to_settlement",
      args: { p_settlement_id: "s1", p_accept: false, p_reason: "Wrong rate." },
    });
  });

  it("keeps the rule of a refusal", async () => {
    const { db } = fakeDb({
      error: {
        code: "XR001",
        message: "lifecycle_conflict: Already answered.",
        hint: "lifecycle_conflict",
      },
    });
    const result = await respondToSettlement(db, {
      settlementId: "s1",
      accept: true,
      reason: "Ok.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({ kind: "refusal", rule: "lifecycle_conflict" });
  });
});

describe("copy for the new tabs", () => {
  it.each(locales)("has guest, settlement, travel and report copy in %s", (locale) => {
    const g = getMessages(locale).gateway;
    expect(g.engagement.guestList.empty.length).toBeGreaterThan(0);
    expect(g.engagement.forms.guest.submit.length).toBeGreaterThan(0);
    expect(g.engagement.forms.settlement.dispute.length).toBeGreaterThan(0);
    expect(g.engagement.travel.itinerary.length).toBeGreaterThan(0);
    expect(g.engagement.reports.shared.length).toBeGreaterThan(0);
    expect(Object.keys(g.enums.guestEntryState)).toEqual([
      "requested",
      "approved",
      "declined",
      "checkedIn",
    ]);
    expect(Object.keys(g.enums.settlementState)).toHaveLength(6);
  });
});
