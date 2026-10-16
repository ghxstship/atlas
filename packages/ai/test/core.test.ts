import { describe, expect, it } from "vitest";
import { envKey, loadModelConfig } from "../src/config.ts";
import { AI_FEATURES, addUsage, findToolUse, isAiFeature, responseText } from "../src/model.ts";
import { NeverSendList, redactText, scrubRecord } from "../src/redact.ts";
import { localNoAnswer, runFeature } from "../src/session.ts";
import { FeatureError } from "../src/session.ts";
import models from "../config/models.json" with { type: "json" };
import { context, memoryStore, ScriptedModel, toolCall } from "./fakes.ts";

describe("model configuration", () => {
  it("reads every feature's model from config/models.json", () => {
    const config = loadModelConfig({});
    for (const feature of AI_FEATURES) {
      expect(config.modelFor(feature)).toBe(models.features[feature]);
      expect(config.maxTokensFor(feature)).toBe(models.maxTokens[feature]);
    }
  });

  it("lets AURORA_MODEL override every feature and AURORA_MODEL_<FEATURE> override one", () => {
    const config = loadModelConfig({
      AURORA_MODEL: "claude-haiku-5-5",
      [envKey("extraction")]: "claude-opus-5-5",
    });
    expect(config.modelFor("assistant")).toBe("claude-haiku-5-5");
    expect(config.modelFor("extraction")).toBe("claude-opus-5-5");
  });

  it("refuses a model identifier that is not a configuration id", () => {
    expect(() => loadModelConfig({ AURORA_MODEL: "Claude Opus" })).toThrow();
    expect(() => loadModelConfig({}, { default: "x y", features: {}, maxTokens: {} })).toThrow();
  });

  it("falls back to the default model and 2048 tokens for a feature the file leaves out", () => {
    const config = loadModelConfig(
      {},
      { default: "claude-sonnet-5-5", features: {}, maxTokens: {} },
    );
    expect(config.modelFor("drafting")).toBe("claude-sonnet-5-5");
    expect(config.maxTokensFor("drafting")).toBe(2048);
  });

  it("never names a model in source code", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const root = new URL("../src/", import.meta.url);
    const files = await readdir(root, { recursive: true });
    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      const source = await readFile(new URL(file, root), "utf8");
      expect(source, file).not.toMatch(/claude-(opus|sonnet|haiku)-\d/);
    }
  });
});

describe("model helpers", () => {
  it("knows the features and adds usage", () => {
    expect(isAiFeature("assistant")).toBe(true);
    expect(isAiFeature("payroll")).toBe(false);
    expect(
      addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 6,
    });
  });

  it("finds tool calls and joins text for logs", () => {
    const response = toolCall("answer", { text: "Hi" });
    expect(findToolUse(response, "answer")?.input).toEqual({ text: "Hi" });
    expect(findToolUse(response, "other")).toBeNull();
    expect(responseText(response)).toBe('answer {"text":"Hi"}');
  });
});

describe("redaction", () => {
  it("matches the database pass on the same inputs as pgTAP 0650", () => {
    expect(redactText("Call Ivy at (305) 555-0142 or ivy@example.com.")).toBe(
      "Call Ivy at [phone] or [email].",
    );
    expect(redactText("SSN 123-45-6789, card 4242 4242 4242 4242")).toBe(
      "SSN [government id], card [card number]",
    );
    expect(redactText("Load-in at 14:00 on 2026-11-03 for 120 crew.")).toBe(
      "Load-in at 14:00 on 2026-11-03 for 120 crew.",
    );
  });

  const neverSend = new NeverSendList([
    { table: "app.medical_encounters", column: null },
    { table: "app.pay_rates", column: "rate_minor" },
  ]);

  it("drops excluded tables whole, including their masked views", () => {
    expect(neverSend.size).toBe(2);
    expect(scrubRecord("app.medical_encounters", { id: "m1" }, neverSend)).toBeNull();
    expect(scrubRecord("app.medical_encounters_masked", { id: "m1" }, neverSend)).toBeNull();
  });

  it("drops Restricted columns and masked values so the model never learns they exist", () => {
    expect(
      scrubRecord(
        "app.pay_rates_masked",
        {
          id: "p1",
          rate_minor: 4200,
          is_masked: true,
          person: { name: "Ivy", rate: { masked: true, reason: "restricted" }, is_masked: false },
          lines: [{ masked: true }, { label: "Day" }],
        },
        neverSend,
      ),
    ).toEqual({ id: "p1", person: { name: "Ivy" }, lines: [{ label: "Day" }] });
  });
});

describe("request runner", () => {
  it("returns a refusal from authorization without calling the model", async () => {
    const model = new ScriptedModel([]);
    const { store, log } = memoryStore({
      begin: {
        ok: false,
        error: { kind: "refusal", rule: "plan_limit_exceeded", message: "The plan allows 500." },
      },
    });
    const result = await runFeature(context(model, store), "summaries", null, async () => {
      throw new Error("not reached");
    });
    expect(result).toEqual({
      kind: "refused",
      rule: "plan_limit_exceeded",
      message: "The plan allows 500.",
    });
    expect(model.requests).toHaveLength(0);
    expect(log.completed).toHaveLength(0);
  });

  it("maps a hidden org to a refusal and other begin errors to a failure", async () => {
    const model = new ScriptedModel([]);
    const hidden = memoryStore({ begin: { ok: false, error: { kind: "not-found" } } });
    expect(
      (
        await runFeature(context(model, hidden.store), "summaries", null, async () => ({
          kind: "no-answer",
          missing: "",
          prompt: "",
          output: "",
          usage: { inputTokens: 0, outputTokens: 0 },
        }))
      ).kind,
    ).toBe("refused");
    const broken = memoryStore({
      begin: { ok: false, error: { kind: "unexpected", message: "down" } },
    });
    expect(
      await runFeature(context(model, broken.store), "summaries", null, async () => ({
        kind: "no-answer",
        missing: "",
        prompt: "",
        output: "",
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
    ).toEqual({
      kind: "failed",
      requestId: null,
      code: "log_failed",
      message: "down",
    });
  });

  it("logs a model failure as Failed with its code", async () => {
    const { store, log } = memoryStore();
    const result = await runFeature(
      context(new ScriptedModel([]), store),
      "drafting",
      null,
      async () => {
        throw new FeatureError("model_output_invalid", "bad shape");
      },
    );
    expect(result).toEqual({
      kind: "failed",
      requestId: "req-1",
      code: "model_output_invalid",
      message: "bad shape",
    });
    expect(log.completed[0]).toMatchObject({
      outcome: "Failed",
      failureCode: "model_output_invalid",
    });
  });

  it("logs other thrown errors as model_error and reports a failed log", async () => {
    const { store } = memoryStore({
      complete: { ok: false, error: { kind: "unexpected", message: "x" } },
    });
    const result = await runFeature(
      context(new ScriptedModel([]), store),
      "drafting",
      null,
      async () => {
        throw new Error("timeout");
      },
    );
    expect(result).toMatchObject({ kind: "failed", code: "log_failed", message: "timeout" });
  });

  it("redacts the prompt and output before logging and stores proposals after completion", async () => {
    const { store, log } = memoryStore();
    const result = await runFeature(
      context(new ScriptedModel([]), store),
      "assistant",
      { table: "app.records", id: "r1" },
      async (model) => ({
        kind: "answer",
        value: model,
        prompt: "Ask ivy@example.com",
        output: "Call (305) 555-0142",
        usage: { inputTokens: 5, outputTokens: 6 },
        proposals: [
          { operationId: "records.update", targetId: "r1", summary: "Retitle.", fields: [] },
        ],
      }),
    );
    expect(log.completed[0]).toMatchObject({
      outcome: "Answered",
      prompt: "Ask [email]",
      output: "Call [phone]",
    });
    expect(result).toMatchObject({
      kind: "answer",
      aiGenerated: true,
      value: "claude-sonnet-5-5",
      proposals: [{ suggestionId: "sug-1" }],
    });
  });

  it("fails when the request log or a proposal is refused", async () => {
    const answer = async () => ({
      kind: "answer" as const,
      value: 1,
      prompt: "",
      output: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      proposals: [{ operationId: "records.update", targetId: null, summary: "x", fields: [] }],
    });
    const logFails = memoryStore({ complete: { ok: false, error: { kind: "not-found" } } });
    expect(
      await runFeature(context(new ScriptedModel([]), logFails.store), "assistant", null, answer),
    ).toMatchObject({ code: "log_failed" });
    const refused = memoryStore({
      propose: { ok: false, error: { kind: "refusal", rule: "r", message: "No." } },
    });
    expect(
      await runFeature(context(new ScriptedModel([]), refused.store), "assistant", null, answer),
    ).toMatchObject({ code: "proposal_refused", message: "No." });
    const hidden = memoryStore({ propose: { ok: false, error: { kind: "not-found" } } });
    expect(
      await runFeature(context(new ScriptedModel([]), hidden.store), "assistant", null, answer),
    ).toMatchObject({ code: "proposal_refused" });
  });

  it("returns NO ANSWER with what is missing", async () => {
    const { store, log } = memoryStore();
    const result = await runFeature(
      context(new ScriptedModel([]), store),
      "summaries",
      null,
      async () => ({
        kind: "no-answer",
        missing: "No activity this week.",
        prompt: "p",
        output: "o",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    expect(result).toMatchObject({
      kind: "no-answer",
      missing: "No activity this week.",
      aiGenerated: true,
    });
    expect(log.completed[0]?.outcome).toBe("No Answer");
    expect(localNoAnswer("Nothing yet.")).toEqual({
      kind: "no-answer",
      aiGenerated: true,
      requestId: null,
      model: null,
      missing: "Nothing yet.",
    });
  });
});
