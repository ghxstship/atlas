/**
 * B15 Aurora intake and drafting extensions (RRR-239; Section 4.7, ADR 0154). An intake is its open
 * suggestions; every refusal comes before app.ai_begin_request and apply and preview meter nothing.
 * Requests run through `contractApp` and every response is checked against openapi/v1.json. The
 * database is a recording stand-in and the model a scripted client.
 */
import { type ModelClient, type ModelRequest, type ModelResponse, type PublicApi } from "@xos/ai";
import { describe, expect, it } from "vitest";
import { handlers as financeHandlers } from "../src/handlers/finance.ts";
import { auroraHandlers } from "../src/handlers/parts/aurora.ts";
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
const RECORD = id(300);
const RECIPIENT = id(700);
const SECTION = id(710);
const MESSAGE = id(650);
const ADDRESS = id(651);

const NEVER_SEND = ok([{ table_name: "app.medical_encounters", column_name: null }]);
const project = { id: PROJECT, name: "Harbor Gala", time_zone: "America/New_York" };
const plan = {
  id: RECORD,
  record_kind: "Document",
  record_subtype: "Plan",
  project_id: PROJECT,
  title: "Plan",
};

const fixtureApi: PublicApi = {
  async get(path, query) {
    if (path === `/projects/${PROJECT}`) return { status: 200, body: project };
    if (path === `/records/${RECORD}`) return { status: 200, body: plan };
    if (path === "/records" && query["filter[record_kind][eq]"] === "Event") {
      return {
        status: 200,
        body: { data: [{ id: id(301), record_kind: "Event", title: "Gala" }] },
      };
    }
    if (path === `/projects/${PROJECT}/gate-readiness`) {
      return { status: 200, body: { data: [{ criterion: "Fire marshal", satisfied: false }] } };
    }
    if (path === "/project-objectives")
      return { status: 200, body: { data: [{ id: id(302), metric_code: "waste" }] } };
    if (path === "/project-measurements")
      return { status: 200, body: { data: [{ id: id(303), metric_code: "waste", value: 12 }] } };
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
const FORBIDDEN = failure("42501", "this needs the capability on the project in your org");

const answered = () => ({
  "rpc:ai_begin_request": [ok(id(800))],
  "rpc:ai_complete_request": [ok(null)],
  "rpc:ai_propose_suggestion": [ok(id(801)), ok(id(802)), ok(id(803))],
});

const extractBody = (kind: string, projectId?: string) => ({
  kind,
  ...(projectId ? { project_id: projectId } : {}),
  media_type: "text/plain",
  content_base64: file("A document."),
  file_name: "doc.txt",
});

describe("scope refusals come before any model call or metering", () => {
  it("needs a project for an itinerary or a contract", async () => {
    const { api, calls, model } = app({});
    for (const kind of ["itinerary", "contract"]) {
      const response = await api.request("/aurora/extract", post(extractBody(kind)));
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("aurora_intake_project_required");
    }
    expect(metered(calls)).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it("answers 404, never 403, without the intake's capability", async () => {
    const { api, calls, model } = app({
      "rpc:aurora_intake_scope": [FORBIDDEN, FORBIDDEN, FORBIDDEN],
      "from:ai_never_send": [NEVER_SEND],
    });
    const contract = await api.request("/aurora/extract", post(extractBody("contract", PROJECT)));
    expect(contract.status).toBe(404);
    const itinerary = await api.request("/aurora/extract", post(extractBody("itinerary", PROJECT)));
    expect(itinerary.status).toBe(404);
    const draft = await api.request(
      "/aurora/draft",
      post({
        kind: "waste_plan",
        instructions: "Draft it.",
        target: { collection: "records", id: RECORD },
      }),
    );
    expect(draft.status).toBe(404);
    expect(metered(calls)).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it("refuses a recipient with no open section before metering", async () => {
    const { api, calls } = app({
      "rpc:advance_draft_scope": [
        failure(
          "XR001",
          "aurora_advance_no_open_sections: This recipient has no open section Aurora can draft.",
          "aurora_advance_no_open_sections",
        ),
        FORBIDDEN,
      ],
    });
    const none = await api.request(
      "/aurora/draft-advance-answers",
      post({ advance_recipient_id: RECIPIENT, inbound_message_id: MESSAGE }),
    );
    expect(none.status).toBe(422);
    expect(await none.text()).toContain("aurora_advance_no_open_sections");
    const forbidden = await api.request(
      "/aurora/draft-advance-answers",
      post({ advance_recipient_id: RECIPIENT, inbound_message_id: MESSAGE }),
    );
    expect(forbidden.status).toBe(404);
    expect(metered(calls)).toBe(false);
  });
});

const SCOPE = {
  recipient_id: RECIPIENT,
  packet_id: id(701),
  project_id: PROJECT,
  time_zone: "America/New_York",
  sections: [
    {
      id: SECTION,
      title: "Hospitality",
      prompt: "Needs.",
      kind: "Text",
      window_kind: null,
      max_lines: null,
      choices: [],
    },
  ],
};

const mailRow = (over: Record<string, unknown> = {}) => ({
  id: MESSAGE,
  purpose: "Project Inbox",
  inbound_status: "Verified",
  discarded_at: null,
  from_address: "a@example.com",
  body_text: "Hospitality: two cases of water.",
  inbound_address_id: ADDRESS,
  ...over,
});

describe("the source of drafted answers", () => {
  const draftFrom = async (row: Record<string, unknown>, address = PROJECT) => {
    const harness = app({
      "rpc:advance_draft_scope": [ok(SCOPE)],
      "from:inbound_messages": [ok([row])],
      "from:inbound_addresses": [ok([{ project_id: address }])],
    });
    const response = await harness.api.request(
      "/aurora/draft-advance-answers",
      post({ advance_recipient_id: RECIPIENT, inbound_message_id: MESSAGE }),
    );
    return { response, calls: harness.calls };
  };

  it.each([
    ["Received mail", mailRow({ inbound_status: "Received" }), "aurora_advance_source_unverified"],
    ["Rejected mail", mailRow({ inbound_status: "Rejected" }), "aurora_advance_source_unverified"],
    [
      "discarded mail",
      mailRow({ discarded_at: "2027-01-01T00:00:00Z" }),
      "aurora_advance_source_unverified",
    ],
    ["a reply", mailRow({ purpose: "Reply" }), "aurora_advance_source_unverified"],
    ["a blank body", mailRow({ body_text: "   " }), "aurora_advance_source_empty"],
  ])("refuses %s before metering", async (_name, row, rule) => {
    const { response, calls } = await draftFrom(row);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(rule);
    expect(metered(calls)).toBe(false);
  });

  it("answers 404 for another project's mail", async () => {
    const { response, calls } = await draftFrom(mailRow(), id(999));
    expect(response.status).toBe(404);
    expect(metered(calls)).toBe(false);
  });

  it("needs exactly one source", async () => {
    const { api } = app({});
    const both = await api.request(
      "/aurora/draft-advance-answers",
      post({
        advance_recipient_id: RECIPIENT,
        inbound_message_id: MESSAGE,
        media_type: "text/plain",
        content_base64: file("x"),
        file_name: "x.txt",
      }),
    );
    expect(both.status).toBe(422);
    const neither = await api.request(
      "/aurora/draft-advance-answers",
      post({ advance_recipient_id: RECIPIENT }),
    );
    expect(neither.status).toBe(422);
    expect(await neither.text()).toContain("aurora_advance_source_required");
  });

  it("drafts from verified mail, sends only the source and sections, and meters one request", async () => {
    const { api, calls, model } = app(
      {
        "rpc:advance_draft_scope": [ok(SCOPE)],
        "from:inbound_messages": [ok([mailRow()])],
        "from:inbound_addresses": [ok([{ project_id: PROJECT }])],
        "from:ai_never_send": [NEVER_SEND],
        ...answered(),
      },
      [
        tool("draft_advance_answers", {
          answers: [
            {
              section_id: SECTION,
              text: "Two cases of water.",
              source_excerpt: "Hospitality: two cases of water.",
              confidence: 0.9,
            },
          ],
          unanswered: [],
        }),
      ],
    );
    const response = await api.request(
      "/aurora/draft-advance-answers",
      post({ advance_recipient_id: RECIPIENT, inbound_message_id: MESSAGE }),
    );
    expect(response.status).toBe(200);
    await expectContract(response.clone(), "aurora.draftAdvanceAnswers");
    const body = (await response.json()) as {
      answer: { answers: { suggestion_id: string }[]; source: unknown };
    };
    expect(body.answer.answers[0]?.suggestion_id).toBe(id(801));
    expect(body.answer.source).toEqual({ kind: "Project Inbox", from_address: "a@example.com" });
    const content = model.requests[0]?.messages[0]?.content ?? [];
    expect(content[0]).toMatchObject({ type: "document", mediaType: "text/plain" });
    expect(JSON.stringify(content.slice(1))).not.toMatch(/roster/i);
    expect(calls.filter((c) => c.target === "rpc:ai_begin_request")).toHaveLength(1);
  });
});

describe("apply and preview meter nothing", () => {
  it.each([
    [
      "/aurora/apply-itinerary",
      "rpc:apply_itinerary_lines",
      { project_id: PROJECT, items: [{ suggestion_id: id(1), values: {} }] },
      { written: [], duplicates_checked: 0 },
    ],
    [
      "/aurora/apply-contract-intake",
      "rpc:apply_contract_intake",
      {
        project_id: PROJECT,
        items: [{ suggestion_ids: [id(1)], party: { counterparty_id: id(2) } }],
      },
      { engagements: [], riders: 0 },
    ],
    [
      "/aurora/apply-invoice-lines",
      "rpc:apply_invoice_line_suggestions",
      { invoice_id: id(3), items: [{ suggestion_id: id(1), values: {} }] },
      { written: [] },
    ],
    [
      "/aurora/apply-advance-answer",
      "rpc:record_drafted_advance_answer",
      { suggestion_id: id(1) },
      id(4),
    ],
  ])("%s", async (path, rpc, body, data) => {
    const { api, calls, model } = app({ [rpc]: [ok(data)] });
    const response = await api.request(path, post(body));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(calls.map((c) => c.target)).toEqual([rpc]);
    expect(model.requests).toHaveLength(0);
  });

  it("answers each apply in its documented shape", async () => {
    const { api } = app({
      "rpc:apply_itinerary_lines": [ok({ written: [], duplicates_checked: 0 })],
      "rpc:apply_contract_intake": [ok({ engagements: [], riders: 0 })],
      "rpc:apply_invoice_line_suggestions": [ok({ written: [] })],
      "rpc:record_drafted_advance_answer": [ok(id(4))],
    });
    const lines = await api.request(
      "/aurora/apply-itinerary",
      post({ project_id: PROJECT, items: [{ suggestion_id: id(1), values: {} }] }),
    );
    await expectContract(lines, "aurora.applyItinerary");
    const bookings = await api.request(
      "/aurora/apply-contract-intake",
      post({
        project_id: PROJECT,
        items: [{ suggestion_ids: [id(1)], party: { counterparty_id: id(2) } }],
      }),
    );
    await expectContract(bookings, "aurora.applyContractIntake");
    const invoice = await api.request(
      "/aurora/apply-invoice-lines",
      post({ invoice_id: id(3), items: [{ suggestion_id: id(1), values: {} }] }),
    );
    await expectContract(invoice, "aurora.applyInvoiceLines");
    const answer = await api.request(
      "/aurora/apply-advance-answer",
      post({ suggestion_id: id(1) }),
    );
    await expectContract(answer, "aurora.applyAdvanceAnswer");
  });

  it("names a refusal's rule", async () => {
    const { api } = app({
      "rpc:apply_contract_intake": [
        failure(
          "XR001",
          "aurora_fee_restricted: Line 1: Only someone who may read pay sets a fee.",
          "aurora_fee_restricted",
        ),
      ],
    });
    const response = await api.request(
      "/aurora/apply-contract-intake",
      post({
        project_id: PROJECT,
        items: [{ suggestion_ids: [id(1)], party: { counterparty_id: id(2) } }],
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("aurora_fee_restricted");
  });

  it("resumes a review without a model call, the fee left to row level security", async () => {
    const { api, calls, model } = app({
      "rpc:aurora_intake_scope": [
        ok({ project_id: PROJECT, fee_visible: false, can_write_riders: true }),
      ],
      "from:ai_requests": [ok([{ id: id(5) }])],
      "from:ai_suggestions": [
        ok([
          {
            id: id(6),
            request_id: id(5),
            operation_id: "engagements.createFromContract",
            target_id: null,
            summary: "Book.",
            expires_at: "2027-01-08T00:00:00.000Z",
          },
        ]),
      ],
      "from:ai_suggestion_fields": [
        ok([
          {
            suggestion_id: id(6),
            field_path: "act_name",
            proposed_value: "Owls",
            confidence: 0.9,
            refusal: null,
            missing: null,
            source_excerpt: "Owls",
          },
        ]),
      ],
    });
    const response = await api.request(
      `/aurora/open-proposals?project_id=${PROJECT}&operation_id=engagements.createFromContract`,
    );
    expect(response.status).toBe(200);
    await expectContract(response.clone(), "aurora.openProposals");
    expect(metered(calls)).toBe(false);
    expect(model.requests).toHaveLength(0);
  });
});

describe("governance drafts", () => {
  const draftBody = (kind: string, target?: unknown) => ({
    kind,
    instructions: "Draft it.",
    ...(target ? { target } : {}),
  });

  it("needs a Document record of the matching subtype", async () => {
    const { api, calls } = app({ "from:ai_never_send": [NEVER_SEND, NEVER_SEND, NEVER_SEND] });
    const none = await api.request("/aurora/draft", post(draftBody("event_plan")));
    expect(await none.text()).toContain("aurora_draft_target_required");
    const collection = await api.request(
      "/aurora/draft",
      post(draftBody("event_plan", { collection: "projects", id: PROJECT })),
    );
    expect(await collection.text()).toContain("aurora_draft_target_mismatch");
    const subtype = await api.request(
      "/aurora/draft",
      post(draftBody("event_brief", { collection: "records", id: RECORD })),
    );
    expect(await subtype.text()).toContain("aurora_draft_target_mismatch");
    expect(metered(calls)).toBe(false);
  });

  it("previews exactly what the draft sends: gate readiness, or objectives and measurements", async () => {
    const reads: string[] = [];
    const watching: PublicApi = {
      async get(path, query) {
        reads.push(path);
        return fixtureApi.get(path, query);
      },
    };
    const harness = app(
      {
        "from:ai_never_send": [NEVER_SEND, NEVER_SEND],
        "rpc:aurora_intake_scope": [ok({ project_id: PROJECT }), ok({ project_id: PROJECT })],
        ...answered(),
      },
      [tool("draft", { title: "Waste Plan", body: "Waste diverted: Unmeasured", gaps: [] })],
      watching,
    );
    const preview = await harness.api.request(
      "/aurora/preview",
      post({
        feature: "drafting",
        draft_kind: "waste_plan",
        target: { collection: "records", id: RECORD },
        items: [],
      }),
    );
    expect(preview.status, await preview.clone().text()).toBe(200);
    const records = ((await preview.json()) as { records: { collection: string }[] }).records.map(
      (r) => r.collection,
    );
    expect(records).toContain("project-objectives");
    expect(records).toContain("project-measurements");
    const previewReads = [...reads];
    reads.length = 0;
    expect(metered(harness.calls)).toBe(false);
    const draft = await harness.api.request(
      "/aurora/draft",
      post(draftBody("waste_plan", { collection: "records", id: RECORD })),
    );
    expect(draft.status, await draft.clone().text()).toBe(200);
    expect(reads.filter((r) => r !== "/verbiage-terms")).toEqual(
      previewReads.filter((r) => r !== "/verbiage-terms"),
    );
    expect(argsOf(harness.calls, "rpc:ai_begin_request")).toMatchObject({
      p_subject_table: "app.records",
      p_subject_id: RECORD,
    });
  });
});

describe("what a review reads", () => {
  it("offers an itinerary's travelers and live segments, names only", async () => {
    const { api, calls } = app({
      "rpc:aurora_intake_scope": [ok({ project_id: PROJECT })],
      "rpc:itinerary_traveler_candidates": [
        ok([
          { person_id: id(10), engagement_id: null, display_name: "Dana Kim", source: "Member" },
        ]),
      ],
      "from:travel_segments": [
        ok([
          { person_id: id(10), service_identifier: "GA 1", departs_at: "2027-01-08T00:00:00.000Z" },
        ]),
      ],
    });
    const response = await api.request(
      `/aurora/intake-options?kind=itinerary&project_id=${PROJECT}`,
    );
    expect(response.status).toBe(200);
    await expectContract(response, "aurora.intakeOptions");
    expect(metered(calls)).toBe(false);
  });

  it("offers a contract's parties and rate cards, with what the caller may do", async () => {
    const { api } = app({
      "rpc:aurora_intake_scope": [
        ok({ project_id: PROJECT, fee_visible: true, can_write_riders: false }),
      ],
      "rpc:contract_intake_options": [
        ok({
          parties: [{ kind: "counterparty", id: id(11), name: "Owls", engagement_ids: [] }],
          rate_cards: [],
        }),
      ],
    });
    const response = await api.request(
      `/aurora/intake-options?kind=contract&project_id=${PROJECT}`,
    );
    expect(response.status).toBe(200);
    const body = (await expectContract(response, "aurora.intakeOptions")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ fee_visible: true, can_write_riders: false });
  });

  it("answers 404 for a project the caller may not write to", async () => {
    const { api } = app({ "rpc:aurora_intake_scope": [FORBIDDEN] });
    const response = await api.request(
      `/aurora/intake-options?kind=contract&project_id=${PROJECT}`,
    );
    expect(response.status).toBe(404);
  });

  it("reads an invoice's open lines", async () => {
    const { api, calls } = app({ "from:ai_suggestions": [ok([])] });
    const response = await api.request(`/aurora/invoice-line-proposals?invoice_id=${id(12)}`);
    expect(response.status).toBe(200);
    await expectContract(response, "aurora.invoiceLineProposals");
    expect(metered(calls)).toBe(false);
  });
});

describe("generic confirm on an operation with no handler", () => {
  it.each(["travelSegments.create", "engagements.createFromContract", "advanceAnswers.record"])(
    "%s writes nothing, returns the rule and leaves the suggestion Proposed",
    async (operation) => {
      const suggestion = {
        id: id(20),
        org_id: ORG,
        request_id: id(21),
        operation_id: operation,
        target_id: null,
        summary: "Add it.",
        suggestion_state: "Proposed",
        expires_at: "2099-01-01T00:00:00.000Z",
        applied_id: null,
        created_at: T,
        created_by: ME,
        updated_at: T,
        updated_by: ME,
      };
      const { api, calls } = app({
        "from:ai_suggestions": [ok([suggestion]), ok([suggestion])],
        "from:ai_suggestion_fields": [ok([]), ok([])],
        "rpc:transition_ai_suggestion": [ok(id(22)), ok(id(23))],
      });
      const response = await api.request(
        `/ai-suggestions/${id(20)}/confirm`,
        post({ reason: "Yes." }),
      );
      expect(await response.clone().text()).toContain("ai_suggestion_operation_unavailable");
      const moves = calls.filter((c) => c.target === "rpc:transition_ai_suggestion");
      expect((moves[1]?.steps[0]?.[1] as Record<string, unknown>[])[0]).toMatchObject({
        p_next: "Proposed",
      });
    },
  );
});

describe("an invoice's tie-out and line history", () => {
  const INVOICE = id(30);
  const finance = (queues: Record<string, Response[]>) => {
    const fake = fakeDb(queues);
    return {
      api: contractApp({ handlers: [financeHandlers as never], db: fake.db as never }),
      calls: fake.calls,
    };
  };

  it("reads the tie-out, computed and never stored", async () => {
    const { api } = finance({
      "from:invoice_tie_out": [
        ok({
          invoice_id: INVOICE,
          printed_total_minor: 108000,
          computed_total_minor: 100000,
          residual_minor: 8000,
        }),
        ok(null),
      ],
    });
    const response = await api.request(`/invoices/${INVOICE}/tie-out`);
    expect(response.status).toBe(200);
    expect(await expectContract(response, "invoices.tieOut")).toMatchObject({
      residual_minor: 8000,
    });
    expect((await api.request(`/invoices/${INVOICE}/tie-out`)).status).toBe(404);
  });

  it("reads line history with no model call", async () => {
    const { api, calls } = finance({
      "rpc:vendor_line_history": [
        ok([
          {
            description_index: 1,
            description: "Stage labor",
            quantity: 2,
            unit_price_minor: 75000,
            currency_code: "USD",
            invoice_number: "INV-1",
            issued_on: "2027-01-01",
            budget_line_id: null,
            budget_line_name: null,
          },
        ]),
      ],
    });
    const response = await api.request(
      `/invoices/${INVOICE}/line-history`,
      post({ descriptions: ["Stage labor"] }),
    );
    expect(response.status).toBe(200);
    await expectContract(response, "invoices.lineHistory");
    expect(calls.map((c) => c.target)).toEqual(["rpc:vendor_line_history"]);
  });
});
