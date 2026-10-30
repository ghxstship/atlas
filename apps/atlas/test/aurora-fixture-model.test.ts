import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@xos/ai";
import { describe, expect, it } from "vitest";
import {
  createFixtureModel,
  FIXTURE_CERTIFICATE_POLICY,
  FixtureModelClient,
  FixtureModelRefused,
  fixtureModelEnabled,
} from "@/lib/aurora/fixture-model";

/**
 * Aurora's end-to-end fixture model (finding A24-007): impossible to enable in production, and
 * answering only from its recorded journey fixtures.
 */
describe("fixture model gate", () => {
  it("is refused in production, even with XOS_AI_FAKE=1", () => {
    const production = { NODE_ENV: "production", XOS_AI_FAKE: "1" };
    expect(fixtureModelEnabled(production)).toBe(false);
    expect(() => createFixtureModel(production)).toThrow(FixtureModelRefused);
  });

  it("is off outside production unless XOS_AI_FAKE is exactly 1", () => {
    for (const env of [
      { NODE_ENV: "development" },
      { NODE_ENV: "test", XOS_AI_FAKE: "true" },
      { NODE_ENV: "development", XOS_AI_FAKE: "0" },
    ]) {
      expect(fixtureModelEnabled(env)).toBe(false);
      expect(() => createFixtureModel(env)).toThrow(FixtureModelRefused);
    }
  });

  it("is on in development and test with XOS_AI_FAKE=1", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(fixtureModelEnabled({ NODE_ENV, XOS_AI_FAKE: "1" })).toBe(true);
      expect(createFixtureModel({ NODE_ENV, XOS_AI_FAKE: "1" })).toBeInstanceOf(FixtureModelClient);
    }
  });

  it("reaches the API app only behind a literal production check the build removes", () => {
    // B16 moved the app the v1 route and the hosted MCP endpoint share into lib/api/app.ts.
    const route = readFileSync(
      fileURLToPath(new URL("../lib/api/app.ts", import.meta.url)),
      "utf8",
    );
    const guard = route.indexOf('if (process.env.NODE_ENV === "production") return undefined;');
    const load = route.indexOf('await import("@/lib/aurora/fixture-model")');
    expect(guard).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(guard);
    expect(route).not.toMatch(/^import .*fixture-model/m);
  });
});

const block = (source: string, rows: unknown[]) =>
  `<data source="${source}">\n${JSON.stringify(rows, null, 1)}\n</data>`;

function ask(question: string, results: string[] = []): ModelRequest {
  return {
    model: "fixture",
    system: "",
    maxTokens: 100,
    tools: ["list_records", "get_record", "propose_change", "answer"].map((name) => ({
      name,
      description: name,
      inputSchema: {},
    })),
    messages: [
      { role: "user", content: [{ type: "text", text: block("question", [question]) }] },
      ...results.flatMap((content, i) => [
        {
          role: "assistant" as const,
          content: [{ type: "tool_use" as const, id: `t${i}`, name: "list_records", input: {} }],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, toolUseId: `t${i}`, content }],
        },
      ]),
    ],
  };
}

describe("fixture model answers", () => {
  const model = new FixtureModelClient();

  it("reads projects, then blocked permits, then cites them (journey 35)", async () => {
    const q = "Which permits are blocked in US-FL-MIAMI-DADE?";
    const first = await model.complete(ask(q));
    expect(first.content[0]).toMatchObject({ name: "list_records", input: { path: "projects" } });
    const second = await model.complete(ask(q, [block("projects", [{ project_key: "NWS" }])]));
    expect(second.content[0]).toMatchObject({
      input: {
        path: "records",
        filters: expect.arrayContaining([{ field: "record_state", op: "eq", value: "Blocked" }]),
      },
    });
    // A blocked permit of a project outside the jurisdiction is left out of the answer.
    const final = await model.complete(
      ask(q, [
        block("projects", [{ project_key: "NWS" }]),
        block("records", [
          { id: "r1", record_key: "NWS-9", title: "Special Event Permit" },
          { id: "r2", record_key: "BOS-4", title: "Harbor Permit" },
        ]),
      ]),
    );
    expect(final.content[0]).toMatchObject({
      name: "answer",
      input: { citations: [{ path: "records", id: "r1", label: "Special Event Permit" }] },
    });
  });

  it("answers NO ANSWER for an unpriced line instead of a price (journey 35)", async () => {
    const q = "What does the guard booth cost?";
    const final = await model.complete(
      ask(q, [
        block("budget-lines", [
          { id: "b1", description: "Guard booth for the back gate.", unit_price_minor: null },
        ]),
      ]),
    );
    expect(final.content[0]).toMatchObject({ name: "answer", input: { no_answer: {} } });
  });

  it("refuses questions it has no recording for", async () => {
    const final = await model.complete(ask("Who won the game last night?"));
    expect(final.content[0]).toMatchObject({ name: "answer", input: { no_answer: {} } });
  });

  it("reads the recorded certificate and nothing else (journey 36)", async () => {
    const certificate = [
      "CERTIFICATE OF LIABILITY INSURANCE",
      "INSURER A: Atlantic Mutual",
      `POLICY NUMBER: ${FIXTURE_CERTIFICATE_POLICY}`,
      "COMMERCIAL GENERAL LIABILITY",
      "EACH OCCURRENCE $ 2,000,000",
      "POLICY EFFECTIVE 2026-10-01",
      "POLICY EXPIRATION 2027-09-30",
      "All amounts in USD",
    ].join("\n");
    const extract = (text: string): ModelRequest => ({
      model: "fixture",
      system: "",
      maxTokens: 100,
      tools: [{ name: "record_fields", description: "", inputSchema: {} }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              mediaType: "text/plain",
              data: text,
            },
          ],
        },
      ],
    });
    const known = await model.complete(extract(certificate));
    const fields = (
      known.content[0] as { input: { fields: { field_path: string; value: unknown }[] } }
    ).input.fields;
    expect(fields.find((f) => f.field_path === "coverage_limit_minor")?.value).toBe(200000000);
    const other = await model.complete(extract("Some other certificate"));
    const none = (other.content[0] as { input: { fields: { value: unknown }[] } }).input.fields;
    expect(none.every((f) => f.value === null)).toBe(true);
  });
});
