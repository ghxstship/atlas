import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import { bulkUpdate, sameValueRows, toBulkOutcome } from "../src/bulk.ts";

function rpcClient(answer: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
  } as unknown as XosClient;
  return { db, calls };
}

describe("bulk edit", () => {
  it("sends the same values for every selected row to the resource's RPC", async () => {
    const { db, calls } = rpcClient({
      data: {
        preview: false,
        committed: true,
        changed: 2,
        unchanged: 0,
        refused: [],
        inverse: [
          { id: "a", set: { owner_party_id: null }, expect: { owner_party_id: "p1" } },
          { id: "b", set: { owner_party_id: "p0" }, expect: { owner_party_id: "p1" } },
        ],
      },
      error: null,
    });
    const result = await bulkUpdate(
      db,
      "records",
      sameValueRows(["a", "b"], { owner_party_id: "p1" }),
      {
        reason: "Erin owns load-in.",
      },
    );
    expect(calls).toEqual([
      {
        fn: "bulk_update_records",
        args: {
          p_rows: [
            { id: "a", set: { owner_party_id: "p1" } },
            { id: "b", set: { owner_party_id: "p1" } },
          ],
          p_preview: false,
          p_reason: "Erin owns load-in.",
        },
      },
    ]);
    expect(result.ok && result.data.committed).toBe(true);
    expect(result.ok && result.data.inverse[1]).toEqual({
      id: "b",
      set: { owner_party_id: "p0" },
      expect: { owner_party_id: "p1" },
    });
  });

  it("previews without a reason and names each resource's RPC", async () => {
    for (const [resource, fn] of [
      ["shifts", "bulk_update_shifts"],
      ["invoices", "bulk_update_invoices"],
      ["asset_units", "bulk_update_asset_units"],
      ["shipments", "bulk_update_shipments"],
      ["dock_slots", "bulk_update_dock_slots"],
      ["fulfillments", "bulk_update_fulfillments"],
      ["beos", "bulk_update_beos"],
      ["accommodation_blocks", "bulk_update_accommodation_blocks"],
      ["guest_list_entries", "bulk_update_guest_list_entries"],
      ["purchase_orders", "bulk_update_purchase_orders"],
      ["rfqs", "bulk_update_rfqs"],
      ["vendors", "bulk_update_vendors"],
      ["engagement_roster_entries", "bulk_update_roster_entries"],
    ] as const) {
      const { db, calls } = rpcClient({ data: { preview: true, changed: 1 }, error: null });
      const result = await bulkUpdate(db, resource, [{ id: "x", set: { a: 1 } }], {
        preview: true,
      });
      expect(calls[0]).toEqual({
        fn,
        args: { p_rows: [{ id: "x", set: { a: 1 } }], p_preview: true },
      });
      expect(result.ok && result.data.preview).toBe(true);
    }
  });

  it("turns a refusal of the whole call into a typed error", async () => {
    const { db } = rpcClient({
      data: null,
      error: { code: "XR001", message: "bulk_empty: Select at least one row.", hint: "bulk_empty" },
    });
    const result = await bulkUpdate(db, "records", []);
    expect(result).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "bulk_empty", message: "Select at least one row." },
    });
  });

  it("reads refused rows and tolerates a malformed answer", () => {
    expect(
      toBulkOutcome({
        committed: false,
        changed: 1,
        refused: [{ id: "g1", rule: "bulk_row_not_found", message: "Gone." }, { rule: 3 }, "junk"],
        inverse: [{ set: {} }, { id: "a", set: { n: { deep: true } }, expect: null }],
      }),
    ).toEqual({
      preview: false,
      committed: false,
      changed: 1,
      unchanged: 0,
      refused: [
        { id: "g1", rule: "bulk_row_not_found", message: "Gone." },
        { id: null, rule: "refused", message: "" },
      ],
      inverse: [{ id: "a", set: { n: '{"deep":true}' }, expect: {} }],
    });
    expect(toBulkOutcome(null)).toEqual({
      preview: false,
      committed: false,
      changed: 0,
      unchanged: 0,
      refused: [],
      inverse: [],
    });
  });
});
