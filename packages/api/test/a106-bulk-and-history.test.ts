/**
 * Contract tests for A106's additive operations (Section 18, gate 5): bulk edit over the 1451 RPCs, field history over
 * app.field_history_events (2061, one row per event) and a document's co-edited notes (1453). Requests run through `contractApp`, and every
 * response is checked against openapi/v1.json with `expectContract`. The database is a recording stand-in for
 * supabase-js: each `from(table)` or `rpc(name)` call takes the next queued response, and the recorded steps show what
 * reached the database. Call-level refusals (422), unreadable rows (404) and request validation (422) are checked too.
 */
import { describe, expect, it } from "vitest";
import { handlers as assets } from "../src/handlers/assets.ts";
import { handlers as crew } from "../src/handlers/crew.ts";
import { handlers as finance } from "../src/handlers/finance.ts";
import { handlers as knowledge } from "../src/handlers/knowledge.ts";
import { handlers as procurement } from "../src/handlers/procurement.ts";
import { handlers as vendors } from "../src/handlers/vendors.ts";
import { handlers as work } from "../src/handlers/work.ts";
import { contractApp, expectContract } from "./support/contract.ts";

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

const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string, message = "Refused."): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: ${message}`, hint: rule },
});
const forbidden: Response = {
  data: null,
  error: { code: "42501", message: "the row is not available to you" },
};

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: {
    "Idempotency-Key": `a106-contract-${(keys += 1)}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({
      handlers: [work, crew, finance, assets, knowledge, procurement, vendors],
      db: fake.db,
    }),
    calls: fake.calls,
  };
}

const argsOf = (calls: Call[], target: string, n = 0) =>
  calls.filter((c) => c.target === target)[n]?.steps[0]?.[1][0] as Record<string, unknown>;

describe("A106 contract: bulk edit", () => {
  it("previews a bulk change of records without changing anything", async () => {
    const { api, calls } = app({
      "rpc:bulk_update_records": [
        ok({ preview: true, committed: false, changed: 1, unchanged: 1, refused: [], inverse: [] }),
      ],
    });
    const rows = [
      { id: id(1), set: { record_state: "Scheduled" }, expect: { record_state: "Ready" } },
      { id: id(2), set: { record_state: "Scheduled" } },
    ];
    const previewed = await api.request(
      "/records/bulk-preview",
      post({ rows, reason: "Load-in moved." }),
    );
    const body = (await expectContract(previewed, "records.bulkPreview")) as {
      preview: boolean;
      changed: number;
      unchanged: number;
    };
    expect(body).toMatchObject({ preview: true, changed: 1, unchanged: 1 });
    expect(argsOf(calls, "rpc:bulk_update_records")).toEqual({
      p_rows: rows,
      p_preview: true,
      p_reason: "Load-in moved.",
    });
  });

  it("commits a bulk change of records and answers the rows that undo it", async () => {
    const { api, calls } = app({
      "rpc:bulk_update_records": [
        ok({
          preview: false,
          committed: true,
          changed: 1,
          unchanged: 0,
          refused: [],
          inverse: [
            {
              id: id(1),
              set: { owner_party_id: null, due_at: "2026-10-08T14:30:00+00:00" },
              expect: { owner_party_id: id(7), due_at: "2026-10-09T14:30:00+00:00" },
            },
          ],
        }),
      ],
    });
    const committed = await api.request(
      "/records/bulk-update",
      post({
        rows: [{ id: id(1), set: { owner_party_id: id(7), due_at: "2026-10-09T14:30:00Z" } }],
      }),
    );
    const body = (await expectContract(committed, "records.bulkUpdate")) as {
      committed: boolean;
      inverse: { set: Record<string, unknown> }[];
    };
    expect(body.committed).toBe(true);
    expect(body.inverse[0]?.set).toEqual({
      owner_party_id: null,
      due_at: "2026-10-08T14:30:00+00:00",
    });
    // No reason given: the RPC's own default applies.
    expect(argsOf(calls, "rpc:bulk_update_records")).toEqual({
      p_rows: [{ id: id(1), set: { owner_party_id: id(7), due_at: "2026-10-09T14:30:00Z" } }],
      p_preview: false,
    });
  });

  it("answers refused rows with their rule and changes nothing", async () => {
    const { api } = app({
      "rpc:bulk_update_records": [
        ok({
          preview: false,
          committed: false,
          changed: 1,
          unchanged: 0,
          refused: [
            {
              id: id(2),
              rule: "bulk_stale",
              message: "Someone changed this row after you loaded it; reload to see the change.",
            },
            { id: null, rule: "invalid", message: "invalid input syntax for type uuid" },
          ],
          inverse: [],
        }),
      ],
    });
    const refusedRows = await api.request(
      "/records/bulk-update",
      post({
        rows: [{ id: id(2), set: { record_state: "Active" }, expect: { record_state: "Ready" } }],
      }),
    );
    const body = (await expectContract(refusedRows, "records.bulkUpdate")) as {
      committed: boolean;
      refused: { rule: string }[];
      inverse: unknown[];
    };
    expect(body.committed).toBe(false);
    expect(body.refused.map((r) => r.rule)).toEqual(["bulk_stale", "invalid"]);
    expect(body.inverse).toEqual([]);
  });

  it("refuses the whole call when the database does", async () => {
    const { api } = app({
      "rpc:bulk_update_records": [
        refusal("bulk_duplicate_row", "Each row appears once in a bulk change."),
      ],
    });
    const response = await api.request(
      "/records/bulk-update",
      post({ rows: [{ id: id(1), set: { phase_code: "SCP" } }] }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      refusal: "REFUSE",
      rule: "bulk_duplicate_row",
      reason: "Each row appears once in a bulk change.",
    });
  });

  it("validates the rows before anything reaches the database", async () => {
    const { api, calls } = app({});
    // A field that does not change in bulk, an empty selection, more than 500 rows and a state that does not exist.
    for (const rows of [
      [{ id: id(1), set: { title: "Renamed" } }],
      [],
      Array.from({ length: 501 }, (_, i) => ({ id: id(i + 1), set: { record_state: "Ready" } })),
      [{ id: id(1), set: { record_state: "Finished" } }],
    ]) {
      const response = await api.request("/records/bulk-preview", post({ rows }));
      expect(response.status).toBe(422);
    }
    expect(calls).toEqual([]);
  });

  it("changes shifts, invoices and asset units in bulk through their own RPCs", async () => {
    const outcome = (inverse: unknown[]) =>
      ok({ preview: false, committed: true, changed: 1, unchanged: 0, refused: [], inverse });
    const preview = ok({
      preview: true,
      committed: false,
      changed: 1,
      unchanged: 0,
      refused: [],
      inverse: [],
    });
    const { api, calls } = app({
      "rpc:bulk_update_shifts": [
        preview,
        outcome([
          {
            id: id(3),
            set: { shift_state: "Draft", membership_id: null },
            expect: { shift_state: "Published", membership_id: id(9) },
          },
        ]),
      ],
      "rpc:bulk_update_invoices": [
        preview,
        outcome([
          { id: id(4), set: { invoice_state: "Proposed" }, expect: { invoice_state: "Approved" } },
        ]),
      ],
      "rpc:bulk_update_asset_units": [
        preview,
        outcome([
          {
            id: id(5),
            set: { asset_state: "Available", condition_enum_id: null },
            expect: { asset_state: "In Maintenance", condition_enum_id: "ENM-017" },
          },
        ]),
      ],
    });
    const shiftRows = [{ id: id(3), set: { shift_state: "Published", membership_id: id(9) } }];
    const shiftPreview = await api.request("/shifts/bulk-preview", post({ rows: shiftRows }));
    await expectContract(shiftPreview, "shifts.bulkPreview");
    const shiftUpdate = await api.request(
      "/shifts/bulk-update",
      post({ rows: shiftRows, reason: "Week 2 roster." }),
    );
    await expectContract(shiftUpdate, "shifts.bulkUpdate");
    const invoiceRows = [
      { id: id(4), set: { invoice_state: "Approved" }, expect: { invoice_state: "Proposed" } },
    ];
    const invoicePreview = await api.request("/invoices/bulk-preview", post({ rows: invoiceRows }));
    await expectContract(invoicePreview, "invoices.bulkPreview");
    const invoiceUpdate = await api.request("/invoices/bulk-update", post({ rows: invoiceRows }));
    await expectContract(invoiceUpdate, "invoices.bulkUpdate");
    const unitRows = [
      { id: id(5), set: { asset_state: "In Maintenance", condition_enum_id: "ENM-017" } },
    ];
    const unitPreview = await api.request("/asset-units/bulk-preview", post({ rows: unitRows }));
    await expectContract(unitPreview, "assetUnits.bulkPreview");
    const unitUpdate = await api.request("/asset-units/bulk-update", post({ rows: unitRows }));
    await expectContract(unitUpdate, "assetUnits.bulkUpdate");
    expect(calls.map((c) => c.target)).toEqual([
      "rpc:bulk_update_shifts",
      "rpc:bulk_update_shifts",
      "rpc:bulk_update_invoices",
      "rpc:bulk_update_invoices",
      "rpc:bulk_update_asset_units",
      "rpc:bulk_update_asset_units",
    ]);
    expect(argsOf(calls, "rpc:bulk_update_shifts", 1)).toMatchObject({
      p_preview: false,
      p_reason: "Week 2 roster.",
    });
    expect(argsOf(calls, "rpc:bulk_update_invoices", 0)).toMatchObject({ p_preview: true });
  });
});

describe("A106 contract: field history", () => {
  const T1 = "2026-10-09T15:00:00+00:00";
  const T0 = "2026-10-01T12:00:00+00:00";
  const historyRows = [
    {
      event_id: id(21),
      changed_at: T1,
      actor_person_id: id(80),
      actor_name: "Carol Nguyen",
      operation: "update",
      changes: [
        {
          field: "bank_account_number",
          old_value: null,
          new_value: null,
          masked: true,
        },
        {
          field: "due_at",
          old_value: "2026-10-08T14:30:00+00:00",
          new_value: "2026-10-09T14:30:00+00:00",
          masked: false,
        },
      ],
    },
    {
      event_id: id(20),
      changed_at: T0,
      actor_person_id: null,
      actor_name: null,
      operation: "insert",
      changes: [],
    },
  ];

  it("answers a record's events, newest first, each with its changes", async () => {
    const { api, calls } = app({ "rpc:field_history_events": [ok(historyRows)] });
    const page = (await expectContract(
      await api.request(`/records/${id(1)}/field-history?limit=50`),
      "records.fieldHistory",
    )) as {
      data: {
        event_id: string;
        operation: string;
        changes: { field: string; masked: boolean }[];
      }[];
      next_cursor: string | null;
    };
    expect(page.next_cursor).toBeNull();
    expect(page.data.map((e) => [e.event_id, e.operation, e.changes.length])).toEqual([
      [id(21), "update", 2],
      [id(20), "insert", 0],
    ]);
    expect(page.data[0]?.changes[0]).toEqual({
      field: "bank_account_number",
      old_value: null,
      new_value: null,
      masked: true,
    });
    expect(argsOf(calls, "rpc:field_history_events")).toEqual({
      p_subject_table: "app.records",
      p_subject_id: id(1),
      p_limit: 50,
    });
  });

  it("keeps a full page whole: 1,000 events, each with all of its changes", async () => {
    // One row per event, so the API's row cap (max_rows, 1,000) and limit count the same thing; app.field_history
    // answered one row per changed field, and a page this size lost its oldest events to the cap.
    const changes = Array.from({ length: 6 }, (_, i) => ({
      field: `field_${i}`,
      old_value: i,
      new_value: i + 1,
      masked: false,
    }));
    const events = Array.from({ length: 1000 }, (_, i) => ({
      ...historyRows[0],
      event_id: id(1000 + i),
      changes,
    }));
    const { api, calls } = app({ "rpc:field_history_events": [ok(events)] });
    const page = (await expectContract(
      await api.request(`/records/${id(1)}/field-history?limit=1000`),
      "records.fieldHistory",
    )) as { data: { event_id: string; changes: unknown[] }[]; next_cursor: string | null };
    expect(page.data).toHaveLength(1000);
    expect(page.data.every((e) => e.changes.length === 6)).toBe(true);
    expect(page.data.at(-1)?.event_id).toBe(id(1999));
    expect(argsOf(calls, "rpc:field_history_events")).toMatchObject({ p_limit: 1000 });
  });

  it("answers 404 for a row the caller cannot read, and validates the limit", async () => {
    const { api, calls } = app({ "rpc:field_history_events": [forbidden] });
    const hidden = await api.request(`/records/${id(1)}/field-history`);
    expect(hidden.status).toBe(404);
    expect(argsOf(calls, "rpc:field_history_events")).toMatchObject({ p_limit: 200 });
    expect((await api.request(`/records/${id(1)}/field-history?limit=1001`)).status).toBe(422);
  });

  it("reads the history of every subject from its own table", async () => {
    const { api, calls } = app({
      "rpc:field_history_events": Array.from({ length: 7 }, () => ok(historyRows.slice(1))),
    });
    const history = (path: string) => api.request(`${path}/${id(6)}/field-history`);
    await expectContract(await history("/shifts"), "shifts.fieldHistory");
    await expectContract(await history("/invoices"), "invoices.fieldHistory");
    await expectContract(await history("/asset-units"), "assetUnits.fieldHistory");
    await expectContract(await history("/sops"), "sops.fieldHistory");
    await expectContract(await history("/documents"), "documents.fieldHistory");
    await expectContract(await history("/purchase-orders"), "purchaseOrders.fieldHistory");
    await expectContract(await history("/vendors"), "vendors.fieldHistory");
    expect(
      calls.map((c) => (c.steps[0]?.[1][0] as Record<string, unknown>)["p_subject_table"]),
    ).toEqual([
      "app.shifts",
      "app.invoices",
      "app.asset_units",
      "app.sops",
      "app.documents",
      "app.purchase_orders",
      "app.vendors",
    ]);
  });
});

describe("A106 contract: document notes", () => {
  it("reads a document's co-edited notes as plain text", async () => {
    const { api, calls } = app({
      "from:documents": [ok({ id: id(30) }), ok({ id: id(31) })],
      "from:doc_snapshots": [
        ok({
          generation: 2,
          through_seq: 12,
          last_seq: 14,
          text_snapshot: "Bring two copies of the site plan.",
        }),
        ok(null),
      ],
    });
    const notes = (await expectContract(
      await api.request(`/documents/${id(30)}/notes`),
      "documents.notes",
    )) as Record<string, unknown>;
    expect(notes).toEqual({
      document_id: id(30),
      text: "Bring two copies of the site plan.",
      generation: 2,
      saved_through: 12,
      latest_edit: 14,
    });
    const snapshot = calls.find((c) => c.target === "from:doc_snapshots");
    expect(snapshot?.steps).toEqual(
      expect.arrayContaining([
        ["eq", ["subject_table", "app.documents"]],
        ["eq", ["subject_id", id(30)]],
        ["eq", ["doc_key", "notes"]],
      ]),
    );
    // Nobody opened the notes yet.
    const empty = (await expectContract(
      await api.request(`/documents/${id(31)}/notes`),
      "documents.notes",
    )) as Record<string, unknown>;
    expect(empty).toMatchObject({ text: null, generation: 0, saved_through: 0, latest_edit: 0 });
  });

  it("answers 404 when the caller cannot read the document", async () => {
    const { api, calls } = app({ "from:documents": [ok(null)] });
    expect((await api.request(`/documents/${id(32)}/notes`)).status).toBe(404);
    expect(calls.map((c) => c.target)).toEqual(["from:documents"]);
  });
});
