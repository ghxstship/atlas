/**
 * P6 drafted lists (RRR-220, parity gap G-83; Section 4.7): `aurora.draft` drafts a run of show or a
 * risk assessment only into an empty list it names, refusing before any model call or metering, its
 * preview lists exactly the records the draft sends, each drafted line carries its suggestion, and
 * `aurora.applyDraft` adds the kept lines in one step. Requests run through `contractApp` and every
 * response is checked against openapi/v1.json. The database is a recording stand-in and the model a
 * scripted client, so nothing reaches a model provider.
 */
import type { ModelClient, ModelRequest, ModelResponse, PublicApi } from "@xos/ai";
import { describe, expect, it } from "vitest";
import { auroraHandlers, listTarget } from "../src/handlers/parts/aurora.ts";
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
const T = "2026-10-15T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const failure = (code: string, message: string, hint?: string): Response => ({
  data: null,
  error: { code, message, ...(hint ? { hint } : {}) },
});

const RUN = id(100);
const PROJECT = id(200);
const EVENT = id(300);
const OTHER_EVENT = id(301);
const VENUE = id(400);

const run = {
  id: RUN,
  name: "Opening Night",
  show_date: "2027-06-05",
  project_id: PROJECT,
  record_id: EVENT,
};
const project = { id: PROJECT, name: "Bayfront Summer Series", time_zone: "America/Chicago" };
const event = {
  id: EVENT,
  record_kind: "Event",
  record_subtype: "Concert",
  title: "Opening Night",
};
const otherEvent = {
  id: OTHER_EVENT,
  record_kind: "Event",
  record_subtype: "Festival",
  title: "Day Two",
};
const venue = {
  id: VENUE,
  name: "Bayfront Amphitheater",
  rate_minor: { masked: true, reason: "Restricted" },
  is_masked: true,
};

const fixtureApi: PublicApi = {
  async get(path, query) {
    if (path === `/run-of-show/${RUN}`) return { status: 200, body: run };
    if (path === `/projects/${PROJECT}`) return { status: 200, body: project };
    if (path === `/records/${EVENT}`) return { status: 200, body: event };
    if (path === `/venues/${VENUE}`) return { status: 200, body: venue };
    if (path === "/records" && query["filter[project_id][eq]"] === PROJECT) {
      return { status: 200, body: { data: [event, otherEvent], next_cursor: null } };
    }
    if (path === "/verbiage-terms") {
      return { status: 200, body: { data: [{ term: "Dock", casing_rule: "Title Case" }] } };
    }
    return { status: 404, body: {} };
  },
};

const NEVER_SEND = ok([
  { table_name: "app.medical_encounters", column_name: null },
  { table_name: "app.venues", column_name: "rate_minor" },
]);
const RISK_SUBTYPES = ok(
  ["Operational", "Commercial", "Safety", "Reputational", "Schedule"].map((record_subtype, i) => ({
    record_subtype,
    ordinal: 89 + i,
  })),
);

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `p6-lists-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>, script: ModelResponse[] = []) {
  const fake = fakeDb(queues);
  const model = new Scripted(script);
  const handlers = defineHandlers(
    "Settings",
    auroraHandlers({
      model: () => model,
      readApi: () => fixtureApi,
      today: () => "2026-10-15",
      timeZone: () => "America/New_York",
    }) as unknown as HandlerSet<"Settings">,
  );
  return {
    api: contractApp({ handlers: [handlers], db: fake.db as never }),
    calls: fake.calls,
    model,
  };
}

/** The records a model request carried in its context block. */
function sentRecords(request: ModelRequest | undefined): { id: string; table: string }[] {
  const block = request?.messages[0]?.content.find(
    (c) => c.type === "text" && c.text.startsWith('<data source="context records">'),
  );
  if (!block || block.type !== "text") return [];
  const body = block.text.slice(block.text.indexOf("\n") + 1, block.text.lastIndexOf("\n</data>"));
  return (JSON.parse(body) as { id: string; table: string }[]).map((r) => ({
    id: r.id,
    table: r.table,
  }));
}

const runDraft = {
  kind: "run_of_show",
  instructions: "Draft the running order for opening night.",
  target: { collection: "run-of-show", id: RUN },
  context: [
    { collection: "projects", id: PROJECT },
    { collection: "venues", id: VENUE },
  ],
};

const runLines = tool("draft_run_of_show", {
  title: "Opening Night",
  lines: [
    { label: "Headliner", local_time: "21:00", duration_minutes: 90 },
    { label: "Doors", local_time: "19:00", duration_minutes: 60 },
  ],
  gaps: [],
});

describe("drafting into a list", () => {
  it("refuses a list kind without a target, or with one of another kind, before anything else", async () => {
    const { api, calls, model } = app({});
    const missing = await api.request("/aurora/draft", post({ ...runDraft, target: undefined }));
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ rule: "aurora_draft_target_required" });
    const mismatch = await api.request(
      "/aurora/draft",
      post({ ...runDraft, target: { collection: "projects", id: PROJECT } }),
    );
    expect(await mismatch.json()).toMatchObject({ rule: "aurora_draft_target_mismatch" });
    expect(calls).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
    expect(() => listTarget("risk_assessment", { collection: "run-of-show", id: RUN })).toThrow(
      /risk assessment is drafted into projects/,
    );
  });

  it("refuses a list with entries, and a caller who may not write to it, without a model call or metering", async () => {
    const { api, calls, model } = app({
      "from:ai_never_send": [NEVER_SEND, NEVER_SEND],
      "rpc:drafted_list_is_empty": [
        ok(false),
        failure("42501", "drafting a run of show needs show.run_of_show.write"),
      ],
    });
    const filled = await api.request("/aurora/draft", post(runDraft));
    expect(filled.status).toBe(422);
    expect(await filled.json()).toMatchObject({
      rule: "aurora_draft_list_not_empty",
      detail: "This running order already has cues. Aurora only drafts into an empty list.",
    });
    const forbidden = await api.request("/aurora/draft", post(runDraft));
    expect(forbidden.status).toBe(404);
    expect(calls.filter((c) => c.target === "rpc:drafted_list_is_empty")[0]?.steps[0]?.[1]).toEqual(
      [{ p_kind: "run_of_show", p_target_id: RUN }],
    );
    expect(calls.some((c) => c.target === "rpc:ai_begin_request")).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it("drafts a run of show about the running order, its lines carrying their suggestions", async () => {
    const { api, calls, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:drafted_list_is_empty": [ok(true)],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(701)), ok(id(702))],
      },
      [runLines],
    );
    const res = await api.request("/aurora/draft", post(runDraft));
    const body = (await expectContract(res, "aurora.draft")) as {
      answer: {
        kind: string;
        items: { suggestion_id: string; position: number; label: string; planned_at: string }[];
        flags: unknown[];
      };
      suggestions: { suggestion_id: string; operation_id: string; summary: string }[];
    };
    expect(body.answer.kind).toBe("run_of_show");
    expect(body.answer.items.map((i) => [i.suggestion_id, i.position, i.label])).toEqual([
      [id(701), 1, "Doors"],
      [id(702), 2, "Headliner"],
    ]);
    // The project's zone sets the instant: 19:00 in Chicago on the show day.
    expect(body.answer.items[0]?.planned_at).toBe("2027-06-06T00:00:00.000Z");
    expect(body.answer.flags).toEqual([{ type: "gap", positions: [1, 2], minutes: 60 }]);
    expect(body.suggestions.map((s) => s.operation_id)).toEqual(["cues.create", "cues.create"]);
    expect(
      calls.find((c) => c.target === "rpc:ai_begin_request")?.steps[0]?.[1]?.[0],
    ).toMatchObject({
      p_org_id: ORG,
      p_feature: "drafting",
      p_subject_table: "app.run_of_show",
      p_subject_id: RUN,
    });
    expect(model.requests[0]?.system).toContain("2027-06-05 in the America/Chicago time zone");
    const sent = JSON.stringify(model.requests[0]?.messages);
    expect(sent).not.toContain("rate_minor");
    expect(ME).toBeTruthy();
  });

  it("previews exactly the records the drafted run of show sends", async () => {
    const first = app({ "from:ai_never_send": [NEVER_SEND] });
    const preview = await first.api.request(
      "/aurora/preview",
      post({
        feature: "drafting",
        draft_kind: "run_of_show",
        target: runDraft.target,
        items: runDraft.context,
      }),
    );
    const shown = (await expectContract(preview, "aurora.preview")) as {
      records: { collection: string; id: string; sent: boolean; withheld: string[] }[];
      vocabulary_terms: number;
      categories?: string[];
    };
    expect(shown.records.map((r) => [r.collection, r.id])).toEqual([
      ["run-of-show", RUN],
      ["projects", PROJECT],
      ["records", EVENT],
      ["venues", VENUE],
    ]);
    expect(shown.records[3]?.withheld).toEqual(["rate_minor"]);
    expect(shown.vocabulary_terms).toBe(1);
    expect(shown.categories).toBeUndefined();
    expect(first.model.requests).toHaveLength(0);

    const second = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:drafted_list_is_empty": [ok(true)],
        "rpc:ai_begin_request": [ok(id(900))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(701)), ok(id(702))],
      },
      [runLines],
    );
    await expectContract(await second.api.request("/aurora/draft", post(runDraft)), "aurora.draft");
    expect(sentRecords(second.model.requests[0]).map((r) => r.id)).toEqual(
      shown.records.filter((r) => r.sent).map((r) => r.id),
    );
  });

  it("drafts a risk assessment in the canon categories, previewing the project's events and the categories", async () => {
    const riskDraft = {
      kind: "risk_assessment",
      instructions: "Assess the series.",
      target: { collection: "projects", id: PROJECT },
    };
    const { api, calls, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND, NEVER_SEND],
        "from:dim_record_subtype": [RISK_SUBTYPES, RISK_SUBTYPES],
        "rpc:drafted_list_is_empty": [ok(true)],
        "rpc:ai_begin_request": [ok(id(901))],
        "rpc:ai_complete_request": [ok(null)],
        "rpc:ai_propose_suggestion": [ok(id(801))],
      },
      [
        tool("draft_risks", {
          title: "Series Risks",
          lines: [
            {
              title: "Crowd Surge at the Barricade",
              category: "Safety",
              likelihood: 2,
              impact: 5,
              mitigation: "Staff the barricade.",
            },
            { title: "Hail", category: "Weather", likelihood: 1, impact: 1, mitigation: "Cover." },
          ],
          gaps: [],
        }),
      ],
    );
    const preview = (await expectContract(
      await api.request(
        "/aurora/preview",
        post({
          feature: "drafting",
          draft_kind: "risk_assessment",
          target: riskDraft.target,
          items: [],
        }),
      ),
      "aurora.preview",
    )) as { records: { collection: string; id: string }[]; categories: string[] };
    expect(preview.records.map((r) => r.id)).toEqual([PROJECT, EVENT, OTHER_EVENT]);
    expect(preview.categories).toEqual([
      "Operational",
      "Commercial",
      "Safety",
      "Reputational",
      "Schedule",
    ]);
    const res = await api.request("/aurora/draft", post(riskDraft));
    const body = (await expectContract(res, "aurora.draft")) as {
      answer: {
        items: { suggestion_id: string; title: string; category: string }[];
        dropped: { line: number; reason: string }[];
        categories: string[];
      };
    };
    expect(body.answer.items).toEqual([
      expect.objectContaining({ suggestion_id: id(801), title: "Crowd Surge at the Barricade" }),
    ]);
    expect(body.answer.dropped).toEqual([{ line: 2, reason: "category" }]);
    expect(body.answer.categories).toHaveLength(5);
    expect(sentRecords(model.requests[0]).map((r) => r.id)).toEqual(
      preview.records.map((r) => r.id),
    );
    const proposal = calls.find((c) => c.target === "rpc:ai_propose_suggestion")
      ?.steps[0]?.[1]?.[0] as {
      p_operation_id: string;
      p_fields: { field_path: string }[];
    };
    expect(proposal.p_operation_id).toBe("records.create");
    expect(proposal.p_fields.map((f) => f.field_path)).toEqual([
      "record_kind",
      "record_subtype",
      "title",
      "risk.likelihood",
      "risk.impact",
      "risk.mitigation",
    ]);
    expect(calls.find((c) => c.target === "rpc:drafted_list_is_empty")?.steps[0]?.[1]).toEqual([
      { p_kind: "risk_assessment", p_target_id: PROJECT },
    ]);
  });
});

describe("applying a drafted list", () => {
  it("adds the kept lines in one call and answers what was written", async () => {
    const written = { written: [{ suggestion_id: id(701), id: id(1001) }], rejected: 1 };
    const { api, calls, model } = app({ "rpc:apply_drafted_list": [ok(written)] });
    const res = await api.request(
      "/aurora/apply-draft",
      post({
        request_id: id(900),
        items: [{ suggestion_id: id(701), values: { label: "Doors Open" } }],
      }),
    );
    expect(await expectContract(res, "aurora.applyDraft")).toEqual(written);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        p_request_id: id(900),
        p_items: [{ suggestion_id: id(701), values: { label: "Doors Open" } }],
      },
    ]);
    expect(model.requests).toHaveLength(0);
  });

  it("answers a filled list, a refused line and a foreign request as problems", async () => {
    const { api } = app({
      "rpc:apply_drafted_list": [
        failure(
          "XR001",
          "aurora_draft_list_not_empty: This running order already has cues. Aurora only drafts into an empty list.",
          "aurora_draft_list_not_empty",
        ),
        failure(
          "XR001",
          "record_title_grammar: Line 2: A Risk title is a noun phrase naming the thing.",
          "record_title_grammar",
        ),
        failure("42501", "only the person who asked confirms a drafted list"),
      ],
    });
    const body = post({ request_id: id(900), items: [{ suggestion_id: id(701) }] });
    const filled = await api.request("/aurora/apply-draft", body);
    expect(filled.status).toBe(422);
    expect(await filled.json()).toMatchObject({ rule: "aurora_draft_list_not_empty" });
    const line = await api.request(
      "/aurora/apply-draft",
      post({ request_id: id(900), items: [{ suggestion_id: id(701) }] }),
    );
    expect(await line.json()).toMatchObject({
      rule: "record_title_grammar",
      detail: "Line 2: A Risk title is a noun phrase naming the thing.",
    });
    const foreign = await api.request(
      "/aurora/apply-draft",
      post({ request_id: id(900), items: [{ suggestion_id: id(701) }] }),
    );
    expect(foreign.status).toBe(404);
  });

  it("refuses more than 60 lines in the request shape", async () => {
    const { api } = app({});
    const res = await api.request(
      "/aurora/apply-draft",
      post({
        request_id: id(900),
        items: Array.from({ length: 61 }, (_, i) => ({ suggestion_id: id(2000 + i) })),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("surfaces the database refusal when one drafted line is confirmed on its own", async () => {
    const suggestion = {
      id: id(701),
      org_id: ORG,
      created_at: T,
      created_by: ME,
      updated_at: T,
      updated_by: null,
      request_id: id(900),
      operation_id: "cues.create",
      target_id: null,
      summary: "Add cue 1: Doors",
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
          "ai_suggestion_drafted_list: Confirm a drafted list as a whole so it only fills an empty list.",
          "ai_suggestion_drafted_list",
        ),
      ],
    });
    const res = await api.request(
      `/ai-suggestions/${id(701)}/confirm`,
      post({ reason: "One line." }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ rule: "ai_suggestion_drafted_list" });
  });
});
