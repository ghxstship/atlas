/**
 * A95 additions to the Aurora handlers (finding A65-020, Section 4.7): the preview every entry point
 * shows before it sends, a plain-language filter over a page's own filters, the org's verbiage
 * library in drafts, gate readiness in gate summaries, and relative dates on the org's calendar
 * (locale.time_zone), never UTC. The database is a recording stand-in and the model a scripted
 * client, so nothing reaches a model provider.
 */
import type { ModelClient, ModelRequest, ModelResponse, PublicApi } from "@xos/ai";
import { NeverSendList } from "@xos/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog } from "../src/app.ts";
import {
  auroraHandlers,
  inProcessApi,
  pageFilterFields,
  previewRecords,
  type AuroraDeps,
} from "../src/handlers/parts/aurora.ts";
import { defineHandlers, type HandlerSet } from "../src/runtime/handler.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";

type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };

function fakeDb(queues: Record<string, Response[]>) {
  const take = (key: string): Response => {
    const next = queues[key]?.shift();
    if (!next) throw new Error(`no queued response for ${key}`);
    return next;
  };
  const builder = (key: string) => {
    const response = take(key);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (r: Response) => unknown) => resolve(response);
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  const db: Record<string, unknown> = {
    from: (table: string) => builder(`from:${table}`),
    rpc: (name: string) => builder(`rpc:${name}`),
  };
  db["schema"] = () => db;
  return db;
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
  usage: { inputTokens: 100, outputTokens: 20 },
});

const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const NEVER_SEND = ok([
  { table_name: "app.medical_encounters", column_name: null },
  { table_name: "app.invoices", column_name: "bank_reference" },
]);
const begun = ok(id(900));
const done = ok(null);

const venue = {
  id: id(500),
  name: "Bayfront Amphitheater",
  rate_minor: { masked: true, reason: "Restricted" },
  is_masked: true,
};
const PROJECT = id(600);
const fixtureApi: PublicApi = {
  async get(path) {
    if (path === `/venues/${venue.id}`) return { status: 200, body: venue };
    if (path === "/verbiage-terms") {
      return {
        status: 200,
        body: {
          data: [
            { term: "Dock", casing_rule: "Title Case", definition: "The loading area." },
            { casing_rule: "no term" },
          ],
        },
      };
    }
    if (path === `/projects/${PROJECT}/gate-readiness`) {
      return {
        status: 200,
        body: {
          data: [
            {
              project_id: PROJECT,
              gate: 2,
              criterion_id: "G2.BUDGET_ENVELOPE",
              blocking: true,
              satisfied: false,
            },
          ],
          next_cursor: null,
        },
      };
    }
    return { status: 404, body: {} };
  },
};

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `a95-aurora-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(
  queues: Record<string, Response[]>,
  script: ModelResponse[] = [],
  deps: Partial<AuroraDeps> = { today: () => "2026-10-20", timeZone: () => "America/New_York" },
) {
  const model = new Scripted(script);
  const handlers = defineHandlers(
    "Settings",
    auroraHandlers({
      model: () => model,
      readApi: () => fixtureApi,
      ...deps,
    }) as unknown as HandlerSet<"Settings">,
  );
  return { api: contractApp({ handlers: [handlers], db: fakeDb(queues) as never }), model };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("preview of what a request sends", () => {
  it("shows each draft record as scrubbed, the unreadable ones as not sent, and the vocabulary", async () => {
    const { api, model } = app({ "from:ai_never_send": [NEVER_SEND] });
    const res = await api.request(
      "/aurora/preview",
      post({
        feature: "drafting",
        items: [
          { collection: "venues", id: venue.id },
          { collection: "venues", id: id(1) },
        ],
      }),
    );
    const body = (await expectContract(res, "aurora.preview")) as {
      records: { id: string; sent: boolean; fields: string[]; withheld: string[]; data: unknown }[];
      vocabulary_terms: number;
    };
    expect(body.records[0]).toEqual({
      collection: "venues",
      id: venue.id,
      sent: true,
      fields: ["id", "name"],
      withheld: ["rate_minor"],
      data: { id: venue.id, name: "Bayfront Amphitheater" },
    });
    expect(body.records[1]).toMatchObject({ id: id(1), sent: false, data: null });
    expect(body.vocabulary_terms).toBe(1);
    // A preview calls no model and meters nothing: no ai_begin_request was queued.
    expect(model.requests).toHaveLength(0);
  });

  it("adds the next gate's criteria to a gate readiness summary", async () => {
    const { api } = app({ "from:ai_never_send": [NEVER_SEND] });
    const res = await api.request(
      "/aurora/preview",
      post({
        feature: "summaries",
        kind: "gate_readiness",
        subject_collection: "projects",
        subject_id: PROJECT,
        items: [],
      }),
    );
    const body = (await expectContract(res, "aurora.preview")) as {
      records: { collection: string; id: string; fields: string[] }[];
      vocabulary_terms: number;
    };
    expect(body.records).toEqual([
      expect.objectContaining({
        collection: "projects",
        id: PROJECT,
        sent: true,
        fields: ["gate_readiness"],
      }),
    ]);
    expect(body.vocabulary_terms).toBe(0);
  });

  it("keeps the named project apart from the gate readiness that shares its id", () => {
    const neverSend = new NeverSendList([]);
    expect(
      previewRecords(
        [{ collection: "projects", id: PROJECT }],
        [
          { id: PROJECT, table: "app.projects", data: { id: PROJECT, name: "Northwind Summer" } },
          {
            id: PROJECT,
            table: "app.gate_criteria_status",
            data: { gate_readiness: [] },
            composed: true,
          },
        ],
        catalog,
        neverSend,
      ).map((r) => ({ id: r.id, fields: r.fields })),
    ).toEqual([
      { id: PROJECT, fields: ["id", "name"] },
      { id: PROJECT, fields: ["gate_readiness"] },
    ]);
  });

  it("never sends a whole excluded table", () => {
    const neverSend = new NeverSendList([{ table: "app.medical_encounters", column: null }]);
    expect(
      previewRecords(
        [{ collection: "medical-encounters", id: "m1" }],
        [{ id: "m1", table: "app.medical_encounters", data: { notes: "x" } }],
        catalog,
        neverSend,
      ),
    ).toEqual([
      {
        collection: "medical-encounters",
        id: "m1",
        sent: false,
        fields: [],
        withheld: [],
        data: null,
      },
    ]);
  });
});

describe("plain-language filters over a page's own filters", () => {
  it("sends the page's filters, never a Restricted column, with the org's calendar", async () => {
    const { api, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
        "rpc:ai_propose_suggestion": [ok(id(700))],
      },
      [
        tool("build_filter", {
          collection: "invoices",
          name: "Overdue Acme Invoices",
          conditions: [
            { field: "overdue", op: "eq", value: "true" },
            { field: "q", op: "contains", value: "Acme" },
          ],
          sort: [],
        }),
      ],
    );
    const res = await api.request(
      "/aurora/filter",
      post({
        sentence: "overdue invoices from Acme",
        collections: ["invoices"],
        time_zone: "Europe/Paris",
        fields: [
          {
            name: "overdue",
            type: "boolean",
            description: "Unpaid invoices past their due date.",
            ops: ["eq"],
          },
          { name: "q", type: "string", ops: ["contains"] },
          { name: "bank_reference", type: "string" },
        ],
      }),
    );
    const body = (await expectContract(res, "aurora.filter")) as {
      outcome: string;
      answer: { query: string };
    };
    expect(body).toMatchObject({
      outcome: "answer",
      answer: { query: "filter[overdue][eq]=true&filter[q][contains]=Acme" },
    });
    const sent = JSON.stringify(model.requests[0]?.messages);
    expect(sent).toContain("Unpaid invoices past their due date.");
    expect(sent).not.toContain("bank_reference");
    // The org's calendar and zone, not the caller's time_zone and never UTC.
    expect(model.requests[0]?.system).toContain("Today is 2026-10-20 in America/New_York");
  });

  it("drops a page filter that names a Restricted column", () => {
    const neverSend = new NeverSendList([{ table: "app.pay_rates", column: "rate_minor" }]);
    expect(
      pageFilterFields(
        [
          { name: "rate_minor", type: "number" },
          { name: "state", type: "enum", values: ["Active"], description: "State.", ops: ["eq"] },
        ],
        "app.pay_rates",
        neverSend,
      ),
    ).toEqual([
      { name: "state", type: "enum", values: ["Active"], description: "State.", ops: ["eq"] },
    ]);
  });
});

describe("the org's calendar", () => {
  it("resolves today in the org's locale.time_zone, a day behind UTC in a New York evening", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 22:30 in New York on 20 October is already 21 October in UTC.
    vi.setSystemTime(new Date("2026-10-21T02:30:00Z"));
    const zone = ok([
      {
        setting_key: "locale.time_zone",
        value_text: "America/New_York",
        value_boolean: null,
        value_integer: null,
        source: "Organization",
        locked: false,
        value_type: "Text",
      },
    ]);
    const { api, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:resolve_settings": [zone],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
      },
      [tool("build_filter", { no_answer: { missing: "Invoices have no weather." } })],
      {},
    );
    const res = await api.request(
      "/aurora/filter",
      post({
        sentence: "invoices on rainy days",
        collections: ["invoices"],
        time_zone: "UTC",
        fields: [{ name: "q", type: "string" }],
      }),
    );
    expect(await expectContract(res, "aurora.filter")).toMatchObject({ outcome: "no_answer" });
    expect(model.requests[0]?.system).toContain("Today is 2026-10-20 in America/New_York");
  });
});

describe("drafts and summaries", () => {
  it("drafts with the org's verbiage library", async () => {
    const { api, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
      },
      [tool("draft", { title: "Dock Procedure", body: "Use the Dock.", gaps: [] })],
    );
    const res = await api.request(
      "/aurora/draft",
      post({ kind: "sop", instructions: "Write the dock SOP." }),
    );
    expect(await expectContract(res, "aurora.draft")).toMatchObject({ outcome: "answer" });
    expect(JSON.stringify(model.requests[0]?.messages)).toContain("Title Case");
  });

  it("summarizes gate readiness from the project's criteria", async () => {
    const { api, model } = app(
      {
        "from:ai_never_send": [NEVER_SEND],
        "rpc:ai_begin_request": [begun],
        "rpc:ai_complete_request": [done],
      },
      [
        tool("summary", {
          headline: "Gate 2 is blocked",
          bullets: [{ text: "The budget envelope has no evidence.", citations: [PROJECT] }],
        }),
      ],
    );
    const res = await api.request(
      "/aurora/summarize",
      post({
        kind: "gate_readiness",
        subject_collection: "projects",
        subject_id: PROJECT,
        items: [],
      }),
    );
    expect(await expectContract(res, "aurora.summarize")).toMatchObject({
      outcome: "answer",
      answer: { headline: "Gate 2 is blocked" },
    });
    expect(JSON.stringify(model.requests[0]?.messages)).toContain("G2.BUDGET_ENVELOPE");
  });
});

describe("in-process reads", () => {
  it("reaches a resource's GET item query, such as a project's gate readiness", async () => {
    const projects = catalog.filter((s) => s.path === "/projects");
    const db = fakeDb({
      "from:projects": [ok({ id: PROJECT, current_phase_code: "PLN" })],
      "from:dim_phase": [
        ok([
          { phase_code: "PLN", gate: 2 },
          { phase_code: "DES", gate: 3 },
        ]),
      ],
      "from:gate_criteria_status": [
        ok([
          {
            project_id: PROJECT,
            gate: 2,
            criterion_id: "G2.BUDGET_ENVELOPE",
            is_blocking: true,
            evidence_count: 0,
          },
        ]),
      ],
    });
    const api = inProcessApi(testContext({ db: db as never }), projects);
    expect(await api.get(`/projects/${PROJECT}/gate-readiness`, {})).toEqual({
      status: 200,
      body: {
        data: [
          {
            project_id: PROJECT,
            gate: 2,
            criterion_id: "G2.BUDGET_ENVELOPE",
            blocking: true,
            satisfied: false,
          },
        ],
        next_cursor: null,
      },
    });
    expect((await api.get(`/projects/${PROJECT}/nothing`, {})).status).toBe(404);
  });
});
