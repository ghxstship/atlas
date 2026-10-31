/**
 * B15 Aurora intake and drafting extensions (RRR-239; Section 4.7, ADR 0154). Intake batches read
 * files one metered request each and are applied together; invoice lines come with a tie-out and
 * vendor history; advance answers are drafted from one source and recorded on the party's behalf;
 * governance drafts read the project's own records. Every refusal comes before app.ai_begin_request.
 * Requests run through `contractApp` and every response is checked against openapi/v1.json. The
 * database is a recording stand-in and the model a scripted client.
 */
import { readFileSync } from "node:fs";
import {
  EXTRACTION_TARGETS,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type PublicApi,
} from "@xos/ai";
import { describe, expect, it } from "vitest";
import { auroraHandlers, draftTarget } from "../src/handlers/parts/aurora.ts";
import { defineHandlers, type HandlerSet } from "../src/runtime/handler.ts";
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
  const db: Record<string, unknown> = {
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
  db["schema"] = () => db;
  return { db, calls };
}

class Scripted implements ModelClient {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly script: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("The scripted model ran out of responses.");
    return next;
  }
}

const tool = (name: string, input: unknown): ModelResponse => ({
  content: [{ type: "tool_use", id: `tu_${name}`, name, input }],
  stopReason: "tool_use",
  usage: { inputTokens: 300, outputTokens: 120 },
});

const ctx = testContext();
const ORG = ctx.org?.id as string;
const ME = ctx.personId as string;
const T = "2026-10-30T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const failure = (code: string, message: string, hint?: string): Response => ({
  data: null,
  error: { code, message, ...(hint ? { hint } : {}) },
});

const PROJECT = id(200);
const BATCH = id(500);
const INVOICE = id(600);
const MESSAGE = id(650);
const RECIPIENT = id(700);
const SECTION = id(710);

const batchRow = (over: Record<string, unknown> = {}) => ({
  id: BATCH,
  org_id: ORG,
  created_at: T,
  updated_at: T,
  updated_by: null,
  project_id: PROJECT,
  intake_kind: "Itineraries",
  fulfillment_id: null,
  file_count: 3,
  closed_at: null,
  created_by: ME,
  ...over,
});
/** The three reads of getIntake for a batch with no request yet. */
const freshBatch = (over: Record<string, unknown> = {}) => ({
  "from:ai_intake_batches": [ok(batchRow(over))],
  "from:ai_requests": [ok([])],
});

const NEVER_SEND = ok([{ table_name: "app.medical_encounters", column_name: null }]);

const project = { id: PROJECT, name: "Harbor Gala", time_zone: "America/New_York" };
const risk = {
  id: id(301),
  record_kind: "Risk",
  title: "Crowd Crush at the Coat Check",
  project_id: PROJECT,
};
const fixtureApi: PublicApi = {
  async get(path, query) {
    if (path === `/projects/${PROJECT}`) return { status: 200, body: project };
    if (path === "/records" && query["filter[record_kind][eq]"] === "Risk") {
      return { status: 200, body: { data: [risk], next_cursor: null } };
    }
    if (path === "/verbiage-terms") return { status: 200, body: { data: [] } };
    return { status: 200, body: { data: [], next_cursor: null } };
  },
};

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `b15-intake-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(
  queues: Record<string, Response[]>,
  script: ModelResponse[] = [],
  readApi: PublicApi = fixtureApi,
) {
  const fake = fakeDb(queues);
  const model = new Scripted(script);
  const handlers = defineHandlers(
    "Settings",
    auroraHandlers({
      model: () => model,
      readApi: () => readApi,
      today: () => "2026-10-30",
      timeZone: () => "America/New_York",
    }) as unknown as HandlerSet<"Settings">,
  );
  return {
    api: contractApp({ handlers: [handlers], db: fake.db as never }),
    calls: fake.calls,
    model,
  };
}

const metered = (calls: Call[]) => calls.some((c) => c.target === "rpc:ai_begin_request");
const argsOf = (calls: Call[], target: string) =>
  calls.find((c) => c.target === target)?.steps[0]?.[1]?.[0] as Record<string, unknown> | undefined;
const file = (text: string) => Buffer.from(text, "utf8").toString("base64");

const itinerary = tool("record_fields", {
  fields: [],
  lines: [
    {
      fields: [
        {
          field_path: "passenger_name",
          value: "Ivy Marchetti",
          confidence: 0.9,
          source_excerpt: "MARCHETTI/IVY",
          missing: null,
        },
        {
          field_path: "travel_mode",
          value: "Flight",
          confidence: 0.9,
          source_excerpt: null,
          missing: null,
        },
        {
          field_path: "service_identifier",
          value: "GA 100",
          confidence: 0.9,
          source_excerpt: "GA 100",
          missing: null,
        },
        {
          field_path: "departs_from",
          value: "MIA",
          confidence: 0.9,
          source_excerpt: "MIA",
          missing: null,
        },
        {
          field_path: "departs_local",
          value: "2027-11-03T22:30",
          confidence: 0.9,
          source_excerpt: "GA100 03NOV MIA 22:30",
          missing: null,
        },
        {
          field_path: "departs_time_zone",
          value: "America/New_York",
          confidence: 0.6,
          source_excerpt: null,
          missing: null,
        },
        {
          field_path: "arrives_at_place",
          value: "Old Field Strip",
          confidence: 0.9,
          source_excerpt: null,
          missing: null,
        },
      ],
    },
  ],
});

describe("extraction into an intake batch", () => {
  it("refuses a bad source, an unbatched itinerary and another person's batch before any metering", async () => {
    const { api, calls, model } = app({
      "from:ai_intake_batches": [ok(batchRow({ created_by: id(9) }))],
      "from:ai_requests": [ok([])],
    });
    const both = await api.request(
      "/aurora/extract",
      post({
        kind: "itinerary",
        intake_batch_id: BATCH,
        inbound_message_id: MESSAGE,
        content_base64: file("x"),
        media_type: "text/plain",
        file_name: "a.txt",
      }),
    );
    expect(await both.json()).toMatchObject({ rule: "aurora_extract_source" });
    const mail = await api.request(
      "/aurora/extract",
      post({ kind: "receipt", inbound_message_id: MESSAGE }),
    );
    expect(await mail.json()).toMatchObject({ rule: "aurora_extract_source" });
    const unnamed = await api.request(
      "/aurora/extract",
      post({ kind: "invoice", content_base64: file("x") }),
    );
    expect(await unnamed.json()).toMatchObject({ rule: "aurora_extract_source" });
    const loose = await api.request(
      "/aurora/extract",
      post({
        kind: "contract",
        content_base64: file("x"),
        media_type: "text/plain",
        file_name: "c.txt",
      }),
    );
    expect(await loose.json()).toMatchObject({ rule: "aurora_intake_item_invalid" });
    const theirs = await api.request(
      "/aurora/extract",
      post({
        kind: "itinerary",
        intake_batch_id: BATCH,
        content_base64: file("x"),
        media_type: "text/plain",
        file_name: "a.txt",
      }),
    );
    expect(theirs.status).toBe(404);
    expect(metered(calls)).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it("reads an itinerary about the batch with its checks and traveler candidates", async () => {
    const { api, calls, model } = app(
      {
        ...freshBatch(),
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(901))],
        "from:airports": [ok([{ iata_code: "MIA" }])],
        "rpc:itinerary_traveler_candidates": [
          ok([
            {
              name_index: 1,
              person_id: id(10),
              full_name: "Ivy Marchetti",
              roster_entry_id: null,
              engagement_id: id(11),
              similarity: "1.000",
            },
          ]),
        ],
      },
      [itinerary],
    );
    const res = await api.request(
      "/aurora/extract",
      post({
        kind: "itinerary",
        intake_batch_id: BATCH,
        media_type: "text/plain",
        content_base64: file("E-TICKET Issued 01 OCT 2027\nGA100 03NOV MIA 22:30"),
        file_name: "trip.txt",
      }),
    );
    const body = (await expectContract(res, "aurora.extract")) as {
      answer: {
        checks: { type: string; line: number }[];
        candidates: { person_id: string }[];
        inferred_year: number[];
      };
      suggestions: { operation_id: string }[];
    };
    expect(argsOf(calls, "rpc:ai_begin_request")).toMatchObject({
      p_org_id: ORG,
      p_feature: "extraction",
      p_subject_table: "app.ai_intake_batches",
      p_subject_id: BATCH,
    });
    expect(body.suggestions.map((s) => s.operation_id)).toEqual(["auroraIntakes.applyItineraries"]);
    expect(body.answer.checks).toEqual(
      expect.arrayContaining([
        { type: "unknown_airport", line: 0 },
        { type: "inferred_zone", line: 0 },
        { type: "inferred_year", line: 0 },
      ]),
    );
    expect(body.answer.candidates[0]?.person_id).toBe(id(10));
    expect(model.requests[0]?.messages[0]?.content[0]).toMatchObject({
      type: "document",
      mediaType: "text/plain",
    });
  });

  it("reads a verified inbox message as a document, never logging its body, and refuses one that is not", async () => {
    const message = {
      id: MESSAGE,
      purpose: "Project Inbox",
      dkim_verified: true,
      inbound_status: "Received",
      discarded_at: null,
      subject_line: "Your itinerary",
      body_text: "GA100 03NOV MIA 22:30 for MARCHETTI/IVY, issued 01 OCT 2027",
      inbound_address_id: id(651),
    };
    const { api, calls } = app(
      {
        "from:ai_intake_batches": [ok(batchRow()), ok(batchRow())],
        "from:ai_requests": [ok([]), ok([])],
        "from:inbound_messages": [ok([message]), ok([{ ...message, dkim_verified: false }])],
        "from:inbound_addresses": [ok([{ project_id: PROJECT }]), ok([{ project_id: PROJECT }])],
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(901))],
        "from:airports": [ok([])],
        "rpc:itinerary_traveler_candidates": [ok([])],
      },
      [itinerary],
    );
    const res = await api.request(
      "/aurora/extract",
      post({ kind: "itinerary", intake_batch_id: BATCH, inbound_message_id: MESSAGE }),
    );
    await expectContract(res, "aurora.extract");
    const completed = argsOf(calls, "rpc:ai_complete_request");
    expect(String(completed?.["p_prompt"])).toContain("[document text/plain]");
    expect(String(completed?.["p_prompt"])).not.toContain("MARCHETTI/IVY, issued");
    const before = calls.filter((c) => c.target === "rpc:ai_begin_request").length;
    const unverified = await api.request(
      "/aurora/extract",
      post({ kind: "itinerary", intake_batch_id: BATCH, inbound_message_id: MESSAGE }),
    );
    expect(await unverified.json()).toMatchObject({ rule: "aurora_draft_source_invalid" });
    expect(calls.filter((c) => c.target === "rpc:ai_begin_request").length).toBe(before);
  });

  it("asks a contract's fee only of a payroll reader, decided by the database, and keeps it out of the log", async () => {
    const contract = tool("record_fields", {
      fields: [
        {
          field_path: "act_name",
          value: "The Midnight Owls",
          confidence: 0.9,
          source_excerpt: "Artist: The Midnight Owls",
          missing: null,
        },
        {
          field_path: "fee_minor",
          value: 750000,
          confidence: 0.9,
          source_excerpt: "Guarantee: $7,500.00",
          missing: null,
        },
      ],
    });
    const { api, calls, model } = app(
      {
        ...freshBatch({ intake_kind: "Contracts and Riders" }),
        "rpc:my_capabilities_on_project": [ok(["data.restricted.read.payroll"])],
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(901))],
        "rpc:intake_party_candidates": [ok([])],
      },
      [contract],
    );
    const res = await api.request(
      "/aurora/extract",
      post({
        kind: "contract",
        intake_batch_id: BATCH,
        media_type: "text/plain",
        content_base64: file("contract"),
        file_name: "owls.txt",
      }),
    );
    await expectContract(res, "aurora.extract");
    expect(model.requests[0]?.system).toContain("fee_minor");
    const output = String(argsOf(calls, "rpc:ai_complete_request")?.["p_output"]);
    expect(output).toContain("[Restricted]");
    expect(output).not.toContain("750000");
    expect(argsOf(calls, "rpc:intake_party_candidates")).toMatchObject({
      p_names: ["The Midnight Owls", ""],
    });
  });
});

describe("already-booked itinerary rows", () => {
  it("returns the rows the traveler already has, for the caller's own batch only", async () => {
    const { api, calls } = app({
      "from:ai_intake_batches": [ok(batchRow()), ok(batchRow({ created_by: id(9) }))],
      "from:ai_requests": [ok([]), ok([])],
      "from:travel_segments": [
        ok([
          {
            person_id: id(11),
            service_identifier: "GA 101",
            departs_at: "2027-11-05T03:30:00+00:00",
          },
        ]),
      ],
    });
    const rows = [
      { person_id: id(10), service_identifier: "GA 100", departs_at: "2027-11-04T03:30:00Z" },
      { person_id: id(11), service_identifier: "GA 101", departs_at: "2027-11-05T03:30:00Z" },
      { person_id: id(12) },
    ];
    const res = await api.request(
      `/aurora/intakes/${BATCH}/check-itineraries`,
      post({ segments: rows }),
    );
    expect(await expectContract(res, "auroraIntakes.checkItineraries")).toEqual({ booked: [2] });
    const read = calls.find((c) => c.target === "from:travel_segments");
    expect(read?.steps).toContainEqual(["eq", ["org_id", ORG]]);
    expect(read?.steps).toContainEqual(["in", ["person_id", [id(10), id(11)]]]);
    expect(metered(calls)).toBe(false);
    const other = await api.request(
      `/aurora/intakes/${BATCH}/check-itineraries`,
      post({ segments: [] }),
    );
    expect(other.status).toBe(404);
  });
});

describe("invoice lines", () => {
  it("refuses an invoice that is not Proposed before any model call", async () => {
    const { api, calls } = app({
      "from:invoices": [
        ok([
          { id: INVOICE, direction: "Payable", invoice_state: "Approved", currency_code: "USD" },
        ]),
      ],
    });
    const res = await api.request(
      "/aurora/extract",
      post({
        kind: "invoice_lines",
        invoice_id: INVOICE,
        media_type: "text/plain",
        content_base64: file("x"),
        file_name: "i.txt",
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ rule: "aurora_invoice_not_proposed" });
    expect(metered(calls)).toBe(false);
  });

  it("proposes lines about the invoice with a tie-out, a currency flag and vendor history", async () => {
    const lines = tool("record_fields", {
      fields: [],
      check: [
        {
          field_path: "printed_total_minor",
          value: 18000,
          confidence: 0.9,
          source_excerpt: "Total $180.00",
          missing: null,
        },
        {
          field_path: "currency_code",
          value: "CAD",
          confidence: 0.9,
          source_excerpt: "CAD",
          missing: null,
        },
      ],
      lines: [
        {
          fields: [
            {
              field_path: "description",
              value: "Wedge monitor rental",
              confidence: 0.9,
              source_excerpt: null,
              missing: null,
            },
            {
              field_path: "quantity",
              value: 4,
              confidence: 0.9,
              source_excerpt: "4 x",
              missing: null,
            },
            {
              field_path: "unit_price_minor",
              value: 4500,
              confidence: 0.9,
              source_excerpt: "$45.00",
              missing: null,
            },
          ],
        },
      ],
    });
    const { api, calls } = app(
      {
        "from:invoices": [
          ok([
            { id: INVOICE, direction: "Payable", invoice_state: "Proposed", currency_code: "USD" },
          ]),
        ],
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(901))],
        "rpc:vendor_line_history": [
          ok([
            {
              description_index: 1,
              source: "invoice",
              reference: "INV-0042",
              line_number: 1,
              issued_on: "2027-05-01",
              description: "Wedge monitor rental",
              quantity: 4,
              unit_price_minor: 4500,
              currency_code: "USD",
              similarity: 1,
            },
          ]),
        ],
      },
      [lines],
    );
    const res = await api.request(
      "/aurora/extract",
      post({
        kind: "invoice_lines",
        invoice_id: INVOICE,
        document_id: id(601),
        media_type: "text/plain",
        content_base64: file("inv"),
        file_name: "inv.txt",
      }),
    );
    const body = (await expectContract(res, "aurora.extract")) as {
      answer: { tie_out: { status: string; flags: string[] }; history: { reference: string }[] };
    };
    expect(argsOf(calls, "rpc:ai_begin_request")).toMatchObject({
      p_subject_table: "app.invoices",
      p_subject_id: INVOICE,
    });
    expect(body.answer.tie_out).toMatchObject({ status: "ties", flags: ["currency_mismatch"] });
    expect(body.answer.history[0]?.reference).toBe("INV-0042");
  });

  it("refuses confirming a batch suggestion on its own", async () => {
    const suggestion = {
      id: id(901),
      org_id: ORG,
      created_at: T,
      created_by: ME,
      updated_at: T,
      updated_by: null,
      request_id: id(900),
      operation_id: "auroraIntakes.applyItineraries",
      target_id: null,
      summary: "Add segment 1: MIA to ORD.",
      suggestion_state: "Proposed",
      expires_at: T,
      applied_id: null,
    };
    const { api } = app({
      "from:ai_suggestions": [ok(suggestion)],
      "from:ai_suggestion_fields": [ok([])],
      "rpc:transition_ai_suggestion": [
        failure(
          "XR001",
          "ai_suggestion_batch_apply: Add these together from the Aurora preview, so nothing is written piecemeal.",
          "ai_suggestion_batch_apply",
        ),
      ],
    });
    const res = await api.request(
      `/ai-suggestions/${id(901)}/confirm`,
      post({ reason: "One row." }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ rule: "ai_suggestion_batch_apply" });
  });
});

describe("intake batches", () => {
  it("starts, reads and closes a batch", async () => {
    const proposed = {
      id: id(901),
      request_id: id(900),
      operation_id: "auroraIntakes.applyItineraries",
      target_id: null,
      summary: "Add segment 1: MIA to ORD.",
      suggestion_state: "Proposed",
      expires_at: T,
      applied_id: null,
    };
    const { api, calls } = app({
      "rpc:start_ai_intake": [ok(BATCH)],
      "from:ai_intake_batches": [ok(batchRow()), ok(batchRow()), ok(batchRow())],
      "from:ai_requests": [
        ok([]),
        ok([{ id: id(900), outcome: "Answered", failure_code: null, created_at: T }]),
        ok([]),
      ],
      "from:ai_suggestions": [ok([proposed])],
      "from:ai_suggestion_fields": [
        ok([
          {
            suggestion_id: id(901),
            field_path: "departs_from",
            proposed_value: "MIA",
            confidence: 0.9,
            refusal: null,
            missing: null,
            source_excerpt: "MIA",
            position: 0,
          },
        ]),
      ],
      "rpc:close_ai_intake": [ok(1)],
    });
    const started = await api.request(
      "/aurora/intakes",
      post({ project_id: PROJECT, kind: "Itineraries", file_count: 3 }),
    );
    expect((await expectContract(started, "auroraIntakes.start")) as { id: string }).toMatchObject({
      id: BATCH,
      file_count: 3,
    });
    expect(argsOf(calls, "rpc:start_ai_intake")).toEqual({
      p_project_id: PROJECT,
      p_kind: "Itineraries",
      p_file_count: 3,
    });
    const read = await api.request(`/aurora/intakes/${BATCH}`);
    const batch = (await expectContract(read, "auroraIntakes.get")) as {
      suggestions: { proposed_fields: unknown[] }[];
    };
    expect(batch.suggestions[0]?.proposed_fields).toHaveLength(1);
    expect(read.headers.get("ETag")).toBeTruthy();
    const closed = await api.request(`/aurora/intakes/${BATCH}/close`, post({}));
    expect(await expectContract(closed, "auroraIntakes.close")).toEqual({ rejected: 1 });
  });

  it("applies itineraries and contracts, keeping the database's refusals", async () => {
    const { api } = app({
      "from:ai_intake_batches": [
        ok(batchRow()),
        ok(batchRow({ intake_kind: "Contracts and Riders" })),
        ok(batchRow({ intake_kind: "Contracts and Riders" })),
      ],
      "from:ai_requests": [ok([]), ok([]), ok([])],
      "rpc:apply_itinerary_intake": [
        ok({ written: [{ suggestion_id: id(901), id: id(950) }], rejected: 0 }),
      ],
      "rpc:apply_contract_intake": [
        ok({
          applied: [{ suggestion_id: id(902), id: id(960) }],
          engagements: 1,
          riders: 0,
          rider_lines: 0,
          rejected: 0,
        }),
        failure(
          "XR001",
          "intake_fee_restricted: Act 1: only someone who may see pay rates sets a fee.",
          "intake_fee_restricted",
        ),
      ],
    });
    const segments = await api.request(
      `/aurora/intakes/${BATCH}/apply-itineraries`,
      post({
        items: [
          {
            suggestion_id: id(901),
            values: { person_id: id(10), departs_at: "2027-11-04T03:30:00Z" },
          },
        ],
      }),
    );
    expect(await expectContract(segments, "auroraIntakes.applyItineraries")).toEqual({
      written: [{ suggestion_id: id(901), id: id(950) }],
      rejected: 0,
    });
    const group = {
      act_name: "The Midnight Owls",
      engagement: { mode: "new", values: { person_id: id(10) } },
    };
    const booked = await api.request(
      `/aurora/intakes/${BATCH}/apply-contracts`,
      post({ groups: [group] }),
    );
    expect(await expectContract(booked, "auroraIntakes.applyContracts")).toMatchObject({
      engagements: 1,
    });
    const fee = await api.request(
      `/aurora/intakes/${BATCH}/apply-contracts`,
      post({ groups: [group] }),
    );
    expect(await fee.json()).toMatchObject({ rule: "intake_fee_restricted" });
  });
});

const draftable = {
  recipient_id: RECIPIENT,
  packet_id: id(701),
  project_id: PROJECT,
  time_zone: "America/New_York",
  engagement_id: null,
  sections: [
    {
      id: SECTION,
      title: "Load In Notes",
      prompt: null,
      kind: "Text",
      window_kind: null,
      max_lines: null,
      per_person: false,
      choices: [],
    },
    {
      id: id(711),
      title: "Parking",
      prompt: null,
      kind: "Text",
      window_kind: null,
      max_lines: null,
      per_person: false,
      choices: [],
    },
  ],
  roster: [{ id: id(720), name: "Kai Moana" }],
};

describe("advance answers", () => {
  const inbox = {
    id: MESSAGE,
    purpose: "Project Inbox",
    dkim_verified: true,
    inbound_status: "Received",
    discarded_at: null,
    subject_line: "Our advance",
    body_text: "Two trucks at 07:00, said Kai.",
    inbound_address_id: id(651),
  };

  it("refuses a message of another project before any metering", async () => {
    const { api, calls } = app({
      "rpc:draftable_advance_sections": [ok(draftable)],
      "from:inbound_messages": [ok([inbox])],
      "from:inbound_addresses": [ok([{ project_id: id(299) }])],
    });
    const res = await api.request(
      "/aurora/draft",
      post({
        kind: "advance_answers",
        instructions: "Draft the answers.",
        target: { collection: "advance-recipients", id: RECIPIENT },
        source: { inbound_message_id: MESSAGE },
      }),
    );
    expect(await res.json()).toMatchObject({ rule: "aurora_draft_source_invalid" });
    const none = await api.request(
      "/aurora/draft",
      post({
        kind: "advance_answers",
        instructions: "Draft the answers.",
        target: { collection: "advance-recipients", id: RECIPIENT },
        source: {},
      }),
    );
    expect(await none.json()).toMatchObject({ rule: "aurora_draft_source_invalid" });
    expect(metered(calls)).toBe(false);
    expect(() => draftTarget(undefined, "projects", "Event plans")).toThrow(
      /need a target in projects/,
    );
  });

  it("drafts about the recipient from the inbox, lists the unanswered sections and records an accepted answer", async () => {
    const { api, calls } = app(
      {
        "rpc:draftable_advance_sections": [ok(draftable), ok(draftable)],
        "from:inbound_messages": [ok([inbox]), ok([inbox])],
        "from:inbound_addresses": [ok([{ project_id: PROJECT }]), ok([{ project_id: PROJECT }])],
        "from:ai_never_send": [NEVER_SEND, NEVER_SEND],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(901))],
        "rpc:apply_drafted_advance_answer": [ok(id(980))],
      },
      [
        tool("draft_advance_answers", {
          answers: [
            {
              section_id: SECTION,
              body: "Two trucks at 07:00.",
              source_excerpt: "Two trucks at 07:00",
            },
          ],
          unanswered: [id(711)],
        }),
      ],
    );
    const target = { collection: "advance-recipients", id: RECIPIENT };
    const preview = await api.request(
      "/aurora/preview",
      post({
        feature: "drafting",
        draft_kind: "advance_answers",
        target,
        source: { inbound_message_id: MESSAGE },
        items: [],
      }),
    );
    const shown = (await expectContract(preview, "aurora.preview")) as {
      records: { collection: string }[];
    };
    expect(shown.records.map((r) => r.collection)).toEqual([
      "advance-sections",
      "advance-sections",
      "engagement-roster-entries",
      "inbound-messages",
    ]);
    const res = await api.request(
      "/aurora/draft",
      post({
        kind: "advance_answers",
        instructions: "Draft the answers.",
        target,
        source: { inbound_message_id: MESSAGE },
      }),
    );
    const body = (await expectContract(res, "aurora.draft")) as {
      answer: {
        answers: { suggestion_id: string; section_title: string }[];
        unanswered: { title: string }[];
      };
    };
    expect(argsOf(calls, "rpc:ai_begin_request")).toMatchObject({
      p_feature: "drafting",
      p_subject_table: "app.advance_recipients",
      p_subject_id: RECIPIENT,
    });
    expect(String(argsOf(calls, "rpc:ai_complete_request")?.["p_prompt"])).not.toContain(
      "said Kai",
    );
    expect(body.answer.answers[0]).toMatchObject({
      suggestion_id: id(901),
      section_title: "Load In Notes",
    });
    expect(body.answer.unanswered).toEqual([{ section_id: id(711), title: "Parking" }]);
    const accepted = await api.request(
      "/aurora/apply-advance-answer",
      post({ suggestion_id: id(901), source: { inbound_message_id: MESSAGE } }),
    );
    expect(await expectContract(accepted, "aurora.applyAdvanceAnswer")).toEqual({
      submission_id: id(980),
    });
    expect(argsOf(calls, "rpc:apply_drafted_advance_answer")).toEqual({
      p_suggestion_id: id(901),
      p_values: {},
      p_source: { inbound_message_id: MESSAGE },
    });
  });
});

describe("governance drafts", () => {
  it("drafts an event plan from the project's records with subject null, and previews them", async () => {
    const { api, calls, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND, NEVER_SEND],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
      },
      [
        tool("draft", {
          title: "Harbor Gala Event Plan",
          body: "## Overview\nA seated dinner.\n## Safety and Risk\nCrowd Crush at the Coat Check.",
          gaps: ["capacity"],
        }),
      ],
    );
    const target = { collection: "projects", id: PROJECT };
    const preview = await api.request(
      "/aurora/preview",
      post({ feature: "drafting", draft_kind: "event_plan", target, items: [] }),
    );
    const shown = (await expectContract(preview, "aurora.preview")) as {
      records: { id: string }[];
    };
    expect(shown.records.map((r) => r.id)).toEqual([PROJECT, risk.id]);
    const res = await api.request(
      "/aurora/draft",
      post({
        kind: "event_plan",
        instructions: "Draft the event plan.",
        target,
        outline: ["Overview", "Safety and Risk", "Contacts"],
      }),
    );
    const body = (await expectContract(res, "aurora.draft")) as {
      answer: { missingHeadings: string[]; gaps: string[] };
    };
    // Subject null: no subject is sent, so P6's drafted-list rule for app.projects never applies.
    expect(argsOf(calls, "rpc:ai_begin_request")).toEqual({
      p_org_id: ORG,
      p_feature: "drafting",
      p_model: expect.any(String),
    });
    expect(body.answer.missingHeadings).toEqual(["Contacts"]);
    expect(model.requests[0]?.system).toContain("Overview; Safety and Risk; Contacts");
    const mismatch = await api.request(
      "/aurora/draft",
      post({
        kind: "waste_plan",
        instructions: "Draft.",
        target: { collection: "run-of-show", id: PROJECT },
      }),
    );
    expect(await mismatch.json()).toMatchObject({ rule: "aurora_draft_target_mismatch" });
  });

  it("sends an approval pack only the certificates of the project's vendors", async () => {
    const vendorA = id(410);
    const vendorB = id(411);
    const asked: string[] = [];
    const readApi: PublicApi = {
      async get(path, query) {
        asked.push(`${path}?${new URLSearchParams(query).toString()}`);
        if (path === `/projects/${PROJECT}`) return { status: 200, body: project };
        if (path === "/purchase-orders") {
          return { status: 200, body: { data: [{ id: id(401), vendor_id: vendorA }] } };
        }
        if (path === "/engagements") {
          return {
            status: 200,
            body: {
              data: [
                { id: id(402), engagement_state: "Active", counterparty_id: id(420) },
                { id: id(403), engagement_state: "Canceled", counterparty_id: id(421) },
              ],
            },
          };
        }
        if (path === "/vendors" && query["filter[counterparty_id][eq]"] === id(420)) {
          return { status: 200, body: { data: [{ id: vendorB }] } };
        }
        if (path === "/insurance-certificates") {
          const vendor = query["filter[vendor_id][eq]"];
          if (!vendor) {
            return { status: 200, body: { data: [{ id: id(499), vendor_id: id(498) }] } };
          }
          const certificate = vendor === vendorA ? id(910) : id(911);
          return { status: 200, body: { data: [{ id: certificate, vendor_id: vendor }] } };
        }
        return { status: 200, body: { data: [], next_cursor: null } };
      },
    };
    const { api } = app({ "from:ai_never_send": [NEVER_SEND] }, [], readApi);
    const preview = await api.request(
      "/aurora/preview",
      post({
        feature: "drafting",
        draft_kind: "approval_pack",
        target: { collection: "projects", id: PROJECT },
        items: [],
      }),
    );
    const shown = (await expectContract(preview, "aurora.preview")) as {
      records: { id: string }[];
    };
    const ids = shown.records.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([id(910), id(911)]));
    expect(ids).not.toContain(id(499));
    expect(
      asked
        .filter((q) => q.startsWith("/insurance-certificates?"))
        .every((q) => q.includes("vendor_id")),
    ).toBe(true);
    expect(asked).not.toContainEqual(expect.stringContaining(id(421)));
  });
});

describe("suggestion operations", () => {
  // A suggestion's operation_id names the public operation that applies it (correction 22 and the
  // column comment), and API v1 operation names freeze at release.
  it("names only operations API v1 publishes", () => {
    const spec = JSON.parse(
      readFileSync(new URL("../openapi/v1.json", import.meta.url), "utf8"),
    ) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const published = new Set(
      Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op.operationId)),
    );
    const named = Object.values(EXTRACTION_TARGETS).flatMap((target) => [
      target.operationId,
      ...(target.lines ? [target.lines.operationId] : []),
    ]);
    for (const id of [...named, "aurora.applyAdvanceAnswer"]) expect(published, id).toContain(id);
    expect(named).toEqual(
      expect.arrayContaining(["auroraIntakes.applyItineraries", "auroraIntakes.applyContracts"]),
    );
  });
});
