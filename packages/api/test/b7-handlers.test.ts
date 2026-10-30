/**
 * Contract tests for B7's handlers (RRR-231, migrations 2960 to 2965, ADR 0146): a calendar feed's configuration
 * (member, project and personal feeds), the project debrief and its points, and the wrap-up summary's composed
 * facts. Requests run through `contractApp`, every response is checked against openapi/v1.json with
 * `expectContract`, and the database is a recording stand-in for supabase-js; the model is scripted, so nothing
 * reaches a model provider. Refusals (422) and hidden rows (404) are checked.
 */
import type { ModelClient, ModelRequest, ModelResponse, PublicApi } from "@xos/ai";
import { describe, expect, it } from "vitest";
import { auroraHandlers } from "../src/handlers/parts/aurora.ts";
import { handlers as platformHandlers } from "../src/handlers/platform.ts";
import { handlers as projectHandlers } from "../src/handlers/projects.ts";
import { defineHandlers, type HandlerSet } from "../src/runtime/handler.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success, tenantRow } from "./support/memory-db.ts";

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

const ctx = testContext();
const ORG = ctx.org?.id as string;
const T = "2026-10-20T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: null,
  updated_at: T,
  updated_by: null,
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `b7-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({ handlers: [platformHandlers, projectHandlers], db: fake.db as never }),
    calls: fake.calls,
  };
}

const argsOf = (calls: Call[], target: string) =>
  calls.filter((c) => c.target === target).at(-1)?.steps[0]?.[1][0];

const feed = {
  id: id(1),
  name: "Lighting crew",
  sources: ["Shifts", "Cues"],
  team_id: id(50),
  department_code: null,
  cue_call_kind: "Lighting",
};

describe("Calendar feed configuration", () => {
  it("reads and replaces a feed's configuration, and hides another member's feed", async () => {
    const { api, calls } = app({
      "from:calendar_feeds": [
        ok(feed),
        ok(feed),
        ok({ ...feed, team_id: null, department_code: "5000" }),
        hidden,
        hidden,
      ],
      "rpc:configure_calendar_feed": [ok(null)],
    });
    const read = await api.request(`/calendar-feeds/${feed.id}/configuration`);
    expect(await expectContract(read, "calendarFeeds.configuration")).toEqual({
      calendar_feed_id: feed.id,
      name: "Lighting crew",
      sources: ["Shifts", "Cues"],
      audience: { kind: "team", team_id: id(50) },
      cue_call_kind: "Lighting",
    });
    const changed = await api.request(
      `/calendar-feeds/${feed.id}/configure`,
      post({
        name: "Production",
        sources: null,
        audience: { kind: "department", department_code: "5000" },
      }),
    );
    expect(await expectContract(changed, "calendarFeeds.configure")).toMatchObject({
      audience: { kind: "department", department_code: "5000" },
    });
    expect(argsOf(calls, "rpc:configure_calendar_feed")).toEqual({
      p_calendar_feed_id: feed.id,
      p_name: "Production",
      p_sources: null,
      p_person_ids: null,
      p_team_id: null,
      p_department_code: "5000",
      p_cue_call_kind: null,
    });
    expect((await api.request(`/calendar-feeds/${id(2)}/configuration`)).status).toBe(404);
    expect(
      (await api.request(`/calendar-feeds/${id(2)}/configure`, post({ name: "Mine" }))).status,
    ).toBe(404);
  });

  it("reads a people audience back as people and answers a refusal with its rule", async () => {
    const { api } = app({
      "from:calendar_feeds": [
        ok({ ...feed, team_id: null, cue_call_kind: null }),
        ok({ ...feed, team_id: null, cue_call_kind: null }),
      ],
      "from:calendar_feed_members": [
        ok([{ membership: { person_id: id(70) } }, { membership: { person_id: id(71) } }]),
        ok([{ membership: { person_id: id(70) } }]),
      ],
      "rpc:configure_calendar_feed": [refusal("calendar_feed_people_limit")],
    });
    const read = await api.request(`/calendar-feeds/${feed.id}/configuration`);
    expect(await expectContract(read, "calendarFeeds.configuration")).toMatchObject({
      audience: { kind: "people", person_ids: [id(70), id(71)] },
    });
    const refused = await api.request(
      `/calendar-feeds/${feed.id}/configure`,
      post({ audience: { kind: "people", person_ids: [id(70)] } }),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "calendarFeeds.configure");
  });

  it("refuses a blank name instead of resetting it to the default", async () => {
    const { api, calls } = app({
      "from:calendar_feeds": [ok(feed)],
      "rpc:configure_calendar_feed": [refusal("calendar_feed_name")],
    });
    const refused = await api.request(`/calendar-feeds/${feed.id}/configure`, post({ name: "  " }));
    expect(refused.status).toBe(422);
    await expectContract(refused, "calendarFeeds.configure");
    expect(argsOf(calls, "rpc:configure_calendar_feed")).toMatchObject({ p_name: "  " });
  });

  it("configures a personal feed's name and sources", async () => {
    const personal = { id: id(3), name: "My gigs", sources: null };
    const { api, calls } = app({
      "from:person_calendar_feeds": [
        ok(personal),
        ok(personal),
        ok({ ...personal, sources: ["Cues"] }),
      ],
      "rpc:configure_person_calendar_feed": [ok(null)],
    });
    await expectContract(
      await api.request(`/person-calendar-feeds/${personal.id}/configuration`),
      "personCalendarFeeds.configuration",
    );
    const changed = await api.request(
      `/person-calendar-feeds/${personal.id}/configure`,
      post({ name: "My gigs", sources: ["Cues"] }),
    );
    expect(await expectContract(changed, "personCalendarFeeds.configure")).toEqual({
      calendar_feed_id: personal.id,
      name: "My gigs",
      sources: ["Cues"],
    });
    expect(argsOf(calls, "rpc:configure_person_calendar_feed")).toEqual({
      p_calendar_feed_id: personal.id,
      p_name: "My gigs",
      p_sources: ["Cues"],
    });
  });
});

const PROJECT = id(600);
const debrief = { ...audit(10), project_id: PROJECT, completed_at: null, completed_by: null };
const point = {
  ...audit(11),
  debrief_id: debrief.id,
  area: "Safety",
  item_kind: "Action",
  body: "Add a second spotter on the downstage truss.",
  position: 1,
  owner_membership_id: id(12),
};

describe("Project debriefs", () => {
  it("starts, completes and reopens a debrief, refusing a change once completed", async () => {
    const done = { ...debrief, completed_at: T, completed_by: id(13) };
    const { api, calls } = app({
      "from:project_debriefs": [
        ok([debrief]),
        ok(debrief),
        ok(debrief),
        ok({ id: debrief.id }),
        ok(done),
        ok({ id: debrief.id }),
        ok(debrief),
        hidden,
      ],
      "rpc:save_project_debrief": [ok(debrief.id)],
      "rpc:complete_project_debrief": [ok(null)],
      "rpc:reopen_project_debrief": [ok(null)],
    });
    await expectContract(await api.request("/project-debriefs"), "projectDebriefs.list");
    await expectContract(
      await api.request(`/project-debriefs/${debrief.id}`),
      "projectDebriefs.get",
    );
    const saved = await api.request(
      "/project-debriefs/save",
      post({
        project_id: PROJECT,
        management_summary: "Delivered on budget.",
        ai_request_id: id(900),
      }),
    );
    await expectContract(saved, "projectDebriefs.save");
    expect(argsOf(calls, "rpc:save_project_debrief")).toEqual({
      p_project_id: PROJECT,
      p_management_summary: "Delivered on budget.",
      p_ai_request_id: id(900),
    });
    const completed = await api.request(`/project-debriefs/${debrief.id}/complete`, post({}));
    expect(await expectContract(completed, "projectDebriefs.complete")).toMatchObject({
      completed_at: T,
    });
    expect(argsOf(calls, "rpc:complete_project_debrief")).toEqual({
      p_project_debrief_id: debrief.id,
    });
    const reopened = await api.request(`/project-debriefs/${debrief.id}/reopen`, post({}));
    expect(await expectContract(reopened, "projectDebriefs.reopen")).toMatchObject({
      completed_at: null,
    });
    expect((await api.request(`/project-debriefs/${id(99)}/complete`, post({}))).status).toBe(404);
  });

  it("refuses an Aurora request that is not the caller's own", async () => {
    const { api } = app({ "rpc:save_project_debrief": [refusal("debrief_ai_request")] });
    const refused = await api.request(
      "/project-debriefs/save",
      post({ project_id: PROJECT, management_summary: "x", ai_request_id: id(901) }),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "projectDebriefs.save");
  });

  it("lists, adds, changes and deletes debrief points", async () => {
    const db = memoryDb({
      project_debrief_items: [
        tenantRow(point.id, ORG, {
          debrief_id: debrief.id,
          area: "Safety",
          item_kind: "Action",
          body: point.body,
          position: 1,
          owner_membership_id: id(12),
        }),
      ],
    });
    const http = requests(contractApp({ handlers: [projectHandlers], db }));
    await expectContract(
      await success(http.get("/project-debrief-items")),
      "projectDebriefItems.list",
    );
    await expectContract(
      await success(http.get(`/project-debrief-items/${point.id}`)),
      "projectDebriefItems.get",
    );
    const made = await success(
      http.post("/project-debrief-items", {
        debrief_id: debrief.id,
        area: "Schedule",
        item_kind: "Went Well",
        body: "Load-in finished an hour early.",
        position: 2,
        owner_membership_id: null,
      }),
    );
    expect(await expectContract(made, "projectDebriefItems.create")).toMatchObject({
      area: "Schedule",
      org_id: ORG,
    });
    const changed = await success(
      http.patch(`/project-debrief-items/${point.id}`, { body: "Two spotters." }),
    );
    expect(await expectContract(changed, "projectDebriefItems.update")).toMatchObject({
      body: "Two spotters.",
    });
    const gone = await http.delete(`/project-debrief-items/${point.id}`);
    await expectContract(gone, "projectDebriefItems.delete");
    expect((await http.get(`/project-debrief-items/${point.id}`)).status).toBe(404);
  });
});

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

const summaryTool = (input: unknown): ModelResponse => ({
  content: [{ type: "tool_use", id: "tu_summary", name: "summary", input }],
  stopReason: "tool_use",
  usage: { inputTokens: 100, outputTokens: 20 },
});

/**
 * The wrap-up's facts as the in-process API answers them. As in the real API, a read the caller lacks is not a 403:
 * row level security leaves the page empty (no ledger rows means actual 0), so only the capability checks keep a
 * fact out.
 */
const factsApi = (): PublicApi => ({
  async get(path) {
    if (path === "/reports/final-cost-report")
      return { status: 200, body: { data: [{ currency: "USD", actual_minor: 10_500_000 }] } };
    if (path === "/reports/incident-rates")
      return { status: 200, body: { data: [{ measure: "incidents", value: 2 }] } };
    if (path === "/project-measurement-summary")
      return { status: 200, body: { data: [{ metric_code: "attendance", measured_base: 9800 }] } };
    if (path === `/project-debrief-items/${point.id}`) return { status: 200, body: point };
    return { status: 404, body: {} };
  },
});

/** What the caller holds: the wrap-up capabilities on the project, and whether a role grants the ledger org-wide. */
interface Holds {
  readonly project?: string[];
  readonly ledger?: "organization" | "own" | null;
}

const ALL_PROJECT = ["finance.budget.read", "projects.gate.read", "safety.incident.read"];

function aurora(neverSend: unknown[], script: ModelResponse[] = [], holds: Holds = {}) {
  const model = new Scripted(script);
  const handlers = defineHandlers(
    "Settings",
    auroraHandlers({
      model: () => model,
      readApi: () => factsApi(),
      today: () => "2026-10-28",
      timeZone: () => "America/New_York",
    }) as unknown as HandlerSet<"Settings">,
  );
  const role = { id: id(700), code: "finance", name: "Finance", band: 3, org_id: ORG };
  const ledger = holds.ledger === undefined ? "organization" : holds.ledger;
  const fake = fakeDb({
    "from:ai_never_send": [ok(neverSend)],
    "rpc:my_capabilities_on_project": [ok(holds.project ?? ALL_PROJECT)],
    "from:memberships": [
      ok({
        id: id(701),
        organization: {
          id: ORG,
          slug: ctx.org?.slug,
          name: "Northwind Live",
          parent_org_id: null,
          deleted_at: null,
        },
        membership_roles: [{ deleted_at: null, role }],
      }),
    ],
    "from:role_capabilities": [
      ok(ledger === null ? [] : [{ capability_code: "finance.journal.read", reach: ledger }]),
    ],
    "rpc:ai_begin_request": [ok(id(900))],
    "rpc:ai_complete_request": [ok(null)],
  });
  return {
    api: contractApp({ handlers: [handlers], db: fake.db as never }),
    model,
    calls: fake.calls,
  };
}

const wrapUpPreview = (api: ReturnType<typeof aurora>["api"]) =>
  api.request(
    "/aurora/preview",
    post({
      feature: "summaries",
      kind: "project_wrap_up",
      subject_collection: "projects",
      subject_id: PROJECT,
      items: [],
    }),
  );

describe("The wrap-up summary", () => {
  it("adds the budget, incident and measurement facts under their own relations, cited by the project", async () => {
    const { api } = aurora([]);
    const res = await api.request(
      "/aurora/preview",
      post({
        feature: "summaries",
        kind: "project_wrap_up",
        subject_collection: "projects",
        subject_id: PROJECT,
        items: [{ collection: "project-debrief-items", id: point.id }],
      }),
    );
    const body = (await expectContract(res, "aurora.preview")) as {
      records: { collection: string; id: string; fields: string[]; sent: boolean }[];
    };
    expect(body.records.map((r) => [r.collection, r.id, r.fields])).toEqual([
      ["project-debrief-items", point.id, expect.arrayContaining(["body", "item_kind"])],
      ["budgets", PROJECT, ["final_cost_report"]],
      ["incidents", PROJECT, ["incident_counts"]],
      ["project-measurement-summary", PROJECT, ["measurements"]],
    ]);
  });

  it("leaves out a fact the org never sends", async () => {
    const { api } = aurora([
      { table_name: "app.incidents", column_name: null },
      { table_name: "app.posting_lines", column_name: null },
    ]);
    const res = await api.request(
      "/aurora/preview",
      post({
        feature: "summaries",
        kind: "project_wrap_up",
        subject_collection: "projects",
        subject_id: PROJECT,
        items: [],
      }),
    );
    const body = (await expectContract(res, "aurora.preview")) as {
      records: { collection: string; sent: boolean }[];
    };
    expect(body.records.filter((r) => r.sent).map((r) => r.collection)).toEqual([
      "project-measurement-summary",
    ]);
  });

  it("leaves out the budget when the caller cannot read the ledger org-wide", async () => {
    for (const ledger of [null, "own"] as const) {
      const { api } = aurora([], [], { ledger });
      const body = (await expectContract(await wrapUpPreview(api), "aurora.preview")) as {
        records: { collection: string }[];
      };
      expect(body.records.map((r) => r.collection)).toEqual([
        "incidents",
        "project-measurement-summary",
      ]);
    }
  });

  it("checks the caller's own capabilities on the subject project", async () => {
    const { api, calls } = aurora([], [], { project: ["finance.budget.read"] });
    const body = (await expectContract(await wrapUpPreview(api), "aurora.preview")) as {
      records: { collection: string }[];
    };
    expect(body.records.map((r) => r.collection)).toEqual(["budgets"]);
    expect(argsOf(calls, "rpc:my_capabilities_on_project")).toEqual({
      p_project_id: PROJECT,
      p_capabilities: ALL_PROJECT,
    });
  });

  it("sends no fact the caller cannot read, though every read answers 200", async () => {
    const { api } = aurora([], [], { project: [], ledger: "organization" });
    const body = (await expectContract(await wrapUpPreview(api), "aurora.preview")) as {
      records: unknown[];
    };
    expect(body.records).toEqual([]);
  });

  it("summarizes with every bullet citing a supplied item", async () => {
    const { api, model } = aurora(
      [],
      [
        summaryTool({
          headline: "Delivered on budget",
          bullets: [
            { text: "Actuals came in at USD 105,000.", citations: [PROJECT] },
            { text: "Add a second spotter on load-out.", citations: [point.id] },
            { text: "Invented point.", citations: ["nothing"] },
          ],
        }),
      ],
    );
    const res = await api.request(
      "/aurora/summarize",
      post({
        kind: "project_wrap_up",
        subject_collection: "projects",
        subject_id: PROJECT,
        items: [{ collection: "project-debrief-items", id: point.id }],
      }),
    );
    const body = (await expectContract(res, "aurora.summarize")) as {
      answer: { bullets: { citations: string[] }[] };
      request_id: string;
    };
    expect(body.answer.bullets).toHaveLength(2);
    expect(body.request_id).toBe(id(900));
    const sent = JSON.stringify(model.requests[0]);
    expect(sent).toContain("final_cost_report");
    expect(sent).toContain("wrap-up for management");
  });
});
