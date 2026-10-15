import { describe, expect, it } from "vitest";
import {
  SETTLEMENT_ORG_NEXT,
  addSettlementLine,
  createSettlement,
  deleteSettlementLine,
  generateSelfBilledInvoice,
  listEngagementRefs,
  listSettlementLines,
  listSettlements,
  submitSettlement,
  transitionSettlement,
} from "../src/settlements.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const refusal = (rule: string) => errorResponse("XR001", `${rule}: refused.`, rule);

describe("settlements", () => {
  it("lists settlements with their NULL-aware net", async () => {
    const { db, calls } = fakeClient({
      "from:settlements": [
        okResponse([
          {
            id: "s1",
            engagement_id: "e1",
            project_id: "p1",
            settlement_number: 4,
            title: "Opening Night",
            currency_code: "USD",
            settled_on: "2027-06-02",
            settlement_state: "Proposed",
            created_by: "carol",
          },
        ]),
        okResponse([]),
        errorResponse("08006", "down"),
      ],
      "from:settlement_totals": [
        okResponse([{ settlement_id: "s1", line_count: 2, unpriced_count: 1, net_minor: null }]),
      ],
    });
    const result = await listSettlements(db, { orgId: "o1", projectId: "p1" });
    expect(result.ok && result.data[0]).toMatchObject({
      number: 4,
      netMinor: null,
      unpricedCount: 1,
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p1"]]);
    expect(await listSettlements(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect((await listSettlements(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("surfaces a failed totals read", async () => {
    const { db } = fakeClient({
      "from:settlements": [okResponse([{ id: "s1" }])],
      "from:settlement_totals": [errorResponse("42501", "denied")],
    });
    expect(await listSettlements(db, { orgId: "o1" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("reads lines and engagements", async () => {
    const { db } = fakeClient({
      "from:settlement_lines": [
        okResponse([
          {
            id: "l1",
            line_number: 1,
            line_kind: "Guarantee",
            description: "Fee.",
            amount_minor: 500,
          },
        ]),
      ],
      "from:engagements": [
        okResponse([
          {
            id: "e1",
            project_id: "p1",
            role_type: "Artist",
            engagement_state: "Active",
            currency_code: "USD",
            counterparty_id: null,
            person: { full_name: "Arturo Bell" },
          },
        ]),
      ],
    });
    const lines = await listSettlementLines(db, "s1");
    expect(lines.ok && lines.data[0]?.amountMinor).toBe(500);
    const engagements = await listEngagementRefs(db, { orgId: "o1", projectId: "p1" });
    expect(engagements.ok && engagements.data[0]?.personName).toBe("Arturo Bell");
  });

  it("creates, adds and removes lines", async () => {
    const { db, calls } = fakeClient({
      "from:settlements": [okResponse({ id: "s2" }), refusal("production_closed")],
      "from:settlement_lines": [
        okResponse([{ line_number: 3 }]),
        okResponse(null),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    const input = { engagementId: "e1", title: " Night ", currency: "USD", settledOn: null };
    expect(await createSettlement(db, "o1", input)).toEqual({ ok: true, data: { id: "s2" } });
    const closed = await createSettlement(db, "o1", input);
    expect(closed.ok === false && closed.error.kind).toBe("refusal");
    expect(
      (
        await addSettlementLine(db, "o1", "s2", {
          kind: "Bonus",
          description: " Sellout ",
          amountMinor: null,
        })
      ).ok,
    ).toBe(true);
    expect((calls[3]?.steps[0]?.[1]?.[0] as { line_number: number }).line_number).toBe(4);
    expect((await deleteSettlementLine(db, "l1")).ok).toBe(true);
    expect(
      (await addSettlementLine(db, "o1", "s2", { kind: "Bonus", description: "x", amountMinor: 1 }))
        .ok,
    ).toBe(false);
  });

  it("submits under spend authority and transitions", async () => {
    const { db } = fakeClient({
      "rpc:submit_settlement": [okResponse(false), refusal("settlement_unpriced")],
      "rpc:transition_settlement": [okResponse("t"), refusal("settlement_use_rpc")],
    });
    expect(await submitSettlement(db, "s1", "Send.")).toEqual({
      ok: true,
      data: { complete: false },
    });
    const unpriced = await submitSettlement(db, "s1", "Send.");
    expect(unpriced.ok === false && unpriced.error.kind === "refusal" && unpriced.error.rule).toBe(
      "settlement_unpriced",
    );
    const t = { id: "s1", expected: "Accepted" as const, next: "Paid" as const, reason: "Paid." };
    expect((await transitionSettlement(db, t)).ok).toBe(true);
    expect((await transitionSettlement(db, t)).ok).toBe(false);
    expect(SETTLEMENT_ORG_NEXT.Accepted).toEqual(["Paid"]);
  });

  it("generates a self-billed invoice or names the refusal", async () => {
    const { db } = fakeClient({
      "rpc:generate_self_billed_invoice": [okResponse("inv1"), refusal("self_billing_not_agreed")],
    });
    const input = { engagementId: "e1", periodStart: "2027-06-01", periodEnd: "2027-06-30" };
    expect(await generateSelfBilledInvoice(db, input)).toEqual({ ok: true, data: { id: "inv1" } });
    const refused = await generateSelfBilledInvoice(db, input);
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "self_billing_not_agreed",
    );
  });
});
