import { describe, expect, it } from "vitest";
import {
  applyDraftedList,
  createAuroraStore,
  draftedListIsEmpty,
  getAiAllowance,
  getAiSettings,
  getAiSuggestion,
  listAiNeverSend,
  listAiRequests,
  listAiSuggestions,
  listEnabledAiFeatures,
  saveAiSettings,
  transitionAiSuggestion,
} from "../src/ai.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const settingsRow = {
  assistant_enabled: true,
  plain_language_enabled: false,
  extraction_enabled: true,
  drafting_enabled: false,
  summaries_enabled: false,
  mapping_enabled: false,
};

describe("AI settings", () => {
  it("reads the switches, and every feature is off without a row", async () => {
    const { db } = fakeClient({ "from:ai_settings": [okResponse(settingsRow), okResponse(null)] });
    expect(await getAiSettings(db, "o1")).toEqual({
      ok: true,
      data: {
        assistant: true,
        plain_language: false,
        extraction: true,
        drafting: false,
        summaries: false,
        mapping: false,
      },
    });
    const empty = await getAiSettings(db, "o1");
    expect(empty.ok && Object.values(empty.data).every((v) => v === false)).toBe(true);
  });

  it("upserts on org_id and returns the plan refusal", async () => {
    const { db, calls } = fakeClient({
      "from:ai_settings": [
        okResponse(null),
        errorResponse(
          "XR001",
          "aurora_not_in_plan: Aurora AI is not in this org's plan.",
          "aurora_not_in_plan",
        ),
        errorResponse("42P01", "broken"),
      ],
    });
    const on = {
      assistant: true,
      plain_language: false,
      extraction: false,
      drafting: false,
      summaries: false,
      mapping: false,
    };
    expect(await saveAiSettings(db, "o1", on)).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual([
      "upsert",
      [{ org_id: "o1", ...settingsRow, extraction_enabled: false }, { onConflict: "org_id" }],
    ]);
    expect(await saveAiSettings(db, "o2", on)).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "aurora_not_in_plan" },
    });
    expect(await getAiSettings(db, "o1")).toMatchObject({
      ok: false,
      error: { kind: "unexpected" },
    });
  });
});

describe("allowance, features and the never-send list", () => {
  it("reads the allowance", async () => {
    const { db } = fakeClient({
      "rpc:ai_allowance": [
        okResponse([{ used: 12, allowance: 500, plan_includes_aurora: true }]),
        okResponse([{ used: 3, allowance: null, plan_includes_aurora: true }]),
        okResponse([]),
        errorResponse("42501", "not a member"),
      ],
    });
    expect(await getAiAllowance(db, "o1")).toEqual({
      ok: true,
      data: { used: 12, allowance: 500, planIncludesAurora: true },
    });
    expect(await getAiAllowance(db, "o1")).toMatchObject({ ok: true, data: { allowance: null } });
    expect(await getAiAllowance(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await getAiAllowance(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("lists enabled features in settings order", async () => {
    const { db } = fakeClient({
      "rpc:ai_enabled_features": [
        okResponse(["mapping", "assistant"]),
        errorResponse("08000", "down"),
      ],
    });
    expect(await listEnabledAiFeatures(db, "o1")).toEqual({
      ok: true,
      data: ["assistant", "mapping"],
    });
    expect((await listEnabledAiFeatures(db, "o1")).ok).toBe(false);
  });

  it("reads the never-send list", async () => {
    const { db } = fakeClient({
      "from:ai_never_send": [
        okResponse([
          { table_name: "app.medical_encounters", column_name: null },
          { table_name: "app.pay_rates", column_name: "rate_minor" },
          { table_name: null, column_name: null },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    expect(await listAiNeverSend(db)).toEqual({
      ok: true,
      data: [
        { table: "app.medical_encounters", column: null },
        { table: "app.pay_rates", column: "rate_minor" },
      ],
    });
    expect((await listAiNeverSend(db)).ok).toBe(false);
  });
});

describe("Aurora store", () => {
  it("begins with and without a subject", async () => {
    const { db, calls } = fakeClient({
      "rpc:ai_begin_request": [
        okResponse("r1"),
        okResponse("r2"),
        errorResponse("XR001", "plan_limit_exceeded: The plan allows 500.", "plan_limit_exceeded"),
      ],
    });
    const store = createAuroraStore(db);
    expect(await store.begin("o1", "assistant", "claude-sonnet-5-5", null)).toEqual({
      ok: true,
      data: "r1",
    });
    await store.begin("o1", "extraction", "claude-opus-5-5", { table: "app.documents", id: "d1" });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        p_org_id: "o1",
        p_feature: "extraction",
        p_model: "claude-opus-5-5",
        p_subject_table: "app.documents",
        p_subject_id: "d1",
      },
    ]);
    expect(await store.begin("o1", "assistant", "m", null)).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "plan_limit_exceeded" },
    });
  });

  it("completes with usage or a failure code and proposes changes", async () => {
    const { db, calls } = fakeClient({
      "rpc:ai_complete_request": [
        okResponse(null),
        errorResponse("XR001", "ai_request_already_complete: done", "ai_request_already_complete"),
      ],
      "rpc:ai_propose_suggestion": [okResponse("s1"), errorResponse("42501", "no")],
    });
    const store = createAuroraStore(db);
    expect(
      await store.complete({
        requestId: "r1",
        outcome: "Answered",
        prompt: "p",
        output: "o",
        usage: { inputTokens: 5, outputTokens: 6 },
        failureCode: null,
      }),
    ).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        p_request_id: "r1",
        p_outcome: "Answered",
        p_prompt: "p",
        p_output: "o",
        p_input_tokens: 5,
        p_output_tokens: 6,
      },
    ]);
    expect(
      await store.complete({
        requestId: "r1",
        outcome: "Failed",
        prompt: "",
        output: null,
        usage: null,
        failureCode: "model_error",
      }),
    ).toMatchObject({ ok: false, error: { kind: "refusal" } });
    const change = {
      operationId: "savedViews.create",
      targetId: null,
      summary: "Save.",
      fields: [{ field_path: "name", value: "Blocked", confidence: 1 }],
    };
    expect(await store.propose("r1", change)).toEqual({ ok: true, data: "s1" });
    expect(await store.propose("r1", change)).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});

const suggestionRow = {
  id: "s1",
  request_id: "r1",
  operation_id: "insuranceCertificates.create",
  target_id: null,
  summary: "Add the certificate.",
  suggestion_state: "Proposed",
  expires_at: "2026-10-21T00:00:00Z",
  applied_id: null,
  ai_suggestion_fields: [
    {
      field_path: "expires_on",
      proposed_value: null,
      confidence: null,
      refusal: "NO_ANSWER",
      missing: "Not stated.",
      source_excerpt: null,
      position: 1,
    },
    {
      field_path: "coverage_type",
      proposed_value: "General Liability",
      confidence: "0.970",
      refusal: null,
      missing: null,
      source_excerpt: "GENERAL LIABILITY",
      position: 0,
    },
  ],
};

describe("suggestions", () => {
  it("lists and reads suggestions with fields in order", async () => {
    const { db, calls } = fakeClient({
      "from:ai_suggestions": [
        okResponse([suggestionRow]),
        okResponse([]),
        okResponse(suggestionRow),
        okResponse(null),
        errorResponse("42501", "no"),
        errorResponse("08000", "down"),
      ],
    });
    const listed = await listAiSuggestions(db, "o1");
    expect(listed.ok && listed.data[0]?.fields.map((f) => f.fieldPath)).toEqual([
      "coverage_type",
      "expires_on",
    ]);
    expect(listed.ok && listed.data[0]?.fields[0]?.confidence).toBe(0.97);
    expect(listed.ok && listed.data[0]?.fields[1]?.refusal).toBe("NO_ANSWER");
    await listAiSuggestions(db, "o1", "Proposed");
    expect(calls[1]?.steps.some(([m, a]) => m === "eq" && a[0] === "suggestion_state")).toBe(true);
    expect(await getAiSuggestion(db, "s1")).toMatchObject({ ok: true, data: { id: "s1" } });
    expect(await getAiSuggestion(db, "s9")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await getAiSuggestion(db, "s9")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await listAiSuggestions(db, "o1")).ok).toBe(false);
  });

  it("transitions with compare-and-set and the applied record", async () => {
    const { db, calls } = fakeClient({
      "rpc:transition_ai_suggestion": [
        okResponse("t1"),
        okResponse("t2"),
        errorResponse("XR001", "ai_suggestion_expired: Expired.", "ai_suggestion_expired"),
      ],
    });
    expect(
      await transitionAiSuggestion(db, {
        id: "s1",
        expected: "Proposed",
        next: "Confirmed",
        reason: "Checked.",
      }),
    ).toEqual({ ok: true, data: null });
    await transitionAiSuggestion(db, {
      id: "s1",
      expected: "Confirmed",
      next: "Applied",
      reason: "Written.",
      appliedId: "x1",
    });
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        p_suggestion_id: "s1",
        p_expected: "Confirmed",
        p_next: "Applied",
        p_reason: "Written.",
        p_applied_id: "x1",
      },
    ]);
    expect(
      await transitionAiSuggestion(db, {
        id: "s1",
        expected: "Proposed",
        next: "Confirmed",
        reason: "Late.",
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "ai_suggestion_expired" },
    });
  });
});

describe("request log", () => {
  it("reads requests with their usage in either embed shape", async () => {
    const base = {
      person_id: "p1",
      feature: "assistant",
      model: "claude-sonnet-5-5",
      outcome: "Answered",
      created_at: "2026-10-14T12:00:00Z",
    };
    const { db, calls } = fakeClient({
      "from:ai_requests": [
        okResponse([
          { id: "r1", ...base, ai_usage: { input_tokens: 10, output_tokens: 2 } },
          { id: "r2", ...base, ai_usage: [{ input_tokens: 3, output_tokens: 1 }] },
          { id: "r3", ...base, ai_usage: null },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    const log = await listAiRequests(db, "o1", 500);
    expect(log.ok && log.data.map((r) => r.inputTokens)).toEqual([10, 3, null]);
    expect(calls[0]?.steps.find(([m]) => m === "limit")?.[1]).toEqual([200]);
    expect((await listAiRequests(db, "o1")).ok).toBe(false);
  });
});

describe("drafted lists", () => {
  it("asks whether a list is empty, with not-found for a caller who may not write to it", async () => {
    const { db, calls } = fakeClient({
      "rpc:drafted_list_is_empty": [
        okResponse(true),
        okResponse(false),
        errorResponse("42501", "drafting a run of show needs show.run_of_show.write"),
      ],
    });
    expect(await draftedListIsEmpty(db, "run_of_show", "r1")).toEqual({ ok: true, data: true });
    expect(calls[0]?.steps[0]?.[1]).toEqual([{ p_kind: "run_of_show", p_target_id: "r1" }]);
    expect(await draftedListIsEmpty(db, "risk_assessment", "p1")).toEqual({
      ok: true,
      data: false,
    });
    expect(await draftedListIsEmpty(db, "run_of_show", "r2")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("applies the kept lines and maps line refusals", async () => {
    const written = { written: [{ suggestion_id: "s1", id: "c1" }], rejected: 2 };
    const { db, calls } = fakeClient({
      "rpc:apply_drafted_list": [
        okResponse(written),
        errorResponse(
          "XR001",
          "aurora_draft_list_not_empty: This running order already has cues. Aurora only drafts into an empty list.",
          "aurora_draft_list_not_empty",
        ),
        errorResponse(
          "XR001",
          "record_title_grammar: Line 2: A Risk title is a noun phrase naming the thing.",
          "record_title_grammar",
        ),
        errorResponse(
          "22007",
          'Line 1: invalid input syntax for type timestamp with time zone: "7pm"',
        ),
      ],
    });
    expect(
      await applyDraftedList(db, {
        requestId: "q1",
        items: [{ suggestion_id: "s1", values: { label: "Doors" } }, { suggestion_id: "s2" }],
      }),
    ).toEqual({ ok: true, data: written });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        p_request_id: "q1",
        p_items: [
          { suggestion_id: "s1", values: { label: "Doors" } },
          { suggestion_id: "s2", values: {} },
        ],
      },
    ]);
    expect(await applyDraftedList(db, { requestId: "q1", items: [] })).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "aurora_draft_list_not_empty" },
    });
    expect(await applyDraftedList(db, { requestId: "q1", items: [] })).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "record_title_grammar",
        message: "Line 2: A Risk title is a noun phrase naming the thing.",
      },
    });
    expect(await applyDraftedList(db, { requestId: "q1", items: [] })).toMatchObject({
      ok: false,
      error: { kind: "invalid", message: expect.stringMatching(/^Line 1: /) },
    });
  });
});
