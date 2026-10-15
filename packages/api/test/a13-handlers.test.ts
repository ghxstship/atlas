/**
 * Contract tests for A13's Crew handlers (Section 18, gate 5): pay periods with transitions, rate
 * cards, earning codes and time off policies. Requests run through `contractApp`, every response is
 * checked against openapi/v1.json with `expectContract`, and the database is a recording stand-in for
 * supabase-js: each `from(table)` or `rpc(name)` call takes the next queued response. Refusals (422),
 * hidden rows (404), stale state (409) and stale If-Match (412) are checked too.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/crew.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";

type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };
type Call = { target: string; steps: [string, unknown[]][] };

function fakeDb(queues: Record<string, Response[]>) {
  const calls: Call[] = [];
  const take = (key: string): Response => {
    const next = queues[key]?.shift();
    if (!next) throw new Error(`no queued response for ${key}`);
    return next;
  };
  const builder = (key: string, steps: [string, unknown[]][]) => {
    const response = take(key);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (r: Response) => unknown) => resolve(response);
          return (...args: unknown[]) => {
            steps.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const db = {
    from(table: string) {
      const call: Call = { target: `from:${table}`, steps: [] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
  };
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const ME = ctx.personId as string;
const T = "2026-10-01T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: ME,
});

const post = (body: unknown, key = "a13-contract-key") => ({
  method: "POST",
  headers: { "Idempotency-Key": key, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body: unknown, ifMatch = "*") => ({
  method: "PATCH",
  headers: { "If-Match": ifMatch, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return { api: contractApp({ handlers: [handlers], db: fake.db }), calls: fake.calls };
}

const period = {
  ...audit(1),
  starts_on: "2027-03-08",
  ends_on: "2027-03-21",
  pay_period_state: "Open",
};

describe("Crew contract: pay periods", () => {
  it("lists, reads, creates and edits pay periods", async () => {
    const { api } = app({
      "from:pay_periods": [
        ok([period, { ...period, id: id(2) }]),
        ok(period),
        ok(period),
        ok({ id: id(1) }),
        ok(period),
        hidden,
      ],
    });
    const list = (await expectContract(
      await api.request("/pay-periods?limit=1"),
      "payPeriods.list",
    )) as {
      next_cursor: string | null;
    };
    expect(list.next_cursor).not.toBeNull();
    const r1 = await api.request(`/pay-periods/${id(1)}`);

    await expectContract(r1, "payPeriods.get");
    const made = await api.request(
      "/pay-periods",
      post({ starts_on: "2027-03-08", ends_on: "2027-03-21" }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "payPeriods.create");
    const r2 = await api.request(`/pay-periods/${id(1)}`, patch({ ends_on: "2027-03-22" }));

    await expectContract(r2, "payPeriods.update");
    expect((await api.request(`/pay-periods/${id(9)}`)).status).toBe(404);
  });

  it("transitions with compare-and-set and refuses reopening a posted period", async () => {
    const posted = { ...period, pay_period_state: "Posted" };
    const { api, calls } = app({
      "from:pay_periods": [
        ok(period),
        ok({ ...period, pay_period_state: "Closed" }),
        ok(posted),
        ok(period),
      ],
      "rpc:transition_pay_period": [ok(id(5)), refusal("pay_period_transition_not_allowed")],
    });
    const moved = await api.request(
      `/pay-periods/${id(1)}/transitions`,
      post({ expected_state: "Open", to_state: "Closed", reason: "Cutoff." }),
    );
    await expectContract(moved, "payPeriods.transition");
    expect(calls.find((c) => c.target === "rpc:transition_pay_period")?.steps[0]?.[1]).toEqual([
      { p_pay_period_id: id(1), p_expected: "Open", p_next: "Closed", p_reason: "Cutoff." },
    ]);
    const reopen = await api.request(
      `/pay-periods/${id(1)}/transitions`,
      post({ expected_state: "Posted", to_state: "Open", reason: "Reopen." }, "a13-contract-key-2"),
    );
    expect(reopen.status).toBe(422);
    await expectContract(reopen, "payPeriods.transition");
    const stale = await api.request(
      `/pay-periods/${id(1)}/transitions`,
      post({ expected_state: "Closed", to_state: "Posted", reason: "Post." }, "a13-contract-key-3"),
    );
    expect(stale.status).toBe(409);
  });

  it("answers 412 for a stale If-Match", async () => {
    const { api } = app({ "from:pay_periods": [hidden, ok({ id: id(1) })] });
    const response = await api.request(
      `/pay-periods/${id(1)}`,
      patch({ ends_on: "2027-03-22" }, '"2026-01-01T00:00:00.000Z"'),
    );
    expect(response.status).toBe(412);
  });
});

describe("Crew contract: rate cards, earning codes and time off policies", () => {
  it("serves rate cards with the contract's currency field", async () => {
    const card = {
      ...audit(3),
      name: "2027 Crew Rates",
      currency: "USD",
      effective_from: "2027-01-01",
      effective_to: null,
    };
    const { api, calls } = app({
      "from:rate_cards": [
        ok([card]),
        ok(card),
        ok(card),
        ok({ id: id(3) }),
        ok(card),
        ok({ id: id(3) }),
        hidden,
      ],
    });
    const r3 = await api.request("/rate-cards");

    await expectContract(r3, "rateCards.list");
    const r4 = await api.request(`/rate-cards/${id(3)}`);

    await expectContract(r4, "rateCards.get");
    const made = await api.request(
      "/rate-cards",
      post({ name: "2027 Crew Rates", currency: "USD", effective_from: "2027-01-01" }),
    );
    await expectContract(made, "rateCards.create");
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      {
        org_id: ORG,
        name: "2027 Crew Rates",
        currency_code: "USD",
        effective_from: "2027-01-01",
        effective_to: null,
      },
    ]);
    const r5 = await api.request(`/rate-cards/${id(3)}`, patch({ name: "2027 Rates" }));

    await expectContract(r5, "rateCards.update");
    const deleted = await api.request(`/rate-cards/${id(3)}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    await expectContract(deleted, "rateCards.delete");
    expect((await api.request(`/rate-cards/${id(4)}`, { method: "DELETE" })).status).toBe(404);
  });

  it("serves earning codes in code order and time off policies", async () => {
    const code = { ...audit(6), earning_code: "REG", name: "Regular Hours", overtime: false };
    const policy = { ...audit(7), name: "Paid Time Off", accrual_hours_per_period: 4 };
    const { api, calls } = app({
      "from:earning_codes": [
        ok([code]),
        ok(code),
        ok(code),
        ok({ id: id(6) }),
        ok(code),
        ok({ id: id(6) }),
      ],
      "from:time_off_policies": [
        ok([policy]),
        ok(policy),
        ok(policy),
        ok({ id: id(7) }),
        ok(policy),
        ok({ id: id(7) }),
      ],
    });
    const r6 = await api.request("/earning-codes");

    await expectContract(r6, "earningCodes.list");
    // Code order: the list sorts on the stored code column behind the contract's earning_code.
    expect(JSON.stringify(calls[0]?.steps)).toContain('["order",["code"');
    const r7 = await api.request(`/earning-codes/${id(6)}`);

    await expectContract(r7, "earningCodes.get");
    const r8 = await api.request(
      "/earning-codes",
      post({ earning_code: "REG", name: "Regular Hours", overtime: false }),
    );

    await expectContract(r8, "earningCodes.create");
    const r9 = await api.request(`/earning-codes/${id(6)}`, patch({ name: "Regular" }));

    await expectContract(r9, "earningCodes.update");
    const codeGone = await api.request(`/earning-codes/${id(6)}`, { method: "DELETE" });
    expect(codeGone.status).toBe(204);
    await expectContract(codeGone, "earningCodes.delete");
    const r10 = await api.request("/time-off-policies");

    await expectContract(r10, "timeOffPolicies.list");
    const r11 = await api.request(`/time-off-policies/${id(7)}`);

    await expectContract(r11, "timeOffPolicies.get");
    const r12 = await api.request(
      "/time-off-policies",
      post({ name: "Paid Time Off", accrual_hours_per_period: 4 }, "a13-policy"),
    );

    await expectContract(r12, "timeOffPolicies.create");
    const r13 = await api.request(
      `/time-off-policies/${id(7)}`,
      patch({ accrual_hours_per_period: 5 }),
    );

    await expectContract(r13, "timeOffPolicies.update");
    const policyGone = await api.request(`/time-off-policies/${id(7)}`, { method: "DELETE" });
    expect(policyGone.status).toBe(204);
    await expectContract(policyGone, "timeOffPolicies.delete");
  });
});
