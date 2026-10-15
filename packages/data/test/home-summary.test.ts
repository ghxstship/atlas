import { describe, expect, it } from "vitest";
import { committedSpend, countMyRecords, orgBaseCurrency } from "../src/home";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("home summary", () => {
  it("counts open and blocked records of the person", async () => {
    const { db, calls } = fakeClient({
      "from:records": [
        { data: null, error: null, count: 7 } as never,
        { data: null, error: null, count: null } as never,
        errorResponse("XX000", "x"),
      ],
    });
    expect(await countMyRecords(db, { orgId: "o1", personId: "p", which: "open" })).toEqual({
      ok: true,
      data: 7,
    });
    expect(calls[0]?.steps).toContainEqual([
      "not",
      ["record_state", "in", "(Complete,Canceled,Deferred)"],
    ]);
    expect(await countMyRecords(db, { orgId: "o1", personId: "p", which: "blocked" })).toEqual({
      ok: true,
      data: 0,
    });
    expect(calls[1]?.steps).toContainEqual(["eq", ["record_state", "Blocked"]]);
    expect((await countMyRecords(db, { orgId: "o1", personId: "p", which: "open" })).ok).toBe(
      false,
    );
  });

  it("resolves the org base currency from the settings registry", async () => {
    const { db } = fakeClient({
      "rpc:resolve_settings": [
        okResponse([{ setting_key: "org.base_currency", value_text: "eur" }]),
        okResponse([]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await orgBaseCurrency(db, "o1")).toEqual({ ok: true, data: "EUR" });
    expect(await orgBaseCurrency(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await orgBaseCurrency(db, "o1")).ok).toBe(false);
  });

  it("sums committed spend and counts unpriced and foreign purchase orders", async () => {
    const { db } = fakeClient({
      "from:purchase_orders": [
        okResponse([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]),
        okResponse([]),
        okResponse([{ id: "e" }]),
        errorResponse("XX000", "x"),
        okResponse([{ id: "f" }]),
      ],
      "from:purchase_order_totals": [
        okResponse([
          {
            purchase_order_id: "a",
            currency_code: "USD",
            lines_total_minor: 100_000,
            approved_changes_minor: 5_000,
          },
          {
            purchase_order_id: "b",
            currency_code: "USD",
            lines_total_minor: 20_000,
            approved_changes_minor: null,
          },
          {
            purchase_order_id: "c",
            currency_code: "USD",
            lines_total_minor: null,
            approved_changes_minor: null,
          },
          {
            purchase_order_id: "d",
            currency_code: "EUR",
            lines_total_minor: 9_000,
            approved_changes_minor: null,
          },
        ]),
        okResponse([
          {
            purchase_order_id: "e",
            currency_code: "USD",
            lines_total_minor: null,
            approved_changes_minor: null,
          },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await committedSpend(db, "o1", "USD")).toEqual({
      ok: true,
      data: { totalMinor: 125_000, currency: "USD", unpricedCount: 2 },
    });
    expect(await committedSpend(db, "o1", "USD")).toEqual({
      ok: true,
      data: { totalMinor: null, currency: "USD", unpricedCount: 0 },
    });
    expect(await committedSpend(db, "o1", "USD")).toEqual({
      ok: true,
      data: { totalMinor: null, currency: "USD", unpricedCount: 1 },
    });
    expect((await committedSpend(db, "o1", "USD")).ok).toBe(false);
    expect((await committedSpend(db, "o1", "USD")).ok).toBe(false);
  });
});
