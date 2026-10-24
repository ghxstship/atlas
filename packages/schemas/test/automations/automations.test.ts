/**
 * The automation documents (A91, ADR 0047): the Zod schemas, the generated JSON Schema and the evaluator against the
 * vectors the database runs too (pgTAP 1480 embeds the same JSON), plus the template renderer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AutomationActions,
  AutomationConditions,
  AutomationDefinition,
  automationJsonSchema,
  compareCodePoints,
  conditionsMatch,
  countConditions,
  explainConditions,
  renderField,
  renderTemplate,
  valueAt,
} from "../../src/automations/index.ts";
import {
  AUTOMATION_SCHEMA_FILE,
  renderAutomationSchema,
} from "../../src/automations/json-schema.ts";
import vectors from "../../src/automations/vectors.json" with { type: "json" };

const root = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

interface MatchVector {
  readonly name: string;
  readonly conditions: unknown;
  readonly expected: boolean;
}

describe("shared vectors", () => {
  it("the evaluator agrees with every match vector", () => {
    const disagree = (vectors.matches as MatchVector[]).filter((v) => {
      const parsed = AutomationConditions.parse(v.conditions);
      return conditionsMatch(parsed, vectors.event) !== v.expected;
    });
    expect(disagree.map((v) => v.name)).toEqual([]);
  });

  it("the Zod schema accepts every valid document and refuses every invalid one", () => {
    const wrong = [
      ...vectors.valid.filter((v) => !AutomationConditions.safeParse(v.conditions).success),
      ...vectors.invalid.filter((v) => AutomationConditions.safeParse(v.conditions).success),
      ...vectors.validActions.filter((v) => !AutomationActions.safeParse(v.actions).success),
      ...vectors.invalidActions.filter((v) => AutomationActions.safeParse(v.actions).success),
    ];
    expect(wrong.map((v) => v.name)).toEqual([]);
  });

  it("pgTAP 1480 embeds the same vectors", () => {
    const test = readFileSync(root("supabase/tests/1480_automations.test.sql"), "utf8");
    const match = /\$vectors\$\n([\s\S]*?)\n\$vectors\$/.exec(test);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? "null")).toEqual(vectors);
  });
});

describe("JSON Schema", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(automationJsonSchema());
  const definition = (
    conditions: unknown,
    actions: unknown = [{ type: "add_comment", body: "Hi" }],
  ) => ({
    name: "Pick up tasks",
    trigger_event_type: "record.created",
    conditions,
    actions,
  });

  it("is the committed automation.schema.json", () => {
    const committed = JSON.parse(
      readFileSync(root(`packages/schemas/${AUTOMATION_SCHEMA_FILE}`), "utf8"),
    );
    expect(committed).toEqual(JSON.parse(renderAutomationSchema()));
  });

  it("accepts every valid vector, as the database does", () => {
    const refused = [
      ...vectors.valid.filter((v) => !validate(definition(v.conditions))),
      ...vectors.validActions.filter((v) => !validate(definition({ all: [] }, v.actions))),
    ];
    expect(refused.map((v) => v.name)).toEqual([]);
  });

  it("refuses the invalid vectors it can express", () => {
    // Totals of conditions and blank titles need the Zod refinements and the SQL validator.
    const beyondJsonSchema = new Set([
      "twenty-one conditions and groups",
      "create_task with a blank title",
    ]);
    const accepted = [
      ...vectors.invalid.filter(
        (v) => !beyondJsonSchema.has(v.name) && validate(definition(v.conditions)),
      ),
      ...vectors.invalidActions.filter(
        (v) => !beyondJsonSchema.has(v.name) && validate(definition({ all: [] }, v.actions)),
      ),
    ];
    expect(accepted.map((v) => v.name)).toEqual([]);
  });

  it("describes a whole definition", () => {
    expect(
      validate(definition({ any: [{ field: "data.record_kind", operator: "eq", value: "Task" }] })),
    ).toBe(true);
    expect(validate({ ...definition({ all: [] }), trigger_event_type: "Record Created" })).toBe(
      false,
    );
    expect(
      AutomationDefinition.safeParse({ ...definition({ all: [] }), extra: true }).success,
    ).toBe(false);
  });
});

describe("evaluator", () => {
  it("reads paths through objects and arrays", () => {
    expect(valueAt({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
    expect(valueAt({ a: { b: null } }, "a.b")).toBeUndefined();
    expect(valueAt({ a: [1] }, "a.x")).toBeUndefined();
    expect(valueAt({ a: "text" }, "a.length")).toBeUndefined();
    expect(valueAt({}, "constructor")).toBeUndefined();
  });

  it("orders strings by code point", () => {
    expect(compareCodePoints("\u{1F600}", "�")).toBeGreaterThan(0);
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
    expect(compareCodePoints("b", "b")).toBe(0);
  });

  it("explains each condition of a dry run", () => {
    const result = explainConditions(
      {
        all: [
          { field: "data.record_kind", operator: "eq", value: "Task" },
          { any: [{ field: "data.flag", operator: "is_null" }] },
        ],
      },
      { data: { record_kind: "Build", flag: true } },
    );
    expect(result.matched).toBe(false);
    expect(result.conditions).toEqual([
      { field: "data.record_kind", operator: "eq", value: "Task", actual: "Build", matched: false },
      { field: "data.flag", operator: "is_null", value: null, actual: true, matched: false },
    ]);
  });

  it("counts conditions as the database does", () => {
    expect(
      countConditions([
        { field: "a", operator: "eq", value: "1" },
        { any: [{ field: "b", operator: "is_null" }] },
      ]),
    ).toBe(3);
  });
});

describe("templates", () => {
  const event = {
    data: { title: "Call the venue", number: 42, ok: false, tags: ["A"], gone: null },
  };

  it("fills double-brace paths from the event", () => {
    expect(renderTemplate("Review {{data.title}} ({{ data.number }}, {{data.ok}})", event)).toBe(
      "Review Call the venue (42, false)",
    );
    expect(renderTemplate("{{data.tags}}|{{data.gone}}|{{data.missing}}", event)).toBe('["A"]||');
  });

  it("leaves anything else in braces as typed", () => {
    expect(renderTemplate("{{ Data.Title }} {data.title} {{}}", event)).toBe(
      "{{ Data.Title }} {data.title} {{}}",
    );
  });

  it("trims and cuts a field to its limit in code points", () => {
    expect(renderField("  {{data.title}}  ", event, 200)).toBe("Call the venue");
    expect(renderField("\u{1F600}\u{1F600}\u{1F600}", event, 2)).toBe("\u{1F600}\u{1F600}");
  });
});
