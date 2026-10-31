import { describe, expect, it } from "vitest";
import { createAuroraClient, type AuroraClient, type AuroraSuggestion } from "../src/client.ts";
import { availabilityOf, AuroraConversation, COMPASS_AURORA_ENTRY } from "../src/conversation.ts";

interface Seen {
  url: string;
  init: RequestInit;
}

function recordingFetch(responses: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Aurora API client", () => {
  it("calls the public API with idempotency keys and the person's headers", async () => {
    const { fn, seen } = recordingFetch([
      json({ enabled_features: [] }),
      json({ outcome: "answer" }),
    ]);
    const client = createAuroraClient({
      baseUrl: "/api/v1",
      fetch: fn,
      headers: () => ({ Authorization: "Bearer session" }),
      idempotencyKey: () => "k1",
    });
    expect(await client.status()).toEqual({ ok: true, data: { enabled_features: [] } });
    await client.ask("Which permits are blocked?");
    expect(seen[0]?.url).toBe("/api/v1/aurora/status");
    expect(seen[1]).toMatchObject({
      url: "/api/v1/aurora/ask",
      init: {
        method: "POST",
        headers: { Authorization: "Bearer session", "Idempotency-Key": "k1" },
      },
    });
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      question: "Which permits are blocked?",
      history: [],
    });
  });

  it("maps problems, unreadable bodies and network failures", async () => {
    const { fn } = recordingFetch([
      json({ rule: "plan_limit_exceeded", detail: "The plan allows 500." }, 422),
      json({ title: "Not Found" }, 404),
      json({}, 500),
      new Response("<html>", { status: 502 }),
      new Error("offline"),
    ]);
    const client = createAuroraClient({ baseUrl: "", fetch: fn });
    expect(
      await client.filter({ sentence: "x", collections: ["permits"], time_zone: "UTC" }),
    ).toEqual({
      ok: false,
      problem: { status: 422, rule: "plan_limit_exceeded", detail: "The plan allows 500." },
    });
    expect(await client.suggestion("s1")).toMatchObject({
      ok: false,
      problem: { status: 404, detail: "Not Found" },
    });
    expect(await client.reject("s1", "No.")).toMatchObject({
      ok: false,
      problem: { detail: "The API answered 500." },
    });
    expect(await client.confirm("s1", "Yes.")).toMatchObject({
      ok: false,
      problem: { status: 502 },
    });
    expect(
      await client.extract({
        kind: "receipt",
        document_id: "d",
        media_type: "text/plain",
        content_base64: "eA==",
        file_name: "r.txt",
      }),
    ).toEqual({
      ok: false,
      problem: { status: 0, rule: null, detail: "offline" },
    });
  });

  it("asks for import column suggestions", async () => {
    const { fn, seen } = recordingFetch([json({ outcome: "answer", answer: [] })]);
    const client = createAuroraClient({ baseUrl: "/api/v1", fetch: fn, idempotencyKey: () => "k" });
    const body = {
      collection: "venues",
      columns: [{ header: "Venue", samples: [] }],
      fields: [{ name: "name", description: "Name" }],
    };
    expect(await client.mapColumns(body)).toEqual({
      ok: true,
      data: { outcome: "answer", answer: [] },
    });
    expect(seen[0]?.url).toBe("/api/v1/aurora/map-columns");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual(body);
  });

  it("sends draft, summarize and confirm bodies", async () => {
    const { fn, seen } = recordingFetch([json({}), json({}), json({})]);
    const client = createAuroraClient({ baseUrl: "", fetch: fn, idempotencyKey: () => "k" });
    await client.draft({ kind: "email", instructions: "Confirm arrival." });
    await client.summarize({
      kind: "project_week",
      subject_collection: "projects",
      subject_id: "p",
      items: [],
    });
    await client.confirm("s 1", "Checked.", { document_id: "d1" });
    expect(seen.map((s) => s.url)).toEqual([
      "/aurora/draft",
      "/aurora/summarize",
      "/ai-suggestions/s%201/confirm",
    ]);
    expect(JSON.parse(String(seen[2]?.init.body))).toEqual({
      reason: "Checked.",
      values: { document_id: "d1" },
    });
  });
});

describe("drafted lists (P6)", () => {
  it("drafts into a named list and applies the kept lines in one call", async () => {
    const applied = { written: [{ suggestion_id: "s1", id: "c1" }], rejected: 2 };
    const { fn, seen } = recordingFetch([json({}), json(applied)]);
    const client = createAuroraClient({ baseUrl: "/api/v1", fetch: fn, idempotencyKey: () => "k" });
    await client.draft({
      kind: "run_of_show",
      instructions: "Draft the running order.",
      target: { collection: "run-of-show", id: "r1" },
      context: [{ collection: "projects", id: "p1" }],
    });
    const result = await client.applyDraft({
      request_id: "q1",
      items: [{ suggestion_id: "s1", values: { label: "Doors" } }],
    });
    expect(seen.map((s) => [s.url, s.init.method])).toEqual([
      ["/api/v1/aurora/draft", "POST"],
      ["/api/v1/aurora/apply-draft", "POST"],
    ]);
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({
      kind: "run_of_show",
      target: { collection: "run-of-show", id: "r1" },
    });
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      request_id: "q1",
      items: [{ suggestion_id: "s1", values: { label: "Doors" } }],
    });
    expect(result).toEqual({ ok: true, data: applied });
  });

  it("answers a filled list as its refusal rule", async () => {
    const { fn } = recordingFetch([
      json(
        {
          rule: "aurora_draft_list_not_empty",
          detail: "This running order already has cues. Aurora only drafts into an empty list.",
        },
        422,
      ),
    ]);
    const client = createAuroraClient({ baseUrl: "", fetch: fn, idempotencyKey: () => "k" });
    expect(await client.applyDraft({ request_id: "q1", items: [{ suggestion_id: "s1" }] })).toEqual(
      {
        ok: false,
        problem: {
          status: 422,
          rule: "aurora_draft_list_not_empty",
          detail: "This running order already has cues. Aurora only drafts into an empty list.",
        },
      },
    );
  });
});

const suggestion: AuroraSuggestion = {
  id: "s1",
  operation_id: "savedViews.create",
  target_id: null,
  summary: "Save the view.",
  suggestion_state: "Proposed",
  expires_at: "2026-10-22T00:00:00Z",
  applied_id: null,
  proposed_fields: [],
};

function scriptedClient(overrides: Partial<AuroraClient>): AuroraClient {
  const unused = async () => ({
    ok: false as const,
    problem: { status: 500, rule: null, detail: "unused" },
  });
  return {
    status: unused,
    ask: unused,
    filter: unused,
    extract: unused,
    draft: unused,
    applyDraft: unused,
    summarize: unused,
    mapColumns: unused,
    bindCode: unused,
    preview: unused,
    suggestion: unused,
    confirm: unused,
    reject: unused,
    ...overrides,
  };
}

describe("assistant conversation", () => {
  const ready = {
    enabled_features: ["assistant" as const],
    used: 1,
    allowance: 500,
    plan_includes_aurora: true,
  };

  it("names why the assistant is unavailable", () => {
    expect(availabilityOf({ ...ready, plan_includes_aurora: false })).toEqual({
      kind: "not-in-plan",
    });
    expect(availabilityOf({ ...ready, enabled_features: [] })).toEqual({ kind: "off" });
    expect(availabilityOf({ ...ready, used: 500 })).toEqual({
      kind: "limit-reached",
      allowance: 500,
    });
    expect(availabilityOf({ ...ready, allowance: null, used: 99999 }).kind).toBe("ready");
  });

  it("asks, shows the answer and its suggestion, and confirms it", async () => {
    const client = scriptedClient({
      status: async () => ({ ok: true, data: ready }),
      ask: async () => ({
        ok: true,
        data: {
          outcome: "answer",
          ai_generated: true,
          request_id: "r1",
          model: "claude-sonnet-5-5",
          missing: null,
          failure_code: null,
          answer: { text: "One permit is blocked.", citations: [] },
          suggestions: [
            { suggestion_id: "s1", operation_id: "savedViews.create", summary: "Save the view." },
          ],
        },
      }),
      suggestion: async () => ({ ok: true, data: suggestion }),
      confirm: async () => ({
        ok: true,
        data: { ...suggestion, suggestion_state: "Applied", applied_id: "v1" },
      }),
    });
    const c = new AuroraConversation(client);
    const seen: number[] = [];
    const stop = c.subscribe(() => seen.push(c.getSnapshot().turns.length));
    await c.loadStatus();
    expect(c.getSnapshot().availability.kind).toBe("ready");
    await c.ask("  ");
    await c.ask("Which permits are blocked?");
    const turn = c.getSnapshot().turns[0];
    expect(turn).toMatchObject({ phase: "answered", model: "claude-sonnet-5-5" });
    expect(turn?.suggestions[0]?.phase).toBe("proposed");
    await c.confirm(1, "s1", "Looks right.");
    expect(c.getSnapshot().turns[0]?.suggestions[0]?.phase).toBe("applied");
    expect(c.history()).toEqual([
      { question: "Which permits are blocked?", answer: "One permit is blocked." },
    ]);
    stop();
    c.clear();
    expect(c.getSnapshot().turns).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("shows NO ANSWER, failures, refusals and errors", async () => {
    let call = 0;
    const answers = [
      {
        ok: true as const,
        data: {
          outcome: "no_answer" as const,
          ai_generated: true as const,
          request_id: "r",
          model: "m",
          missing: "No budget lines exist yet.",
          failure_code: null,
          answer: null,
          suggestions: [],
        },
      },
      {
        ok: true as const,
        data: {
          outcome: "failed" as const,
          ai_generated: true as const,
          request_id: "r",
          model: null,
          missing: null,
          failure_code: "model_error",
          answer: null,
          suggestions: [],
        },
      },
      {
        ok: false as const,
        problem: { status: 422, rule: "plan_limit_exceeded", detail: "The plan allows 500." },
      },
      { ok: false as const, problem: { status: 0, rule: null, detail: "offline" } },
    ];
    const client = scriptedClient({
      ask: async () => answers[Math.min(call++, answers.length - 1)] as (typeof answers)[number],
      status: async () => ({ ok: false, problem: { status: 0, rule: null, detail: "offline" } }),
    });
    const c = new AuroraConversation(client);
    for (const q of ["a", "b", "c", "d"]) await c.ask(q);
    expect(c.getSnapshot().turns.map((t) => t.phase)).toEqual([
      "no-answer",
      "failed",
      "refused",
      "error",
    ]);
    expect(c.getSnapshot().turns[0]?.missing).toBe("No budget lines exist yet.");
    expect(c.getSnapshot().availability.kind).toBe("error");
  });

  it("marks refused, failed and rejected suggestions", async () => {
    const client = scriptedClient({
      ask: async () => ({
        ok: true,
        data: {
          outcome: "answer",
          ai_generated: true,
          request_id: "r",
          model: "m",
          missing: null,
          failure_code: null,
          answer: { text: "x", citations: [] },
          suggestions: [
            { suggestion_id: "s1", operation_id: "o.create", summary: "a" },
            { suggestion_id: "s2", operation_id: "o.create", summary: "b" },
          ],
        },
      }),
      suggestion: async (id) =>
        id === "s1"
          ? { ok: true, data: { ...suggestion, id, suggestion_state: "Confirmed" } }
          : { ok: false, problem: { status: 404, rule: null, detail: "gone" } },
      confirm: async () => ({
        ok: false,
        problem: { status: 422, rule: "vendor_blocked", detail: "The vendor is blocked." },
      }),
      reject: async () => ({ ok: true, data: { ...suggestion, suggestion_state: "Expired" } }),
    });
    const c = new AuroraConversation(client);
    await c.ask("x");
    const views = () => c.getSnapshot().turns[0]?.suggestions ?? [];
    expect(views().map((s) => s.phase)).toEqual(["confirming", "error"]);
    await c.confirm(1, "s1", "Yes.");
    expect(views()[0]).toMatchObject({ phase: "refused", problem: { rule: "vendor_blocked" } });
    await c.reject(1, "s1", "No.");
    expect(views()[0]?.phase).toBe("rejected");
    const failing = new AuroraConversation(
      scriptedClient({
        reject: async () => ({ ok: false, problem: { status: 0, rule: null, detail: "offline" } }),
        confirm: async () => ({ ok: false, problem: { status: 0, rule: null, detail: "offline" } }),
      }),
    );
    await failing.reject(9, "none", "No.");
    await failing.confirm(9, "none", "Yes.");
    expect(failing.getSnapshot().turns).toEqual([]);
  });

  it("describes the Compass More menu entry", () => {
    expect(COMPASS_AURORA_ENTRY).toMatchObject({
      id: "aurora",
      feature: "assistant",
      labelKey: "aurora.compass.menuLabel",
    });
  });
});
