/**
 * Contract tests for B6's additive shift operations (RRR-230, G-120; migration 2951): `shifts.communicationStatus` over
 * app.communication_status and `shifts.markCommunicated` over app.mark_communicated. Both need crew.shift.write. The
 * status takes at most 100 ids in its query; more are refused as communication_too_many before the database is asked.
 * Requests run through `contractApp`, and every response is checked against openapi/v1.json.
 */
import { describe, expect, it } from "vitest";
import { handlers as crew } from "../src/handlers/crew.ts";
import { contractApp, contractDocument, expectContract } from "./support/contract.ts";

type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };
type Call = { target: string; steps: [string, unknown[]][] };

function fakeDb(queues: Record<string, Response[]>) {
  const calls: Call[] = [];
  const db = {
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      const response = queues[`rpc:${name}`]?.shift();
      if (!response) throw new Error(`no queued response for rpc:${name}`);
      return Promise.resolve(response);
    },
    from(table: string) {
      throw new Error(`unexpected read of ${table}`);
    },
  };
  return { db, calls };
}

const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `b6-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return { api: contractApp({ handlers: [crew], db: fake.db as never }), calls: fake.calls };
}

describe("B6 contract: Needs review and Mark as communicated", () => {
  it("declares both operations with crew.shift.write", () => {
    const paths = (
      contractDocument as { paths: Record<string, Record<string, Record<string, unknown>>> }
    ).paths;
    expect(paths["/shifts/communication-status"]?.["get"]?.["operationId"]).toBe(
      "shifts.communicationStatus",
    );
    expect(paths["/shifts/communication-status"]?.["get"]?.["x-xos-capability"]).toBe(
      "crew.shift.write",
    );
    expect(paths["/shifts/mark-communicated"]?.["post"]?.["operationId"]).toBe(
      "shifts.markCommunicated",
    );
    expect(paths["/shifts/mark-communicated"]?.["post"]?.["x-xos-capability"]).toBe(
      "crew.shift.write",
    );
  });

  it("reads the status of the shifts asked for, in order", async () => {
    const { api, calls } = app({
      "rpc:communication_status": [
        ok([
          {
            subject_id: id(2),
            person_id: id(9),
            person_name: "Frank Ortiz",
            told_at: null,
            told_via: null,
            told_by_name: null,
            changed_at: null,
            changed_fields: [],
            needs_review: true,
          },
          {
            subject_id: id(1),
            person_id: id(8),
            person_name: "Erin Walsh",
            told_at: "2027-06-01T12:00:00+00:00",
            told_via: "notified",
            told_by_name: "Carol Nguyen",
            changed_at: "2027-06-01T12:05:00+00:00",
            changed_fields: ["role_code"],
            needs_review: true,
          },
        ]),
      ],
    });
    const res = await api.request(`/shifts/communication-status?ids=${id(1)},${id(2)}`);
    const body = (await expectContract(res, "shifts.communicationStatus")) as {
      data: { shift_id: string; told_via: string | null; changed_fields: string[] }[];
    };
    expect(body.data.map((s) => s.shift_id)).toEqual([id(1), id(2)]);
    expect(body.data[0]).toMatchObject({ told_via: "notified", changed_fields: ["role_code"] });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_subject_table: "app.shifts",
      p_subject_ids: [id(1), id(2)],
    });
  });

  it("refuses more than 100 ids without asking the database", async () => {
    const { api, calls } = app({});
    const ids = Array.from({ length: 101 }, (_, i) => id(i + 1)).join(",");
    const res = await api.request(`/shifts/communication-status?ids=${ids}`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { rule?: string }).rule).toBe("communication_too_many");
    expect(calls).toHaveLength(0);
  });

  it("marks shifts as communicated with the note", async () => {
    const { api, calls } = app({ "rpc:mark_communicated": [ok(2)] });
    const res = await api.request(
      "/shifts/mark-communicated",
      post({ ids: [id(1), id(2)], note: "Called both." }),
    );
    expect(await expectContract(res, "shifts.markCommunicated")).toEqual({ marked: 2 });
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({
      p_subject_table: "app.shifts",
      p_subject_ids: [id(1), id(2)],
      p_note: "Called both.",
    });
  });

  it("answers the rule of a refused mark", async () => {
    const { api } = app({
      "rpc:mark_communicated": [
        refusal("communication_no_assignee"),
        refusal("communication_too_many"),
      ],
    });
    const open = await api.request("/shifts/mark-communicated", post({ ids: [id(3)] }));
    expect(open.status).toBe(422);
    expect(((await open.json()) as { rule?: string }).rule).toBe("communication_no_assignee");
    const many = await api.request("/shifts/mark-communicated", post({ ids: [id(4)] }));
    expect(((await many.json()) as { rule?: string }).rule).toBe("communication_too_many");
  });

  it("answers 404 when a shift is not the caller's to write", async () => {
    const { api } = app({
      "rpc:mark_communicated": [
        { data: null, error: { code: "42501", message: "a row is not available to you" } },
      ],
    });
    const res = await api.request("/shifts/mark-communicated", post({ ids: [id(5)] }));
    expect(res.status).toBe(404);
  });
});
