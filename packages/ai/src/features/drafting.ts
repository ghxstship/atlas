import { z } from "zod";
import type { NeverSendList } from "../redact.ts";
import { scrubRecord } from "../redact.ts";
import { runFeature, type AuroraContext, type AuroraResult, type Subject } from "../session.ts";
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Drafting (Section 4.7): SOPs, advance packets, emails, day sheets and change order descriptions,
 * in the org's verbiage library. A draft is returned to the editor the person is in; nothing is
 * saved or sent until they do it themselves. Facts the context does not hold (a price, date or
 * quantity) are left as a visible gap marked `[needs: ...]`, never invented, and listed in `gaps`.
 */

export const DRAFT_KINDS = [
  "sop",
  "advance_packet",
  "email",
  "day_sheet",
  "change_order_description",
] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** A verbiage library entry: the term the org avoids and the phrasing it prefers. */
export interface VerbiageEntry {
  readonly term: string;
  readonly preferred: string;
}

export interface ContextRecord {
  readonly table: string;
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface Draft {
  readonly kind: DraftKind;
  readonly title: string;
  /** Markdown body. */
  readonly body: string;
  /** Facts the draft needs that the context did not hold. */
  readonly gaps: readonly string[];
  /** Library terms the model replaced but the body still contains, for the editor to flag. */
  readonly verbiageMisses: readonly string[];
}

const DraftSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  gaps: z.array(z.string().max(300)).default([]),
});

const GUIDE: Readonly<Record<DraftKind, string>> = {
  sop: "Draft a standard operating procedure: purpose, scope, numbered steps in imperative voice, and who is responsible.",
  advance_packet:
    "Draft an advance packet cover note: what the recipient must return, by when, and whom to contact.",
  email: "Draft a short, courteous email. Do not add a signature block.",
  day_sheet: "Draft a day sheet: the day's schedule in time order, locations and contacts by role.",
  change_order_description:
    "Draft a change order description: what changes, why, and the scope affected. Never state a cost the context does not give.",
};

/** Library terms still present in the text, compared case-insensitively on word boundaries. */
export function findVerbiageMisses(text: string, library: readonly VerbiageEntry[]): string[] {
  return library
    .filter((entry) =>
      new RegExp(`\\b${entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
    )
    .map((entry) => entry.term);
}

export interface DraftInput {
  readonly kind: DraftKind;
  readonly instructions: string;
  readonly context: readonly ContextRecord[];
  readonly verbiage: readonly VerbiageEntry[];
  readonly neverSend: NeverSendList;
  readonly subject: Subject | null;
}

export async function draft(ctx: AuroraContext, input: DraftInput): Promise<AuroraResult<Draft>> {
  const context = input.context
    .map((record) => {
      const data = scrubRecord(record.table, record.data, input.neverSend);
      return data ? { id: record.id, table: record.table, data } : null;
    })
    .filter((record) => record !== null);

  return runFeature(ctx, "drafting", input.subject, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      GUIDE[input.kind],
      "Use the org's verbiage library: never use a listed term, always its preferred phrasing.",
      "When the draft needs a fact the context does not hold, write [needs: what is missing] in its place and list it in gaps.",
      `Today is ${ctx.today}.`,
    ].join("\n\n");
    const result = await callTool({
      client: ctx.client,
      model,
      maxTokens,
      system,
      content: [
        { type: "text", text: dataBlock("verbiage library", input.verbiage) },
        { type: "text", text: dataBlock("context records", context) },
        { type: "text", text: dataBlock("instructions", input.instructions) },
      ],
      tool: {
        name: "draft",
        description: "Returns the draft title, Markdown body and the gaps it left.",
        inputSchema: z.toJSONSchema(DraftSchema) as Record<string, unknown>,
      },
      schema: DraftSchema,
    });
    const value = result.value;
    const markedGaps = [...value.body.matchAll(/\[needs: ([^\]]+)\]/g)].map((m) => m[1] ?? "");
    const gaps = [...new Set([...value.gaps, ...markedGaps].filter((g) => g.length > 0))];
    return {
      kind: "answer",
      value: {
        kind: input.kind,
        title: value.title,
        body: value.body,
        gaps,
        verbiageMisses: findVerbiageMisses(`${value.title}\n${value.body}`, input.verbiage),
      },
      prompt: result.prompt,
      output: result.output,
      usage: result.usage,
    };
  });
}
