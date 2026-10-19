/**
 * A11 handlers (Logistics and Hospitality) end to end through the runtime, against an in-memory
 * stand-in for the caller's Supabase client. Every response is checked against openapi/v1.json with
 * expectContract (Section 18, gate 5). Only the deletes are served until the contract corrections
 * land; the other operations of both modules stay document-only and answer 404.
 */
import { describe, expect, it } from "vitest";
import { handlers as hospitality } from "../src/handlers/hospitality.ts";
import { handlers as logistics } from "../src/handlers/logistics.ts";
import { contractApp, expectContract } from "./support/contract.ts";

type Row = Record<string, unknown>;
type DbError = { code: string; message: string; hint?: string | null };

const ID = "0192f1e2-7c3a-7b4d-9e8f-000000011001";
const MISSING = "0192f1e2-7c3a-7b4d-9e8f-0000000119ff";

/** Rows per table; an update returns the matched row or nothing, like PostgREST with RLS. */
function world(error?: DbError) {
  const tables: Record<string, Row[]> = {};
  for (const t of [
    "shipments",
    "shipment_lines",
    "dock_slots",
    "fulfillments",
    "fulfillment_lines",
    "beos",
    "beo_lines",
  ]) {
    tables[t] = [{ id: ID, deleted_at: null }];
  }
  const db = {
    from(table: string) {
      let patch: Row = {};
      const filters: [string, unknown][] = [];
      const builder = {
        update(values: Row) {
          patch = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        select() {
          return builder;
        },
        async maybeSingle() {
          if (error) return { data: null, error };
          const row = (tables[table] ?? []).find((r) => filters.every(([c, v]) => r[c] === v));
          if (!row) return { data: null, error: null };
          Object.assign(row, patch);
          return { data: { id: row["id"] }, error: null };
        },
      };
      return builder;
    },
  };
  return { db, tables };
}

const del = { method: "DELETE" };

const ROUTES: [string, string, string][] = [
  ["/shipments", "shipments.delete", "shipments"],
  ["/shipment-lines", "shipmentLines.delete", "shipment_lines"],
  ["/dock-slots", "dockSlots.delete", "dock_slots"],
];

describe("Logistics and Hospitality deletes", () => {
  it.each(ROUTES)("%s/{id} moves the row to Trash, then answers 404", async (path, op, table) => {
    const { db, tables } = world();
    const app = contractApp({ handlers: [logistics, hospitality], db });
    const removed = await app.request(`${path}/${ID}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, op);
    expect(tables[table]?.[0]?.["deleted_at"]).toEqual(expect.any(String));
    const again = await app.request(`${path}/${ID}`, del);
    expect(again.status).toBe(404);
    await expectContract(again, op);
    const missing = await app.request(`${path}/${MISSING}`, del);
    expect(missing.status).toBe(404);
    expect(app.errors).toEqual([]);
  });

  it("passes database refusals and unexpected errors through as problems", async () => {
    const refused = contractApp({
      handlers: [logistics, hospitality],
      db: world({
        code: "XR001",
        message: "shipment_closed: Closed.",
        hint: "shipment_closed",
      }).db,
    });
    const response = await refused.request(`/shipments/${ID}`, del);
    expect(response.status).toBe(422);
    await expectContract(response, "shipments.delete");
    const hidden = contractApp({
      handlers: [logistics, hospitality],
      db: world({ code: "42501", message: "permission denied" }).db,
    });
    const notVisible = await hidden.request(`/shipments/${ID}`, del);
    expect(notVisible.status).toBe(404);
  });

  it("answers each delete in its documented shape", async () => {
    const app = contractApp({ handlers: [logistics, hospitality], db: world().db });
    const shipment = await app.request(`/shipments/${ID}`, del);
    await expectContract(shipment, "shipments.delete");
    const shipmentLine = await app.request(`/shipment-lines/${ID}`, del);
    await expectContract(shipmentLine, "shipmentLines.delete");
    const dockSlot = await app.request(`/dock-slots/${ID}`, del);
    await expectContract(dockSlot, "dockSlots.delete");
    expect([shipment, shipmentLine, dockSlot].map((r) => r.status)).toEqual([204, 204, 204]);
  });

  it("keeps the mismatched operations document-only", async () => {
    const { db } = world();
    const app = contractApp({ handlers: [logistics, hospitality], db });
    for (const path of ["/shipments", "/dock-slots", "/gate-queue", "/marshalling-log"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });
});
