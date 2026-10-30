import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  draftList,
  loadModelConfig,
  NeverSendList,
  type AuroraContext,
  type ModelRequest,
  type ProposedChange,
} from "@xos/ai";
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

  it("reaches the API route only behind a literal production check the build removes", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../app/api/v1/[...path]/route.ts", import.meta.url)),
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

describe("fixture drafted lists (P6)", () => {
  const proposals: ProposedChange[] = [];
  const ctx: AuroraContext = {
    orgId: "o1",
    client: new FixtureModelClient(),
    config: loadModelConfig({}),
    today: "2026-10-30",
    store: {
      begin: async () => ({ ok: true, data: "req-1" }),
      complete: async () => ({ ok: true, data: null }),
      propose: async (_id, change) => {
        proposals.push(change);
        return { ok: true, data: `s${proposals.length}` };
      },
    },
  };
  const neverSend = new NeverSendList([]);

  it("drafts a run of show from the context, with an overlap and an untimed [needs:] line", async () => {
    proposals.length = 0;
    const result = await draftList(ctx, {
      kind: "run_of_show",
      instructions: "Draft the running order.",
      target: { table: "app.run_of_show", id: "r1" },
      context: [
        {
          table: "app.run_of_show",
          id: "r1",
          data: { name: "Opening Night", show_date: "2027-06-05" },
        },
        { table: "app.records", id: "e1", data: { title: "Harbor Lights Headline Set" } },
      ],
      verbiage: [],
      neverSend,
      runOfShow: { runOfShowId: "r1", showDate: "2027-06-05", timeZone: "America/New_York" },
    });
    if (result.kind !== "answer" || result.value.kind !== "run_of_show")
      throw new Error("no draft");
    expect(result.value.items.map((c) => c.label)).toEqual([
      "Doors",
      "Support Act",
      "Harbor Lights Headline Set",
      "House Lights Up",
      "Walk-In Music",
    ]);
    expect(result.value.flags).toEqual([
      { type: "overlap", positions: [1, 2], minutes: 15 },
      { type: "untimed", positions: [5] },
    ]);
    expect(result.value.gaps).toEqual(["the walk-in music time"]);
    expect(proposals).toHaveLength(5);
  });

  it("answers NO ANSWER for a run of show without its running order in the context", async () => {
    const result = await draftList(ctx, {
      kind: "run_of_show",
      instructions: "Draft it.",
      target: { table: "app.run_of_show", id: "r1" },
      context: [],
      verbiage: [],
      neverSend,
      runOfShow: { runOfShowId: "r1", showDate: "2027-06-05", timeZone: "UTC" },
    });
    expect(result.kind).toBe("no-answer");
  });

  it("drafts risks only in the categories it is given", async () => {
    proposals.length = 0;
    const result = await draftList(ctx, {
      kind: "risk_assessment",
      instructions: "Assess the festival.",
      target: { table: "app.projects", id: "p1" },
      context: [{ table: "app.projects", id: "p1", data: { name: "Bayfront Festival" } }],
      verbiage: [],
      neverSend,
      risks: { projectId: "p1", categories: ["Safety", "Operational", "Schedule"] },
    });
    if (result.kind !== "answer" || result.value.kind !== "risk_assessment") {
      throw new Error("no draft");
    }
    expect(result.value.items.map((r) => [r.title, r.category])).toEqual([
      ["Crowd Surge at the Barricade", "Safety"],
      ["Afternoon Thunderstorm", "Operational"],
      ["Changeover Overrun", "Schedule"],
    ]);
    expect(proposals.map((p) => p.operationId)).toEqual([
      "records.create",
      "records.create",
      "records.create",
    ]);
  });
});
