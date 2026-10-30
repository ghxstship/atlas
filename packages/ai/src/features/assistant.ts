import { z } from "zod";
import {
  addUsage,
  NO_USAGE,
  responseText,
  type ModelContent,
  type ModelMessage,
  type ModelTool,
  type ModelUsage,
  type ToolResultContent,
} from "../model.ts";
import type { NeverSendList } from "../redact.ts";
import { scrubRecord } from "../redact.ts";
import {
  FeatureError,
  runFeature,
  type AuroraContext,
  type AuroraResult,
  type ProposedChange,
} from "../session.ts";
import { FILTER_OPERATORS } from "./filters.ts";
import { dataBlock, GUARDRAILS, promptLog } from "./shared.ts";

/**
 * The assistant (Section 4.7). It answers questions about the org's data with links to the records
 * it used, reading only through the public API with the person's own token, so it can never see or
 * do more than they can. Every answer must cite records it actually read in this conversation; an
 * answer without one is NO ANSWER. It never writes: `propose_change` stores a suggestion the person
 * confirms on a step that shows exactly what will change.
 */

/** A readable collection: a list operation of the OpenAPI v1 document and its source table. */
export interface ApiCollection {
  /** Path without the leading slash, for example `permits`. */
  readonly path: string;
  readonly table: string;
  readonly description: string;
}

/** The public API, called with the person's own bearer token by the caller. */
export interface PublicApi {
  get(
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface Citation {
  readonly path: string;
  readonly id: string;
  readonly label: string;
}

export interface AssistantAnswer {
  readonly text: string;
  readonly citations: readonly Citation[];
}

export interface AssistantTurn {
  readonly question: string;
  readonly answer: string;
}

export interface AssistantInput {
  readonly question: string;
  readonly history: readonly AssistantTurn[];
  readonly collections: readonly ApiCollection[];
  /** Operation ids the assistant may propose (create and update operations of the same API). */
  readonly writableOperations: readonly string[];
  readonly api: PublicApi;
  readonly neverSend: NeverSendList;
  /** At most this many model turns; each tool round trip is one turn. */
  readonly maxTurns?: number;
}

const ListInput = z.object({
  path: z.string(),
  filters: z
    .array(
      z.object({ field: z.string().regex(/^[a-z][a-z0-9_]*$/), op: z.string(), value: z.string() }),
    )
    .default([]),
  limit: z.number().int().min(1).max(25).default(10),
});
const GetInput = z.object({ path: z.string(), id: z.string().uuid() });
const ProposeInput = z.object({
  operation_id: z.string(),
  target_id: z.string().uuid().nullable(),
  summary: z.string().min(1).max(1000),
  fields: z.array(
    z.object({ field_path: z.string(), value: z.unknown(), confidence: z.number().min(0).max(1) }),
  ),
});
const AnswerInput = z.union([
  z.object({
    text: z.string().min(1).max(4000),
    citations: z.array(z.object({ path: z.string(), id: z.string(), label: z.string() })),
  }),
  z.object({ no_answer: z.object({ missing: z.string().min(1).max(500) }) }),
]);

const OPERATORS = new Set<string>(FILTER_OPERATORS);

function tools(): ModelTool[] {
  const schema = (s: z.ZodType) => z.toJSONSchema(s) as Record<string, unknown>;
  return [
    {
      name: "list_records",
      description:
        "Lists records of one collection with ADR 0003 filters (eq, ne, lt, lte, gt, gte, in, is_null, contains).",
      inputSchema: schema(ListInput),
    },
    { name: "get_record", description: "Reads one record by id.", inputSchema: schema(GetInput) },
    {
      name: "propose_change",
      description: "Proposes a change the person will review and confirm. Never claim it is done.",
      inputSchema: schema(ProposeInput),
    },
    {
      name: "answer",
      description:
        "Gives the final answer with citations to records you read, or no_answer with what is missing.",
      inputSchema: schema(AnswerInput),
    },
  ];
}

interface Seen {
  readonly path: string;
  readonly id: string;
}

/** Runs one read tool through the public API and returns the scrubbed result for the model. */
async function runRead(
  name: "list_records" | "get_record",
  raw: unknown,
  input: AssistantInput,
  seen: Map<string, Seen>,
): Promise<{ content: string; isError: boolean }> {
  const parsed = name === "list_records" ? ListInput.safeParse(raw) : GetInput.safeParse(raw);
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true };
  const collection = input.collections.find((c) => c.path === parsed.data.path);
  if (!collection) return { content: `You cannot read ${parsed.data.path}.`, isError: true };
  if (input.neverSend.excludesTable(collection.table)) {
    return { content: `${parsed.data.path} is never shared with Aurora.`, isError: true };
  }

  let response: { status: number; body: unknown };
  if ("id" in parsed.data) {
    response = await input.api.get(`/${collection.path}/${parsed.data.id}`, {});
  } else {
    const query: Record<string, string> = { limit: String(parsed.data.limit) };
    for (const f of parsed.data.filters) {
      if (!OPERATORS.has(f.op)) return { content: `Unknown operator ${f.op}.`, isError: true };
      query[`filter[${f.field}][${f.op}]`] = f.value;
    }
    response = await input.api.get(`/${collection.path}`, query);
  }
  if (response.status === 404)
    return { content: "Not found, or not visible to this person.", isError: false };
  if (response.status >= 400) {
    return {
      content: `The API answered ${response.status}: ${JSON.stringify(response.body)}`,
      isError: true,
    };
  }

  const rows: unknown[] =
    "id" in parsed.data
      ? [response.body]
      : (((response.body as { data?: unknown[] }).data ?? []) as unknown[]);
  const scrubbed = rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => scrubRecord(collection.table, row, input.neverSend))
    .filter((row) => row !== null);
  for (const row of scrubbed) {
    const id = row["id"];
    if (typeof id === "string") seen.set(id, { path: collection.path, id });
  }
  return { content: dataBlock(collection.path, scrubbed), isError: false };
}

function historyMessages(history: readonly AssistantTurn[]): ModelMessage[] {
  return history.flatMap((turn): ModelMessage[] => [
    { role: "user", content: [{ type: "text", text: turn.question }] },
    { role: "assistant", content: [{ type: "text", text: turn.answer }] },
  ]);
}

export async function askAssistant(
  ctx: AuroraContext,
  input: AssistantInput,
): Promise<AuroraResult<AssistantAnswer>> {
  return runFeature(ctx, "assistant", null, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      "Task: answer the person's question about their org's data. Read records with list_records and get_record, then call answer.",
      "Cite every record your answer relies on. When the records do not answer the question, call answer with no_answer and say what is missing.",
      "When the person asks you to change something, call propose_change with exactly what would change. The person confirms it; you never say it is done.",
      `Today is ${ctx.today}.`,
      `Collections you can read:\n${input.collections.map((c) => `- ${c.path}: ${c.description}`).join("\n")}`,
      `Operations you can propose: ${input.writableOperations.join(", ") || "none"}.`,
    ].join("\n\n");
    const messages: ModelMessage[] = [
      ...historyMessages(input.history),
      { role: "user", content: [{ type: "text", text: dataBlock("question", input.question) }] },
    ];
    const seen = new Map<string, Seen>();
    const proposals: ProposedChange[] = [];
    const transcript: string[] = [];
    let usage: ModelUsage = NO_USAGE;
    const maxTurns = input.maxTurns ?? 8;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await ctx.client.complete({
        model,
        system,
        maxTokens,
        messages,
        tools: tools(),
        toolChoice: { type: "auto" },
      });
      usage = addUsage(usage, response.usage);
      transcript.push(responseText(response));
      const prompt = promptLog(
        system,
        messages.flatMap((m) => m.content),
      );
      const log = () => ({ prompt, output: transcript.join("\n"), usage });

      const uses = response.content.filter((c) => c.type === "tool_use");
      const final = uses.find((u) => u.name === "answer");
      if (final) {
        const parsed = AnswerInput.safeParse(final.input);
        if (!parsed.success) {
          throw new FeatureError(
            "model_output_invalid",
            `The answer failed validation: ${parsed.error.message}`,
          );
        }
        if ("no_answer" in parsed.data) {
          return { kind: "no-answer", missing: parsed.data.no_answer.missing, ...log() };
        }
        const citations = parsed.data.citations.filter((c) => seen.has(c.id));
        if (citations.length === 0 && proposals.length === 0) {
          return {
            kind: "no-answer",
            missing: "No record you can see supports an answer to this question.",
            ...log(),
          };
        }
        return {
          kind: "answer",
          value: { text: parsed.data.text, citations },
          ...log(),
          proposals,
        };
      }
      if (uses.length === 0) {
        return {
          kind: "no-answer",
          missing: "No record you can see supports an answer to this question.",
          ...log(),
        };
      }

      const results: ToolResultContent[] = [];
      for (const use of uses) {
        if (use.name === "list_records" || use.name === "get_record") {
          const r = await runRead(use.name, use.input, input, seen);
          results.push({
            type: "tool_result",
            toolUseId: use.id,
            content: r.content,
            isError: r.isError,
          });
        } else if (use.name === "propose_change") {
          const parsed = ProposeInput.safeParse(use.input);
          if (!parsed.success || !input.writableOperations.includes(parsed.data.operation_id)) {
            results.push({
              type: "tool_result",
              toolUseId: use.id,
              content: parsed.success
                ? `You cannot propose ${parsed.data.operation_id}.`
                : parsed.error.message,
              isError: true,
            });
          } else {
            proposals.push({
              operationId: parsed.data.operation_id,
              targetId: parsed.data.target_id,
              summary: parsed.data.summary,
              fields: parsed.data.fields.map((f) => ({
                field_path: f.field_path,
                value: f.value,
                confidence: f.confidence,
              })),
            });
            results.push({
              type: "tool_result",
              toolUseId: use.id,
              content:
                "Proposed. The person will see it and decide; tell them it is waiting for their confirmation.",
            });
          }
        } else {
          results.push({
            type: "tool_result",
            toolUseId: use.id,
            content: `Unknown tool ${use.name}.`,
            isError: true,
          });
        }
      }
      messages.push({ role: "assistant", content: response.content as ModelContent[] });
      messages.push({ role: "user", content: results });
    }
    return {
      kind: "no-answer",
      missing:
        "The question needed more lookups than one request allows. Ask about one project or record at a time.",
      prompt: promptLog(
        system,
        messages.flatMap((m) => m.content),
      ),
      output: transcript.join("\n"),
      usage,
    };
  });
}

/** Builds the readable collections from the OpenAPI v1 document: GET list operations with a source table. */
export function collectionsFromOpenApi(
  document: unknown,
  allow?: ReadonlySet<string>,
): ApiCollection[] {
  const paths = (document as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};
  const out: ApiCollection[] = [];
  for (const [path, operations] of Object.entries(paths)) {
    if (path.includes("{")) continue;
    const get = operations["get"] as { "x-xos-table"?: string; summary?: string } | undefined;
    const table = get?.["x-xos-table"];
    if (!get || typeof table !== "string") continue;
    const name = path.slice(1);
    if (allow && !allow.has(name)) continue;
    out.push({ path: name, table, description: get.summary ?? name });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Create and update operation ids of the OpenAPI v1 document, the only changes the assistant may propose. */
export function writableOperationsFromOpenApi(document: unknown): string[] {
  const paths = (document as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};
  const out: string[] = [];
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(operations)) {
      const id = (op as { operationId?: string } | null)?.operationId;
      if (!id) continue;
      const isCreate = method === "post" && !path.includes("{");
      const isUpdate = method === "patch";
      if (isCreate || isUpdate) out.push(id);
    }
  }
  return out.sort();
}

/** Collections the Compass assistant answers from: the org's SOPs, handbook and records it is asked about (AI notice section 3). */
export const COMPASS_ASSISTANT_COLLECTIONS: ReadonlySet<string> = new Set([
  "sops",
  "documents",
  "shifts",
  "records",
  "day-sheets",
  "emergency-codes",
]);
