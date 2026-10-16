import { z } from "zod";
import { runFeature, type AuroraContext, type AuroraResult } from "../session.ts";
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Mapping help (Section 4.7).
 *
 * - Import columns: suggests a target field for each spreadsheet column. The wizard shows the
 *   suggestions; the person accepts or changes each before the import runs. A field may be used once.
 * - Unknown scanned codes: suggests a catalog element for a code, only from the candidates the
 *   caller found, proposed as a `catalogBindings.create` change. The crosswalk is proposed and
 *   human-confirmed, never automatic (Section 3.9).
 */

export interface ImportColumn {
  readonly header: string;
  /** A few sample values; the caller strips Restricted columns before calling. */
  readonly samples: readonly string[];
}

export interface TargetField {
  readonly name: string;
  readonly description: string;
}

export interface ColumnMapping {
  readonly column: string;
  readonly field: string | null;
  readonly confidence: number;
}

const ColumnSchema = z.object({
  mappings: z.array(
    z.object({
      column: z.string(),
      field: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/** Keeps one mapping per column, drops unknown fields, and gives each field to its most confident column. */
export function settleMappings(
  columns: readonly ImportColumn[],
  fields: readonly TargetField[],
  raw: readonly ColumnMapping[],
): ColumnMapping[] {
  const fieldNames = new Set(fields.map((f) => f.name));
  const byColumn = new Map(raw.map((m) => [m.column, m]));
  const proposed = columns.map((c) => {
    const m = byColumn.get(c.header);
    return m && m.field !== null && fieldNames.has(m.field)
      ? { column: c.header, field: m.field, confidence: m.confidence }
      : { column: c.header, field: null, confidence: 0 };
  });
  const winner = new Map<string, ColumnMapping>();
  for (const m of proposed) {
    if (m.field === null) continue;
    const current = winner.get(m.field);
    if (!current || m.confidence > current.confidence) winner.set(m.field, m);
  }
  return proposed.map((m) =>
    m.field !== null && winner.get(m.field) !== m
      ? { column: m.column, field: null, confidence: 0 }
      : m,
  );
}

export interface ColumnMappingInput {
  readonly collection: string;
  readonly columns: readonly ImportColumn[];
  readonly fields: readonly TargetField[];
}

export async function suggestColumnMappings(
  ctx: AuroraContext,
  input: ColumnMappingInput,
): Promise<AuroraResult<readonly ColumnMapping[]>> {
  return runFeature(ctx, "mapping", null, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      `Task: map each spreadsheet column to one field of ${input.collection}, or to null when no field fits.`,
      "Judge by the header and the sample values. Use each field at most once. Give a confidence from 0 to 1.",
    ].join("\n\n");
    const result = await callTool({
      client: ctx.client,
      model,
      maxTokens,
      system,
      content: [
        { type: "text", text: dataBlock("target fields", input.fields) },
        { type: "text", text: dataBlock("columns", input.columns) },
      ],
      tool: {
        name: "map_columns",
        description: "Returns one mapping per column.",
        inputSchema: z.toJSONSchema(ColumnSchema) as Record<string, unknown>,
      },
      schema: ColumnSchema,
    });
    const mappings = settleMappings(input.columns, input.fields, result.value.mappings);
    const log = { prompt: result.prompt, output: result.output, usage: result.usage };
    if (mappings.every((m) => m.field === null)) {
      return {
        kind: "no-answer",
        missing: `No column matches a field of ${input.collection}. Map the columns by hand.`,
        ...log,
      };
    }
    return { kind: "answer", value: mappings, ...log };
  });
}

export interface CatalogCandidate {
  /** Canon element id, the `{URID}-{ORG}-{SEQ}` item id. */
  readonly elementId: string;
  readonly name: string;
  readonly urid: string;
}

export interface CodeBinding {
  readonly code: string;
  readonly elementId: string;
  readonly confidence: number;
  readonly reason: string;
}

const BindingSchema = z.union([
  z.object({
    element_id: z.string(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(300),
  }),
  z.object({ no_answer: z.object({ missing: z.string().min(1).max(500) }) }),
]);

export interface CodeBindingInput {
  readonly code: string;
  /** What the scanner or label said about the item, if anything. */
  readonly description: string | null;
  readonly candidates: readonly CatalogCandidate[];
}

export async function suggestCatalogBinding(
  ctx: AuroraContext,
  input: CodeBindingInput,
): Promise<AuroraResult<CodeBinding>> {
  return runFeature(ctx, "mapping", null, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      "Task: an unknown code was scanned. Choose the catalog element it most likely identifies, only from the candidates.",
      "When no candidate fits, or the code and description do not support a choice, answer no_answer and say what is missing.",
    ].join("\n\n");
    const result = await callTool({
      client: ctx.client,
      model,
      maxTokens,
      system,
      content: [
        { type: "text", text: dataBlock("candidates", input.candidates) },
        {
          type: "text",
          text: dataBlock("scanned code", { code: input.code, description: input.description }),
        },
      ],
      tool: {
        name: "bind_code",
        description: "Returns the chosen element id, or no_answer.",
        inputSchema: z.toJSONSchema(BindingSchema) as Record<string, unknown>,
      },
      schema: BindingSchema,
    });
    const log = { prompt: result.prompt, output: result.output, usage: result.usage };
    const value = result.value;
    if ("no_answer" in value)
      return { kind: "no-answer", missing: value.no_answer.missing, ...log };
    const candidate = input.candidates.find((c) => c.elementId === value.element_id);
    if (!candidate) {
      return {
        kind: "no-answer",
        missing: "None of the catalog candidates matches this code.",
        ...log,
      };
    }
    return {
      kind: "answer",
      value: {
        code: input.code,
        elementId: candidate.elementId,
        confidence: value.confidence,
        reason: value.reason,
      },
      ...log,
      proposals: [
        {
          operationId: "catalogBindings.create",
          targetId: null,
          summary: `Bind code ${input.code} to ${candidate.name} (${candidate.urid}).`,
          fields: [
            { field_path: "tenant_item_code", value: input.code, confidence: 1 },
            { field_path: "element_id", value: candidate.elementId, confidence: value.confidence },
          ],
        },
      ],
    };
  });
}
