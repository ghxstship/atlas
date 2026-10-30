import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import { getFieldHistory, toHistoryEvents } from "../src/field-history.ts";

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
});
