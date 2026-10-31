import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  FIELD_HISTORY_SUBJECTS,
  MONEY_SUBJECTS,
  attributeColumn,
  eventCurrencies,
  getFieldHistory,
  getHistoryMoney,
  hasFieldHistory,
  isMinorField,
  toHistoryEvents,
} from "../src/field-history.ts";

const migrations = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

const row = (over: Record<string, unknown>) => ({
  event_id: "e1",
  changed_at: "2026-10-21T14:00:00Z",
  actor_person_id: "p1",
  actor_name: "Dave Lindqvist",
  operation: "update",
  changes: [],
  ...over,
});

describe("field history", () => {
  it("maps one row per event, newest first, and keeps masked values out", () => {
    expect(
      toHistoryEvents([
        row({
          changes: [
            { field: "owner_party_id", old_value: null, new_value: "p2", masked: false },
            { field: "title", old_value: "Hang", new_value: "Hang both", masked: true },
          ],
        }),
        row({ event_id: "e0", changed_at: "2026-10-20T09:00:00Z", operation: "insert" }),
      ]),
    ).toEqual([
      {
        id: "e1",
        at: "2026-10-21T14:00:00Z",
        actorId: "p1",
        actorName: "Dave Lindqvist",
        operation: "update",
        changes: [
          { field: "owner_party_id", before: null, after: "p2", masked: false },
          { field: "title", before: null, after: null, masked: true },
        ],
      },
      {
        id: "e0",
        at: "2026-10-20T09:00:00Z",
        actorId: "p1",
        actorName: "Dave Lindqvist",
        operation: "insert",
        changes: [],
      },
    ]);
  });

  it("keeps every change of an event, however many fields it changed", () => {
    const changes = Array.from({ length: 40 }, (_, i) => ({
      field: `f${String(i).padStart(2, "0")}`,
      old_value: i,
      new_value: i + 1,
      masked: false,
    }));
    const events = toHistoryEvents(
      Array.from({ length: 1000 }, (_, i) => row({ event_id: `e${i}`, changes })),
    );
    expect(events).toHaveLength(1000);
    expect(events.every((e) => e.changes.length === 40)).toBe(true);
  });

  it("calls app.field_history_events and maps a refusal", async () => {
    const calls: unknown[] = [];
    const answer = (result: unknown) =>
      ({
        rpc: (fn: string, args: unknown) => {
          calls.push([fn, args]);
          return Promise.resolve(result);
        },
      }) as unknown as XosClient;
    const done = await getFieldHistory(
      answer({ data: [row({ operation: "delete" })], error: null }),
      "app.records",
      "r1",
    );
    expect(done.ok && done.data[0]?.operation).toBe("delete");
    expect(calls[0]).toEqual([
      "field_history_events",
      { p_subject_table: "app.records", p_subject_id: "r1", p_limit: 200 },
    ]);
    const hidden = await getFieldHistory(
      answer({ data: null, error: { code: "42501", message: "no" } }),
      "app.records",
      "r1",
    );
    expect(hidden).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("keeps a record's kind attributes in the record's event, named by attribute", () => {
    const [event] = toHistoryEvents([
      row({
        event_id: "e2",
        changes: [
          { field: "attributes.effort_hours", old_value: null, new_value: 6, masked: false },
          { field: "attributes.progress_pct", old_value: 40, new_value: 75, masked: false },
        ],
      }),
    ]);
    expect(event?.changes).toEqual([
      { field: "attributes.effort_hours", before: null, after: 6, masked: false },
      { field: "attributes.progress_pct", before: 40, after: 75, masked: false },
    ]);
    expect(attributeColumn("attributes.progress_pct")).toBe("progress_pct");
    expect(attributeColumn("title")).toBeNull();
  });

  it("reads a money subject's currency and every exponent, and nothing for other tables", async () => {
    const reads: string[] = [];
    const db = {
      from: (table: string) => {
        reads.push(table);
        const answer =
          table === "currencies"
            ? {
                data: [
                  { currency_code: "USD", minor_unit_exponent: 2 },
                  { currency_code: "JPY", minor_unit_exponent: 0 },
                ],
                error: null,
              }
            : { data: { currency_code: "JPY" }, error: null };
        const chain = {
          select: () => Object.assign(Promise.resolve(answer), chain),
          eq: () => chain,
          maybeSingle: () => Promise.resolve(answer),
        };
        return chain;
      },
    } as unknown as XosClient;
    const money = await getHistoryMoney(db, "app.expenses", "x1");
    expect(money.ok && money.data.currencyCode).toBe("JPY");
    expect(money.ok && [...money.data.exponents]).toEqual([
      ["USD", 2],
      ["JPY", 0],
    ]);
    expect(reads.sort()).toEqual(["currencies", "expenses"]);
    const none = await getHistoryMoney(db, "app.sops", "s1");
    expect(none).toEqual({ ok: true, data: { currencyCode: null, exponents: new Map() } });
    expect(reads).toHaveLength(2);
    expect(isMinorField("amount_minor")).toBe(true);
    expect(isMinorField("minor_note")).toBe(false);
  });

  it("gives each event the currency its amounts were in, walking back from the row's", () => {
    const events = toHistoryEvents([
      row({
        event_id: "e3",
        changes: [{ field: "amount_minor", old_value: 500, new_value: 700, masked: false }],
      }),
      row({
        event_id: "e2",
        changes: [
          { field: "amount_minor", old_value: 40000, new_value: 500, masked: false },
          { field: "currency_code", old_value: "USD", new_value: "JPY", masked: false },
        ],
      }),
      row({ event_id: "e1", operation: "insert" }),
    ]);
    expect(Object.fromEntries(eventCurrencies(events, "JPY"))).toEqual({
      e3: { before: "JPY", after: "JPY" },
      e2: { before: "USD", after: "JPY" },
      e1: { before: "USD", after: "USD" },
    });
  });

  it("walks a record's kind attribute currency the same way", () => {
    const events = toHistoryEvents([
      row({
        event_id: "e2",
        changes: [
          { field: "attributes.value_minor", old_value: 80000, new_value: 9000, masked: false },
          { field: "attributes.currency_code", old_value: "USD", new_value: "JPY", masked: false },
          { field: "currency_code", old_value: "EUR", new_value: "GBP", masked: false },
        ],
      }),
      row({ event_id: "e1", operation: "insert" }),
    ]);
    expect(Object.fromEntries(eventCurrencies(events, "JPY", "attributes.currency_code"))).toEqual({
      e2: { before: "USD", after: "JPY" },
      e1: { before: "USD", after: "USD" },
    });
  });

  it("lists exactly the tables the migrations make field history subjects", () => {
    const listed = new Set<string>();
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(`${migrations}${file}`, "utf8");
      for (const insert of sql.matchAll(
        /insert into private\.field_history_subjects \(table_name\) values([^;]*);/g,
      )) {
        for (const table of (insert[1] ?? "").matchAll(/'(app\.[a-z0-9_]+)'/g)) {
          if (table[1]) listed.add(table[1]);
        }
      }
    }
    expect([...FIELD_HISTORY_SUBJECTS].sort()).toEqual([...listed].sort());
    expect(hasFieldHistory("app.expenses")).toBe(true);
    expect(hasFieldHistory("app.form_submissions")).toBe(false);
    // B6 (2950): the itinerary and Show day read what moved on travel, rooms and cues.
    for (const table of ["app.travel_segments", "app.accommodation_assignments", "app.cues"]) {
      expect(hasFieldHistory(table), table).toBe(true);
    }
    expect(MONEY_SUBJECTS.has("app.travel_segments")).toBe(true);
  });

  it("lists as money subjects exactly the subjects with amounts in minor units, each with a currency", () => {
    const types = readFileSync(
      fileURLToPath(new URL("../src/database.types.ts", import.meta.url)),
      "utf8",
    );
    const app = types.slice(types.indexOf("\n  app: {"));
    const columns = (table: string) => {
      const name = table.slice("app.".length);
      const body = new RegExp(`\\n {6}${name}: \\{\\n {8}Row: \\{\\n([\\s\\S]*?)\\n {8}\\}`).exec(
        app,
      )?.[1];
      if (!body) throw new Error(`No row type for ${table}`);
      return [...body.matchAll(/^ {10}([a-z0-9_]+)\??:/gm)].map((m) => m[1] ?? "");
    };
    const withMoney = [...FIELD_HISTORY_SUBJECTS].filter((table) =>
      columns(table).some(isMinorField),
    );
    expect([...MONEY_SUBJECTS].sort()).toEqual(withMoney.sort());
    for (const table of MONEY_SUBJECTS) {
      expect(columns(table), table).toContain("currency_code");
    }
  });
});
