/**
 * Contract tests for A25's Aurora AI handlers (Section 18, gate 5; Section 4.7): the AI settings
 * switches, Aurora status and the seven feature operations, the suggestion confirmation step, the
 * request log and the usage ledger. Requests run through `contractApp`; every response is checked
 * against openapi/v1.json with `expectContract`. The database is a recording stand-in for
 * supabase-js and the model is a scripted client, so no test reaches a model provider.
 */
import type { ModelClient, ModelRequest, ModelResponse, PublicApi } from "@xos/ai";
import { describe, expect, it } from "vitest";
import { catalog } from "../src/app.ts";
import {
  auroraHandlers,
  bodyFromFields,
  filterFields,
  inProcessApi,
  proposableOperations,
  readableCollections,
} from "../src/handlers/parts/aurora.ts";
import { defineHandlers, type HandlerSet } from "../src/runtime/handler.ts";
import { NeverSendList } from "@xos/ai";
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
  constructor(private readonly script: (ModelResponse | Error)[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("The scripted model ran out of responses.");
    if (next instanceof Error) throw next;
    return next;
  }
}

const tool = (name: string, input: unknown, id = `tu_${name}`): ModelResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
  usage: { inputTokens: 120, outputTokens: 30 },
});

const ctx = testContext();
const ORG = ctx.org?.id as string;
const ME = ctx.personId as string;
const T = "2026-10-15T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string, message = "Refused."): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: ${message}`, hint: rule },
});
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: null,
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `a25-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const venue = {
  id: id(500),
  name: "Bayfront Amphitheater",
  rate_minor: { masked: true, reason: "Restricted" },
};
const fixtureApi: PublicApi = {
  async get(path) {
    if (path === "/venues") return { status: 200, body: { data: [venue], next_cursor: null } };
    if (path === `/venues/${venue.id}`) return { status: 200, body: venue };
    return { status: 404, body: {} };
  },
};

function app(queues: Record<string, Response[]>, script: (ModelResponse | Error)[] = []) {
  const fake = fakeDb(queues);
  const model = new Scripted(script);
  const handlers = defineHandlers(
    "Settings",
    auroraHandlers({
      model: () => model,
      readApi: () => fixtureApi,
      today: () => "2026-10-15",
    }) as unknown as HandlerSet<"Settings">,
  );
  return {
    api: contractApp({ handlers: [handlers], db: fake.db as never }),
    calls: fake.calls,
    model,
  };
}

const NEVER_SEND = ok([
  { table_name: "app.medical_encounters", column_name: null },
  { table_name: "app.venues", column_name: "rate_minor" },
]);
const begun = ok(id(900));
const done = ok(null);

describe("AI settings", () => {
  const row = {
    ...audit(1),
    assistant_enabled: true,
    plain_language_enabled: false,
    extraction_enabled: true,
    drafting_enabled: false,
    summaries_enabled: false,
    mapping_enabled: false,
  };

  it("lists, reads, updates and saves the switches", async () => {
    const { api, calls } = app({
      "from:ai_settings": [
        ok([row]),
        ok(row),
        ok(row),
        ok([{ id: row.id }]),
        ok(row),
        ok(null),
        ok([row]),
      ],
    });
    await expectContract(await api.request("/ai-settings"), "aiSettings.list");
    await expectContract(await api.request(`/ai-settings/${row.id}`), "aiSettings.get");
    const updated = await api.request(`/ai-settings/${row.id}`, {
      method: "PATCH",
      headers: { "If-Match": "*", "Content-Type": "application/json" },
      body: JSON.stringify({ summaries_enabled: true }),
    });
    await expectContract(updated, "aiSettings.update");
    const saved = await api.request(
      "/ai-settings/save",
      post({
        assistant_enabled: true,
        plain_language_enabled: false,
        extraction_enabled: true,
        drafting_enabled: false,
        summaries_enabled: false,
        mapping_enabled: false,
      }),
    );
    await expectContract(saved, "aiSettings.save");
    expect(calls.some((c) => c.steps.some(([m]) => m === "upsert"))).toBe(true);
  });

  it("returns the plan refusal when a feature is turned on without aurora_ai", async () => {
    const { api } = app({
      "from:ai_settings": [refusal("aurora_not_in_plan", "Aurora AI is not in this org's plan.")],
    });
    const res = await api.request(
      "/ai-settings/save",
      post({
        assistant_enabled: true,
        plain_language_enabled: false,
        extraction_enabled: false,
        drafting_enabled: false,
        summaries_enabled: false,
        mapping_enabled: false,
      }),
    );
    const body = (await expectContract(res, "aiSettings.save")) as { rule: string };
    expect(res.status).toBe(422);
    expect(body.rule).toBe("aurora_not_in_plan");
  });
});

describe("Aurora status and features", () => {
  it("reports enabled features and the allowance", async () => {
    const { api } = app({
      "rpc:ai_enabled_features": [ok(["extraction", "assistant"])],
      "rpc:ai_allowance": [ok([{ used: 12, allowance: 500, plan_includes_aurora: true }])],
    });
    const body = await expectContract(await api.request("/aurora/status"), "aurora.status");
    expect(body).toEqual({
      enabled_features: ["assistant", "extraction"],
      used: 12,
      allowance: 500,
      plan_includes_aurora: true,
    });
  });

  it("asks the assistant, reading through the API and citing what it read", async () => {
    const { api, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
      },
      [
        tool("list_records", { path: "venues" }),
        tool("answer", {
          text: "Bayfront Amphitheater is on file.",
          citations: [{ path: "venues", id: venue.id, label: "Bayfront" }],
        }),
      ],
    );
    const res = await api.request("/aurora/ask", post({ question: "Which venues do we have?" }));
    const body = (await expectContract(res, "aurora.ask")) as {
      outcome: string;
      ai_generated: boolean;
    };
    expect(body).toMatchObject({
      outcome: "answer",
      ai_generated: true,
      model: "claude-sonnet-5-5",
    });
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain("rate_minor");
  });

  it("refuses with the allowance rule when the month is used up", async () => {
    const { api } = app({
      "from:ai_never_send": [NEVER_SEND],
      "rpc:ai_begin_request": [
        refusal(
          "plan_limit_exceeded",
          "The plan allows 500 aurora_requests_per_month; this change needs 501.",
        ),
      ],
    });
    const res = await api.request("/aurora/ask", post({ question: "Anything?" }));
    const body = (await expectContract(res, "aurora.ask")) as { rule: string };
    expect(res.status).toBe(422);
    expect(body.rule).toBe("plan_limit_exceeded");
  });

  it("logs a failed model call and answers outcome failed", async () => {
    const { api, calls } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
      },
      [new Error("overloaded")],
    );
    const body = await expectContract(
      await api.request("/aurora/ask", post({ question: "Hi" })),
      "aurora.ask",
    );
    expect(body).toMatchObject({ outcome: "failed", failure_code: "model_error" });
    expect(calls.find((c) => c.target === "rpc:ai_complete_request")?.steps[0]?.[1]).toEqual([
      expect.objectContaining({ p_outcome: "Failed", p_failure_code: "model_error" }),
    ]);
  });

  it("builds a filter on a collection's real fields and proposes a saved view", async () => {
    const venues = catalog.find((s) => s.path === "/venues");
    const field = venues
      ? filterFields(venues).find((f) => f.type === "string" && f.name === "name")
      : undefined;
    expect(field).toBeDefined();
    const { api } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
        "rpc:ai_propose_suggestion": [ok(id(700))],
      },
      [
        tool("build_filter", {
          collection: "venues",
          name: "Bayfront Venues",
          conditions: [{ field: "name", op: "contains", value: "Bayfront" }],
          sort: [],
        }),
      ],
    );
    const res = await api.request(
      "/aurora/filter",
      post({
        sentence: "venues named Bayfront",
        collections: ["venues"],
        time_zone: "America/New_York",
      }),
    );
    const body = (await expectContract(res, "aurora.filter")) as {
      suggestions: { operation_id: string }[];
    };
    expect(body.suggestions[0]?.operation_id).toBe("savedViews.create");
  });

  it("extracts a document into proposed fields", async () => {
    const { api } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
        "rpc:ai_propose_suggestion": [ok(id(701))],
      },
      [
        tool("record_fields", {
          fields: [
            {
              field_path: "description",
              value: "Gaffer tape",
              confidence: 0.9,
              source_excerpt: "Gaffer tape",
              missing: null,
            },
            {
              field_path: "amount_minor",
              value: 8994,
              confidence: 0.9,
              source_excerpt: "TOTAL USD 89.94",
              missing: null,
            },
            {
              field_path: "currency",
              value: "USD",
              confidence: 0.9,
              source_excerpt: "USD",
              missing: null,
            },
            {
              field_path: "incurred_on",
              value: "2026-10-03",
              confidence: 0.9,
              source_excerpt: "10/03/2026",
              missing: null,
            },
          ],
        }),
      ],
    );
    const res = await api.request(
      "/aurora/extract",
      post({
        kind: "receipt",
        document_id: id(800),
        media_type: "text/plain",
        content_base64: Buffer.from(
          "HARBOR HARDWARE 10/03/2026 Gaffer tape TOTAL USD 89.94",
        ).toString("base64"),
        file_name: "receipt.txt",
      }),
    );
    const body = (await expectContract(res, "aurora.extract")) as { answer: { answered: number } };
    expect(body.answer.answered).toBe(4);
  });

  it("drafts from records read through the API", async () => {
    const { api } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
      },
      [tool("draft", { title: "Load-In Procedure", body: "1. Stage at the Dock.", gaps: [] })],
    );
    const res = await api.request(
      "/aurora/draft",
      post({
        kind: "sop",
        instructions: "Write the load-in SOP.",
        context: [
          { collection: "venues", id: venue.id },
          { collection: "nowhere", id: id(1) },
        ],
      }),
    );
    await expectContract(res, "aurora.draft");
  });

  it("summarizes items and answers NO ANSWER without a model call when nothing is readable", async () => {
    const first = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
      },
      [
        tool("summary", {
          headline: "Venue on file",
          bullets: [{ text: "Bayfront is on file.", citations: [venue.id] }],
        }),
      ],
    );
    const body = {
      kind: "project_week",
      subject_collection: "projects",
      subject_id: id(2),
      items: [{ collection: "venues", id: venue.id }],
    };
    await expectContract(
      await first.api.request("/aurora/summarize", post(body)),
      "aurora.summarize",
    );
    const empty = app({ "from:ai_never_send": [NEVER_SEND] });
    const res = await empty.api.request(
      "/aurora/summarize",
      post({ ...body, items: [{ collection: "venues", id: id(3) }] }),
    );
    expect(await expectContract(res, "aurora.summarize")).toMatchObject({
      outcome: "no_answer",
      request_id: null,
    });
  });

  it("suggests column mappings and catalog bindings", async () => {
    const { api } = app(
      {
        "from:ai_never_send": [NEVER_SEND, NEVER_SEND],
        "rpc:ai_begin_request": [begun, begun],
        "rpc:ai_complete_request": [done, done],
        "rpc:ai_propose_suggestion": [ok(id(702))],
      },
      [
        tool("map_columns", { mappings: [{ column: "E-mail", field: "email", confidence: 0.9 }] }),
        tool("bind_code", {
          element_id: "9000.02.03-NWL-0001",
          confidence: 0.8,
          reason: "LED panel.",
        }),
      ],
    );
    const mapped = await api.request(
      "/aurora/map-columns",
      post({
        collection: "people",
        columns: [{ header: "E-mail", samples: ["crew@example.com"] }],
        fields: [{ name: "email", description: "Email." }],
      }),
    );
    await expectContract(mapped, "aurora.mapColumns");
    const bound = await api.request(
      "/aurora/bind-code",
      post({
        code: "0012345678905",
        description: "LED PANEL",
        candidates: [
          { element_id: "9000.02.03-NWL-0001", name: "LED Wall Panel", urid: "9000.02.03" },
        ],
      }),
    );
    await expectContract(bound, "aurora.bindCode");
  });
});

describe("suggestions, requests and usage", () => {
  const suggestion = {
    ...audit(10),
    request_id: id(900),
    operation_id: "expenses.create",
    target_id: null,
    summary: "Create a receipt record from the extracted document.",
    suggestion_state: "Proposed",
    expires_at: T,
    applied_id: null,
  };
  const field = {
    field_path: "amount_minor",
    proposed_value: 8994,
    confidence: "0.900",
    refusal: null,
    missing: null,
    source_excerpt: "TOTAL USD 89.94",
    position: 0,
  };

  it("lists and reads suggestions with their fields and provenance agent", async () => {
    const { api } = app({
      "from:ai_suggestions": [ok([suggestion]), ok(suggestion)],
      "from:ai_suggestion_fields": [ok([field]), ok([field])],
    });
    const listed = await api.request("/ai-suggestions");
    const page = (await expectContract(listed, "aiSuggestions.list")) as {
      data: { proposed_fields: { provenance: string; confidence: number }[] }[];
    };
    expect(page.data[0]?.proposed_fields[0]).toMatchObject({
      provenance: "agent",
      confidence: 0.9,
    });
    await expectContract(
      await api.request(`/ai-suggestions/${suggestion.id}`),
      "aiSuggestions.get",
    );
  });

  it("applies, reopens and rejects through the transition RPC", async () => {
    const read = [ok(suggestion), ok(suggestion)];
    const fields = [ok([field]), ok([field])];
    const { api, calls } = app({
      "from:ai_suggestions": [...read, ...read, ...read],
      "from:ai_suggestion_fields": [...fields, ...fields, ...fields],
      "rpc:transition_ai_suggestion": [ok(id(2)), ok(id(3)), ok(id(4))],
    });
    const item = `/ai-suggestions/${suggestion.id}`;
    const applied = await api.request(
      `${item}/apply`,
      post({ applied_id: id(55), reason: "Written by expenses.create." }),
    );
    await expectContract(applied, "aiSuggestions.apply");
    const reopened = await api.request(`${item}/reopen`, post({ reason: "budget_line_closed" }));
    await expectContract(reopened, "aiSuggestions.reopen");
    const rejected = await api.request(`${item}/reject`, post({ reason: "Wrong receipt." }));
    await expectContract(rejected, "aiSuggestions.reject");
    const rpcs = calls
      .filter((c) => c.target === "rpc:transition_ai_suggestion")
      .map((c) => c.steps[0]?.[1]?.[0]);
    expect(rpcs[0]).toMatchObject({
      p_expected: "Confirmed",
      p_next: "Applied",
      p_applied_id: id(55),
    });
    expect(rpcs[2]).toMatchObject({ p_expected: "Proposed", p_next: "Rejected" });
  });

  it("confirms and performs the operation as the caller, then marks it Applied", async () => {
    const settingsRow = {
      ...audit(40),
      assistant_enabled: true,
      plain_language_enabled: false,
      extraction_enabled: false,
      drafting_enabled: false,
      summaries_enabled: true,
      mapping_enabled: false,
    };
    const proposal = {
      ...suggestion,
      operation_id: "aiSettings.update",
      target_id: settingsRow.id,
    };
    const switchField = {
      ...field,
      field_path: "summaries_enabled",
      proposed_value: true,
      confidence: "1.000",
    };
    const { api, calls } = app({
      "from:ai_suggestions": [
        ok(proposal),
        ok({ ...proposal, suggestion_state: "Applied", applied_id: settingsRow.id }),
      ],
      "from:ai_suggestion_fields": [ok([switchField]), ok([switchField])],
      "rpc:transition_ai_suggestion": [ok(id(5)), ok(id(6))],
      "from:ai_settings": [ok(settingsRow), ok([{ id: settingsRow.id }]), ok(settingsRow)],
    });
    const res = await api.request(
      `/ai-suggestions/${proposal.id}/confirm`,
      post({ reason: "Turn summaries on.", values: { assistant_enabled: true } }),
    );
    const body = (await expectContract(res, "aiSuggestions.confirm")) as {
      suggestion_state: string;
    };
    expect(body.suggestion_state).toBe("Applied");
    const update = calls.filter((c) => c.target === "from:ai_settings")[1];
    expect(update?.steps.find(([m]) => m === "update")?.[1]).toEqual([
      { summaries_enabled: true, assistant_enabled: true },
    ]);
    const moves = calls
      .filter((c) => c.target === "rpc:transition_ai_suggestion")
      .map((c) => c.steps[0]?.[1]?.[0]);
    expect(moves[1]).toMatchObject({ p_next: "Applied", p_applied_id: settingsRow.id });
  });

  it("returns the suggestion to Proposed and answers the refusal when the operation is unavailable", async () => {
    const proposal = { ...suggestion, operation_id: "marshallingLogEntries.create" };
    const { api, calls } = app({
      "from:ai_suggestions": [ok(proposal)],
      "from:ai_suggestion_fields": [ok([field])],
      "rpc:transition_ai_suggestion": [ok(id(7)), ok(id(8))],
    });
    const res = await api.request(
      `/ai-suggestions/${proposal.id}/confirm`,
      post({ reason: "Yes." }),
    );
    const body = (await expectContract(res, "aiSuggestions.confirm")) as { rule: string };
    expect(res.status).toBe(422);
    expect(body.rule).toBe("ai_suggestion_operation_unavailable");
    const moves = calls
      .filter((c) => c.target === "rpc:transition_ai_suggestion")
      .map((c) => c.steps[0]?.[1]?.[0]);
    expect(moves[1]).toMatchObject({ p_expected: "Confirmed", p_next: "Proposed" });
  });

  it("refuses confirmation of an expired suggestion", async () => {
    const { api } = app({
      "from:ai_suggestions": [ok(suggestion)],
      "from:ai_suggestion_fields": [ok([field])],
      "rpc:transition_ai_suggestion": [
        refusal("ai_suggestion_expired", "This suggestion has expired."),
      ],
    });
    const res = await api.request(
      `/ai-suggestions/${suggestion.id}/confirm`,
      post({ reason: "Late." }),
    );
    expect(res.status).toBe(422);
    await expectContract(res, "aiSuggestions.confirm");
  });

  it("nests dotted field paths into the request body", () => {
    expect(
      bodyFromFields(
        [
          { field_path: "insurance.expires_on", proposed_value: "2027-03-31", refusal: null },
          { field_path: "limit_minor", proposed_value: null, refusal: "NO_ANSWER" },
        ],
        { "insurance.carrier": "Atlantic Mutual" },
      ),
    ).toEqual({ insurance: { expires_on: "2027-03-31", carrier: "Atlantic Mutual" } });
  });

  it("reads the request log and the usage ledger", async () => {
    const request = {
      ...audit(20),
      person_id: ME,
      feature: "assistant",
      model: "claude-sonnet-5-5",
      subject_table: null,
      subject_id: null,
      outcome: "Answered",
      prompt_redacted: "Who is the contact? [email]",
      output_redacted: "Ivy Chen, [phone].",
      failure_code: null,
      completed_at: T,
    };
    const meter = {
      ...audit(30),
      request_id: request.id,
      metered_at: T,
      input_tokens: 812,
      output_tokens: 96,
    };
    const { api } = app({
      "from:ai_requests": [ok([request]), ok(request)],
      "from:ai_usage": [ok([meter])],
    });
    await expectContract(await api.request("/ai-requests"), "aiRequests.list");
    await expectContract(await api.request(`/ai-requests/${request.id}`), "aiRequests.get");
    await expectContract(await api.request("/ai-usage"), "aiUsage.list");
  });
});

describe("Aurora helpers", () => {
  const neverSend = new NeverSendList([{ table: "app.venues", column: null }]);

  it("reads only list collections outside Aurora's own and excluded tables", () => {
    const paths = readableCollections(catalog, neverSend).map((c) => c.path);
    expect(paths).not.toContain("venues");
    expect(paths).not.toContain("ai-requests");
    expect(paths).toContain("projects");
    const ops = proposableOperations(catalog);
    expect(ops).toContain("projects.create");
    expect(ops.some((o) => o.startsWith("aiSettings"))).toBe(false);
  });

  it("calls this API's own handlers in process and maps problems to statuses", async () => {
    const venues = catalog.filter((s) => s.path === "/venues" || s.path === "/projects");
    const api = inProcessApi(
      testContext({ db: fakeDb({ "from:venues": [ok(null)] }).db as never }),
      venues,
    );
    expect((await api.get("/nowhere", {})).status).toBe(404);
    expect((await api.get(`/venues/${id(9)}`, {})).status).toBe(404);
  });
});
