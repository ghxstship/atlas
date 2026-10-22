import { z } from "zod";
import { runFeature, type AuroraContext, type AuroraResult } from "../session.ts";
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Ask in plain language (Section 4.7): a sentence becomes a filter on one collection, shown to the
 * person as the filter it built, and proposed as a saved view (`savedViews.create`) they confirm.
 * Fields, operators and enum values are checked against the catalog the caller passes, which
 * lists only what the person can see. Anything outside it refuses with NO_ANSWER.
 */

/** ADR 0003 filter operators. */
export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "contains",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface CatalogField {
  readonly name: string;
  readonly type: "string" | "number" | "date" | "boolean" | "enum" | "uuid";
  readonly values?: readonly string[];
  /** What the field means, in a sentence, when its name alone does not say (A95). */
  readonly description?: string;
  /** The only operators the field takes, when it does not take them all (a page's own filters). */
  readonly ops?: readonly FilterOperator[];
}

export interface FilterCollection {
  /** Collection path without the leading slash, for example `permits`. */
  readonly collection: string;
  readonly fields: readonly CatalogField[];
}

export interface FilterCondition {
  readonly field: string;
  readonly op: FilterOperator;
  readonly value: string;
}

export interface BuiltFilter {
  readonly collection: string;
  readonly name: string;
  readonly conditions: readonly FilterCondition[];
  readonly sort: readonly string[];
  /** The ADR 0003 query string, for example `filter[permit_state][eq]=Blocked&sort=-due_on`. */
  readonly query: string;
}

const FilterSchema = z.union([
  z.object({
    collection: z.string(),
    name: z.string().min(1).max(80),
    conditions: z.array(
      z.object({ field: z.string(), op: z.enum(FILTER_OPERATORS), value: z.string() }),
    ),
    sort: z.array(z.string()).default([]),
  }),
  z.object({ no_answer: z.object({ missing: z.string().min(1).max(500) }) }),
]);

export function toQuery(conditions: readonly FilterCondition[], sort: readonly string[]): string {
  const parts = conditions.map(
    (c) => `filter[${encodeURIComponent(c.field)}][${c.op}]=${encodeURIComponent(c.value)}`,
  );
  if (sort.length > 0) parts.push(`sort=${sort.map(encodeURIComponent).join(",")}`);
  return parts.join("&");
}

const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/** Checks a built filter against the catalog; returns what is wrong, or null when it is valid. */
export function validateFilter(
  catalog: readonly FilterCollection[],
  filter: { collection: string; conditions: readonly FilterCondition[]; sort: readonly string[] },
): string | null {
  const collection = catalog.find((c) => c.collection === filter.collection);
  if (!collection) return `There is no ${filter.collection} collection you can filter.`;
  const fields = new Map(collection.fields.map((f) => [f.name, f]));
  for (const condition of filter.conditions) {
    const field = fields.get(condition.field);
    if (!field) return `${filter.collection} has no field named ${condition.field}.`;
    if (field.ops && !field.ops.includes(condition.op)) {
      return `${field.name} cannot be filtered with ${condition.op}.`;
    }
    const values = condition.op === "in" ? condition.value.split(",") : [condition.value];
    for (const value of values) {
      if (condition.op === "is_null") {
        if (value !== "true" && value !== "false") return "is_null takes true or false.";
      } else if (field.type === "enum" && !field.values?.includes(value)) {
        return `${value} is not a value of ${field.name}.`;
      } else if (field.type === "date" && !DATE.test(value)) {
        return `${value} is not a date for ${field.name}.`;
      } else if (field.type === "number" && Number.isNaN(Number(value))) {
        return `${value} is not a number for ${field.name}.`;
      } else if (field.type === "boolean" && value !== "true" && value !== "false") {
        return `${field.name} is true or false.`;
      }
    }
  }
  for (const key of filter.sort) {
    if (!fields.has(key.replace(/^-/, ""))) return `${filter.collection} cannot sort by ${key}.`;
  }
  return null;
}

export interface FilterInput {
  readonly sentence: string;
  readonly catalog: readonly FilterCollection[];
  readonly timeZone: string;
}

export async function buildFilter(
  ctx: AuroraContext,
  input: FilterInput,
): Promise<AuroraResult<BuiltFilter>> {
  return runFeature(ctx, "plain_language", null, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      "Task: turn the person's sentence into a filter on exactly one collection from the catalog.",
      `Today is ${ctx.today} in ${input.timeZone}. Resolve relative dates such as "this month" into YYYY-MM-DD bounds with gte and lte.`,
      "Use only collections, fields and enum values from the catalog, spelled exactly. For in, join values with commas.",
      "A field's description says what it means. When a field lists ops, use only those operators on it.",
      "Name the view in Title Case, at most 6 words. When the sentence asks for something the catalog cannot express, answer with no_answer and say what is missing.",
    ].join("\n\n");
    const result = await callTool({
      client: ctx.client,
      model,
      maxTokens,
      system,
      content: [
        { type: "text", text: dataBlock("catalog", input.catalog) },
        { type: "text", text: dataBlock("sentence", input.sentence) },
      ],
      tool: {
        name: "build_filter",
        description: "Returns the filter, or no_answer with what is missing.",
        inputSchema: z.toJSONSchema(FilterSchema) as Record<string, unknown>,
      },
      schema: FilterSchema,
    });
    const value = result.value;
    if ("no_answer" in value) {
      return { kind: "no-answer", missing: value.no_answer.missing, ...logOf(result) };
    }
    const problem = validateFilter(input.catalog, value);
    if (problem) return { kind: "no-answer", missing: problem, ...logOf(result) };
    const query = toQuery(value.conditions, value.sort);
    const built: BuiltFilter = { ...value, query };
    return {
      kind: "answer",
      value: built,
      ...logOf(result),
      proposals: [
        {
          operationId: "savedViews.create",
          targetId: null,
          summary: `Save the view ${value.name} on ${value.collection} with the filter ${query || "showing everything"}.`,
          fields: [
            { field_path: "collection", value: value.collection, confidence: 1 },
            { field_path: "name", value: value.name, confidence: 1 },
            { field_path: "view_type", value: "list", confidence: 1 },
            { field_path: "query", value: query, confidence: 1 },
            { field_path: "shared", value: false, confidence: 1 },
          ],
        },
      ],
    };
  });
}

function logOf(result: {
  prompt: string;
  output: string;
  usage: { inputTokens: number; outputTokens: number };
}) {
  return { prompt: result.prompt, output: result.output, usage: result.usage };
}
