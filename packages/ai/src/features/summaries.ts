import { z } from "zod";
import type { NeverSendList } from "../redact.ts";
import { scrubRecord } from "../redact.ts";
import {
  localNoAnswer,
  runFeature,
  type AuroraContext,
  type AuroraResult,
  type Subject,
} from "../session.ts";
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Summaries (Section 4.7): a record's activity, a project's week and gate readiness. Every bullet
 * cites the items it came from; a bullet without a citation to a supplied item is dropped, and a
 * summary with no supported bullet is NO ANSWER. With nothing to summarize no model call is made
 * and nothing is metered.
 */

export const SUMMARY_KINDS = ["record_activity", "project_week", "gate_readiness"] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export interface SummaryItem {
  readonly id: string;
  /** Source table, so Restricted columns and excluded tables are stripped. */
  readonly table: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SummaryBullet {
  readonly text: string;
  readonly citations: readonly string[];
}

export interface Summary {
  readonly kind: SummaryKind;
  readonly headline: string;
  readonly bullets: readonly SummaryBullet[];
}

const SummarySchema = z.union([
  z.object({
    headline: z.string().min(1).max(200),
    bullets: z
      .array(z.object({ text: z.string().min(1).max(400), citations: z.array(z.string()) }))
      .max(12),
  }),
  z.object({ no_answer: z.object({ missing: z.string().min(1).max(500) }) }),
]);

const FOCUS: Readonly<Record<SummaryKind, string>> = {
  record_activity:
    "Summarize what happened on this record: changes, decisions and open questions, newest first.",
  project_week:
    "Summarize the project's week: what moved, what is blocked, and what is due next week.",
  gate_readiness:
    "Summarize gate readiness: which criteria have evidence, which are missing, and which block the gate. Never call a gate ready when a blocking criterion lacks evidence.",
};

export interface SummaryInput {
  readonly kind: SummaryKind;
  readonly subject: Subject;
  readonly items: readonly SummaryItem[];
  readonly neverSend: NeverSendList;
}

export async function summarize(
  ctx: AuroraContext,
  input: SummaryInput,
): Promise<AuroraResult<Summary>> {
  const items = input.items
    .map((item) => {
      const data = scrubRecord(item.table, item.data, input.neverSend);
      return data ? { id: item.id, data } : null;
    })
    .filter(
      (item): item is { id: string; data: Readonly<Record<string, unknown>> } => item !== null,
    );
  if (items.length === 0) {
    return localNoAnswer("There is no activity to summarize yet.");
  }
  const known = new Set(items.map((item) => item.id));

  return runFeature(ctx, "summaries", input.subject, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      FOCUS[input.kind],
      `Today is ${ctx.today}. Each bullet lists the ids of the items it relies on in citations. Use at most 8 bullets.`,
    ].join("\n\n");
    const result = await callTool({
      client: ctx.client,
      model,
      maxTokens,
      system,
      content: [{ type: "text", text: dataBlock("items", items) }],
      tool: {
        name: "summary",
        description: "Returns the summary, or no_answer with what is missing.",
        inputSchema: z.toJSONSchema(SummarySchema) as Record<string, unknown>,
      },
      schema: SummarySchema,
    });
    const log = { prompt: result.prompt, output: result.output, usage: result.usage };
    if ("no_answer" in result.value) {
      return { kind: "no-answer", missing: result.value.no_answer.missing, ...log };
    }
    const bullets = result.value.bullets
      .map((b) => ({ text: b.text, citations: b.citations.filter((id) => known.has(id)) }))
      .filter((b) => b.citations.length > 0);
    if (bullets.length === 0) {
      return { kind: "no-answer", missing: "The activity does not support a summary.", ...log };
    }
    return {
      kind: "answer",
      value: { kind: input.kind, headline: result.value.headline, bullets },
      ...log,
    };
  });
}
