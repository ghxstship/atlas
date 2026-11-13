import type { Payment } from "@xos/data/gateway";
import { describe, expect, it } from "vitest";
import { paidByMonth } from "../lib/money";

/**
 * Money, Overview's Paid by month chart (crawl 4.9): the axis names months in the person's language, not as ISO
 * months, and six months with nothing paid show a sentence instead of an all-zero chart.
 */
const payment = (paidOn: string | null, amountMinor: number, state = "Paid"): Payment =>
  ({
    id: paidOn ?? "none",
    key: paidOn ?? "none",
    orgId: "org",
    orgName: "Northwind Live",
    accountId: null,
    amountMinor,
    currency: "USD",
    paidOn,
    reference: null,
    state,
  }) as Payment;

describe("paidByMonth", () => {
  it("labels the six months in the locale and keeps the ISO months for the amounts", () => {
    const chart = paidByMonth([payment("2026-09-12", 62_500)], "USD", "2026-11-10", "en-US");
    expect(chart.months).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(chart.labels).toEqual(["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]);
    expect(chart.values).toEqual([0, 0, 0, 625, 0, 0]);
    expect(chart.paid).toBe(true);
    const es = paidByMonth([], "USD", "2026-11-10", "es-US");
    expect(es.labels).not.toContain("2026-06");
    expect(es.labels[0]?.toLowerCase()).toMatch(/^jun/);
  });

  it("names the year when the six months cross one", () => {
    const chart = paidByMonth([], "USD", "2027-02-01", "en-US");
    expect(chart.labels[0]).toBe("Sep 2026");
    expect(chart.labels[5]).toBe("Feb 2027");
  });

  it("says nothing was paid when every month is zero, counting no canceled payment", () => {
    const chart = paidByMonth(
      [payment("2026-10-01", 10_000, "Canceled"), payment(null, 5_000)],
      "USD",
      "2026-11-10",
      "en-US",
    );
    expect(chart.paid).toBe(false);
  });
});
