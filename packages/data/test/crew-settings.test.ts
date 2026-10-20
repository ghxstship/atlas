import { describe, expect, it } from "vitest";
import {
  acceptSwap,
  awardOpenShift,
  claimingRule,
  decideShiftClaim,
  listShiftClaims,
  nextPayPeriodDates,
  withdrawShiftClaim,
} from "../src/crew.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/**
 * The crew functions behind the Scheduling and Payroll settings (A65-001, migrations 1322 and 1323):
 * open shift claims under scheduling.open_shift_claiming, swaps accepted without approval under
 * scheduling.swap_requires_approval, and the next pay period from payroll.pay_period.
 */

const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: no`, hint: rule },
});

describe("open shift claims", () => {
  it("reads the claiming rule, approval by default", () => {
    expect(claimingRule("first-come")).toBe("first-come");
    expect(claimingRule("seniority")).toBe("seniority");
    expect(claimingRule("approval")).toBe("approval");
    expect(claimingRule(undefined)).toBe("approval");
  });

  it("lists waiting claims with the claimant's name", async () => {
    const { db, calls } = fakeClient({
      "from:shift_claims": [
        okResponse([
          {
            id: "c1",
            shift_id: "s1",
            claim_state: "Requested",
            reason: null,
            created_at: "2027-06-01T10:00:00Z",
            membership_id: "m1",
            member: { id: "m1", person_id: "p1", person: { full_name: "Frank Adeyemi" } },
          },
        ]),
        refused("denied"),
      ],
    });
    const claims = await listShiftClaims(db, "s1");
    expect(claims.ok && claims.data[0]).toMatchObject({
      id: "c1",
      state: "Requested",
      member: { membershipId: "m1", name: "Frank Adeyemi" },
    });
    expect(calls[0]?.steps).toContainEqual(["in", ["claim_state", ["Requested"]]]);
    expect((await listShiftClaims(db, "s1")).ok).toBe(false);
  });

  it("decides, awards and withdraws claims through their RPCs", async () => {
    const { db, calls } = fakeClient({
      "rpc:decide_shift_claim": [okResponse("c1"), refused("shift_claim_reason")],
      "rpc:award_open_shift": [okResponse("c2"), refused("shift_claim_none")],
      "rpc:withdraw_shift_claim": [okResponse("c3"), refused("shift_claim_decided")],
    });
    expect(await decideShiftClaim(db, "c1", true, null)).toEqual({ ok: true, data: { id: "c1" } });
    expect((await decideShiftClaim(db, "c1", false, null)).ok).toBe(false);
    expect(calls[0]?.steps[0]?.[1]).toEqual([{ p_shift_claim_id: "c1", p_approved: true }]);
    expect(await awardOpenShift(db, "s1", "Awarded by seniority.")).toEqual({
      ok: true,
      data: { id: "c2" },
    });
    expect((await awardOpenShift(db, "s1", "x")).ok).toBe(false);
    expect(await withdrawShiftClaim(db, "c3")).toEqual({ ok: true, data: { id: "c3" } });
    expect((await withdrawShiftClaim(db, "c3")).ok).toBe(false);
  });
});

describe("swaps without approval", () => {
  it("lets the person offered the shift accept it", async () => {
    const { db } = fakeClient({
      "rpc:accept_shift_swap": [okResponse("t1"), refused("swap_needs_approval")],
    });
    expect(await acceptSwap(db, "w1", "Taking it.")).toEqual({
      ok: true,
      data: { transitionId: "t1" },
    });
    const refusedSwap = await acceptSwap(db, "w1", "Taking it.");
    expect(refusedSwap.ok === false && refusedSwap.error).toMatchObject({
      kind: "refusal",
      rule: "swap_needs_approval",
    });
  });
});

describe("pay periods", () => {
  it("proposes the next period from the payroll settings", async () => {
    const { db } = fakeClient({
      "rpc:next_pay_period_dates": [
        okResponse([{ starts_on: "2027-06-16", ends_on: "2027-06-30" }]),
        okResponse([]),
        refused("denied"),
      ],
    });
    expect(await nextPayPeriodDates(db, "o1")).toEqual({
      ok: true,
      data: { startsOn: "2027-06-16", endsOn: "2027-06-30" },
    });
    expect(await nextPayPeriodDates(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await nextPayPeriodDates(db, "o1")).ok).toBe(false);
  });
});
