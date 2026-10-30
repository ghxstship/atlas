import { z } from "zod";
import {
  checkRunOfShow,
  durationSeconds,
  durationText,
  LATEST_AFTER_MIDNIGHT,
  MAX_CUES,
  MAX_RISKS,
  nextDay,
  zonedInstant,
  type ListDraftKind,
  type RunOfShowFlag,
} from "../lists.ts";
import type { ModelUsage } from "../model.ts";
import type { NeverSendList } from "../redact.ts";
import { scrubRecord } from "../redact.ts";
import {
  FeatureError,
  runFeature,
  type AuroraContext,
  type AuroraResult,
  type ProposedChange,
  type ProposedField,
  type Subject,
} from "../session.ts";
import { callTool, dataBlock, GUARDRAILS } from "./shared.ts";

/**
 * Drafting (Section 4.7): SOPs, advance packets, emails, day sheets and change order descriptions,
 * in the org's verbiage library. A draft is returned to the editor the person is in; nothing is
 * saved or sent until they do it themselves. Facts the context does not hold (a price, date or
 * quantity) are left as a visible gap marked `[needs: ...]`, never invented, and listed in `gaps`.
 *
 * A run of show and a risk assessment (P6) are drafted with `draftList` instead: structured lines,
 * each stored as a suggestion for an empty running order or risk list, confirmed as a whole.
 */

export const DRAFT_KINDS = [
  "sop",
  "advance_packet",
  "email",
  "day_sheet",
  "change_order_description",
  "run_of_show",
  "risk_assessment",
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
  run_of_show:
    "Draft a run of show: the show day's running order of cues for the event's type and dates, in chronological order.",
  risk_assessment:
    "Draft a risk assessment: the exposures the production faces, each with a category, a likelihood, an impact and a mitigation.",
};

/** Library terms still present in the text, compared case-insensitively on word boundaries. */
export function findVerbiageMisses(text: string, library: readonly VerbiageEntry[]): string[] {
  return library
    .filter((entry) =>
      new RegExp(`\\b${entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
    )
    .map((entry) => entry.term);
}

/** A term of the org's controlled vocabulary (app.verbiage_terms) with how it is cased. */
export interface VocabularyTerm {
  readonly term: string;
  readonly casingRule: string;
  readonly definition: string;
}

export interface DraftInput {
  readonly kind: DraftKind;
  readonly instructions: string;
  readonly context: readonly ContextRecord[];
  readonly verbiage: readonly VerbiageEntry[];
  /** The org's verbiage library terms, written exactly as cased wherever the draft uses them. */
  readonly vocabulary?: readonly VocabularyTerm[];
  readonly neverSend: NeverSendList;
  readonly subject: Subject | null;
}

/** The context records with Restricted columns and excluded tables removed. */
function scrubContext(context: readonly ContextRecord[], neverSend: NeverSendList) {
  return context
    .map((record) => {
      const data = scrubRecord(record.table, record.data, neverSend);
      return data ? { id: record.id, table: record.table, data } : null;
    })
    .filter((record) => record !== null);
}

export async function draft(ctx: AuroraContext, input: DraftInput): Promise<AuroraResult<Draft>> {
  const context = scrubContext(input.context, input.neverSend);

  const vocabulary = input.vocabulary ?? [];
  return runFeature(ctx, "drafting", input.subject, async (model, maxTokens) => {
    const system = [
      GUARDRAILS,
      GUIDE[input.kind],
      "Use the org's verbiage library: never use a listed term, always its preferred phrasing.",
      ...(vocabulary.length > 0
        ? [
            "The org's vocabulary lists its terms with their casing rules: when the draft uses one, write it exactly as the rule says.",
          ]
        : []),
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
        ...(vocabulary.length > 0
          ? [{ type: "text" as const, text: dataBlock("vocabulary", vocabulary) }]
          : []),
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

// Drafted lists (P6) ------------------------------------------------------------------------------

/** One drafted cue, numbered in show order. */
export interface DraftedCue {
  readonly position: number;
  readonly label: string;
  /** ISO 8601 instant, or null when the context gives no time. */
  readonly planned_at: string | null;
  /** The wall-clock time as the model wrote it, HH:MM in the run's zone, or null. */
  readonly local_time: string | null;
  /** 1 for a cue after midnight, on the day after the show. */
  readonly day_offset: 0 | 1;
  /** HH:MM:SS, or null. */
  readonly duration: string | null;
  readonly segment: string | null;
  readonly description: string | null;
}

/** One drafted risk. Its ratings are proposals for a qualified person to review. */
export interface DraftedRisk {
  readonly title: string;
  /** A canon Risk subtype. */
  readonly category: string;
  readonly likelihood: number | null;
  readonly impact: number | null;
  readonly mitigation: string;
}

/** Why a line the model wrote was dropped, never repaired. */
export type DropReason =
  | "label"
  | "title"
  | "segment"
  | "description"
  | "mitigation"
  | "category"
  | "rating"
  | "time"
  | "duration"
  | "too_many";

interface ListDraftBase {
  readonly title: string;
  /** Markdown rendering of the list, so the draft reads like any other in the request log. */
  readonly body: string;
  /** Facts the draft needs that the context did not hold. */
  readonly gaps: readonly string[];
  /** Lines dropped by the line-by-line check, numbered as the model wrote them. */
  readonly dropped: readonly { readonly line: number; readonly reason: DropReason }[];
  readonly verbiageMisses: readonly string[];
}

export type ListDraft =
  | (ListDraftBase & {
      readonly kind: "run_of_show";
      readonly items: readonly DraftedCue[];
      readonly flags: readonly RunOfShowFlag[];
    })
  | (ListDraftBase & {
      readonly kind: "risk_assessment";
      readonly items: readonly DraftedRisk[];
      readonly flags: readonly RunOfShowFlag[];
    });

export interface ListDraftInput {
  readonly kind: ListDraftKind;
  readonly instructions: string;
  /** The list drafted into: the running order (app.run_of_show) or the project (app.projects). */
  readonly target: Subject;
  readonly context: readonly ContextRecord[];
  readonly verbiage: readonly VerbiageEntry[];
  readonly vocabulary?: readonly VocabularyTerm[];
  readonly neverSend: NeverSendList;
  /** For a run of show: the running order, its show day and its zone. */
  readonly runOfShow?: {
    readonly runOfShowId: string;
    readonly showDate: string;
    readonly timeZone: string;
  };
  /** For a risk assessment: the project and the canon Risk subtypes it may use. */
  readonly risks?: { readonly projectId: string; readonly categories: readonly string[] };
}

const confidence = z.number().optional();

const RunOfShowDraftSchema = z.object({
  title: z.string().min(1).max(200),
  lines: z.array(
    z.object({
      label: z.string(),
      local_time: z.string().nullable(),
      day_offset: z.number().default(0),
      duration_minutes: z.number().nullable().default(null),
      segment: z.string().nullable().optional(),
      // Capped for the model so a full running order fits in one answer; the column takes 2,000.
      description: z.string().max(500).nullable().optional(),
      confidence,
    }),
  ),
  gaps: z.array(z.string().max(300)).default([]),
});

const RiskDraftSchema = z.object({
  title: z.string().min(1).max(200),
  lines: z.array(
    z.object({
      title: z.string(),
      category: z.string(),
      likelihood: z.number().nullable(),
      impact: z.number().nullable(),
      mitigation: z.string(),
      confidence,
    }),
  ),
  gaps: z.array(z.string().max(300)).default([]),
});

const NEEDS = /\[needs: ([^\]]+)\]/g;

/** Text trimmed and within its column's length, null when absent, or false when it breaks the rule. */
function columnText(value: string | null | undefined, max: number): string | null | false {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : false;
}

const rating = (value: number | null) =>
  value === null || (Number.isInteger(value) && value >= 1 && value <= 5);

const confidenceOf = (value: number | undefined) =>
  value !== undefined && value >= 0 && value <= 1 ? value : 0.5;

function field(path: string, value: unknown, conf: number, missing: string): ProposedField {
  return value === null
    ? { field_path: path, refusal: "NO_ANSWER", missing }
    : { field_path: path, value, confidence: conf };
}

/**
 * Drafts a run of show or a risk assessment into an empty list (P6). The request is gated, metered
 * and logged like any drafting request, with the list as its subject. The model's lines are checked
 * one by one against the column rules: a line that breaks one is dropped and reported, never
 * repaired. A run of show is put in chronological order (untimed cues after the last timed one),
 * numbered from 1 and checked for gaps and clashes. Each kept line is stored as one suggestion,
 * `cues.create` or `records.create`, for the person to confirm with the list as a whole.
 */
export async function draftList(
  ctx: AuroraContext,
  input: ListDraftInput,
): Promise<AuroraResult<ListDraft>> {
  const context = scrubContext(input.context, input.neverSend);
  const vocabulary = input.vocabulary ?? [];
  const run = input.runOfShow;
  const risks = input.risks;
  if (input.kind === "run_of_show" && !run) throw new Error("A run of show draft needs its run.");
  if (input.kind === "risk_assessment" && !risks)
    throw new Error("A risk assessment draft needs its categories.");

  return runFeature(ctx, "drafting", input.target, async (model, maxTokens) => {
    const kindRules =
      input.kind === "run_of_show"
        ? [
            GUIDE.run_of_show,
            `Each line is one cue: a short label, its local start time as HH:MM on the show day (day_offset 1 for a cue after midnight, no later than ${LATEST_AFTER_MIDNIGHT}), its length in minutes, and optionally a segment and a one-sentence description.`,
            "Never invent a time the context does not support: leave local_time null and write [needs: what is missing] in the line's description.",
            `The show day is ${run?.showDate ?? ""} in the ${run?.timeZone ?? "UTC"} time zone. Propose at most ${MAX_CUES} lines.`,
          ]
        : [
            GUIDE.risk_assessment,
            'Each line is one risk: a title that is a noun phrase naming the exposure (for example "Crowd Surge at the Barricade", never a sentence), one category from the categories given, likelihood and impact from 1 to 5, and the mitigation that reduces it in one or two sentences.',
            "Use only the categories given. Likelihood and impact are proposals for a qualified person to review: leave them null when the context does not support a rating.",
            `Propose at most ${MAX_RISKS} lines.`,
          ];
    const system = [
      GUARDRAILS,
      ...kindRules,
      "Use the org's verbiage library: never use a listed term, always its preferred phrasing.",
      ...(vocabulary.length > 0
        ? [
            "The org's vocabulary lists its terms with their casing rules: when a line uses one, write it exactly as the rule says.",
          ]
        : []),
      "When the list needs a fact the context does not hold, write [needs: what is missing] and list it in gaps.",
      `Today is ${ctx.today}.`,
    ].join("\n\n");
    const content = [
      { type: "text" as const, text: dataBlock("verbiage library", input.verbiage) },
      ...(vocabulary.length > 0
        ? [{ type: "text" as const, text: dataBlock("vocabulary", vocabulary) }]
        : []),
      { type: "text" as const, text: dataBlock("context records", context) },
      ...(risks
        ? [{ type: "text" as const, text: dataBlock("categories", risks.categories) }]
        : []),
      { type: "text" as const, text: dataBlock("instructions", input.instructions) },
    ];
    const call = async <S extends z.ZodType>(name: string, description: string, schema: S) => {
      const result = await callTool({
        client: ctx.client,
        model,
        maxTokens,
        system,
        content,
        tool: {
          name,
          description,
          inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
        },
        schema,
      });
      // A forced tool call cut off at the token limit is an incomplete list: nothing is proposed.
      if (result.stopReason === "max_tokens") {
        throw new FeatureError(
          "model_output_invalid",
          `The model's ${name} answer was cut off at the token limit.`,
        );
      }
      return result;
    };

    const dropped: { line: number; reason: DropReason }[] = [];
    const texts: string[] = [];
    let title: string;
    let modelGaps: readonly string[];
    let done: { prompt: string; output: string; usage: ModelUsage };
    let value: ListDraft;
    let proposals: ProposedChange[];

    if (input.kind === "run_of_show" && run) {
      const result = await call(
        "draft_run_of_show",
        "Returns the running order's cues, in show order, and the gaps it left.",
        RunOfShowDraftSchema,
      );
      done = { prompt: result.prompt, output: result.output, usage: result.usage };
      title = result.value.title;
      modelGaps = result.value.gaps;
      const kept: (Omit<DraftedCue, "position"> & { at: number | null; confidence: number })[] = [];
      result.value.lines.forEach((line, i) => {
        const drop = (reason: DropReason) => dropped.push({ line: i + 1, reason });
        const label = columnText(line.label, 200);
        if (label === null || label === false) return drop("label");
        const segment = columnText(line.segment, 200);
        if (segment === false) return drop("segment");
        const description = columnText(line.description, 2000);
        if (description === false) return drop("description");
        let plannedAt: string | null = null;
        const time = line.local_time === null ? null : line.local_time.trim();
        const offset = line.day_offset;
        if (offset !== 0 && offset !== 1) return drop("time");
        if (time !== null && time !== "") {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return drop("time");
          if (offset === 1 && time > LATEST_AFTER_MIDNIGHT) return drop("time");
          plannedAt = zonedInstant(
            offset === 1 ? nextDay(run.showDate) : run.showDate,
            time,
            run.timeZone,
          );
          if (plannedAt === null) return drop("time");
        }
        const minutes = line.duration_minutes;
        if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)) {
          return drop("duration");
        }
        if (kept.length >= MAX_CUES) return drop("too_many");
        texts.push(label, segment ?? "", description ?? "");
        kept.push({
          label,
          planned_at: plannedAt,
          local_time: plannedAt === null ? null : time,
          day_offset: plannedAt === null ? 0 : offset,
          duration: minutes === null ? null : durationText(minutes),
          segment,
          description,
          at: plannedAt === null ? null : Date.parse(plannedAt),
          confidence: confidenceOf(line.confidence),
        });
      });
      // Timed cues in time order (a stable sort keeps the model's order for equal times), then the
      // untimed ones in the model's order.
      const ordered = [
        ...kept.filter((c) => c.at !== null).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        ...kept.filter((c) => c.at === null),
      ];
      const items: DraftedCue[] = ordered.map((cue, i) => ({
        position: i + 1,
        label: cue.label,
        planned_at: cue.planned_at,
        local_time: cue.local_time,
        day_offset: cue.day_offset,
        duration: cue.duration,
        segment: cue.segment,
        description: cue.description,
      }));
      proposals = ordered.map((cue, i) => ({
        operationId: "cues.create",
        targetId: null,
        summary: `Add cue ${i + 1}: ${cue.label}`,
        fields: [
          field("run_of_show_id", run.runOfShowId, 1, ""),
          field("position", i + 1, 1, ""),
          field("label", cue.label, cue.confidence, ""),
          field(
            "planned_at",
            cue.planned_at,
            cue.confidence,
            [...(cue.description ?? "").matchAll(NEEDS)].map((m) => m[1]).join("; ") ||
              "The context does not give a time for this cue.",
          ),
          field("duration", cue.duration, cue.confidence, "No length was proposed for this cue."),
          field("segment", cue.segment, cue.confidence, "No segment was proposed for this cue."),
          field(
            "description",
            cue.description,
            cue.confidence,
            "No description was proposed for this cue.",
          ),
        ],
      }));
      const body = items
        .map((c) => {
          const when = c.local_time
            ? `${c.local_time}${c.day_offset === 1 ? " (+1 day)" : ""}`
            : "Untimed";
          const length = c.duration ? ` · ${c.duration.slice(0, 5)}` : "";
          const segment = c.segment ? ` · ${c.segment}` : "";
          const description = c.description ? `\n   ${c.description}` : "";
          return `${c.position}. ${when} · ${c.label}${length}${segment}${description}`;
        })
        .join("\n");
      value = {
        kind: "run_of_show",
        title,
        body,
        items,
        flags: checkRunOfShow(
          items.map((c) => ({
            position: c.position,
            plannedAt: c.planned_at,
            durationSeconds: c.duration === null ? null : durationSeconds(c.duration),
          })),
        ),
        gaps: [],
        dropped,
        verbiageMisses: [],
      };
    } else {
      const categories = risks?.categories ?? [];
      const result = await call(
        "draft_risks",
        "Returns the risk assessment's risks and the gaps it left.",
        RiskDraftSchema,
      );
      done = { prompt: result.prompt, output: result.output, usage: result.usage };
      title = result.value.title;
      modelGaps = result.value.gaps;
      const items: (DraftedRisk & { confidence: number })[] = [];
      result.value.lines.forEach((line, i) => {
        const drop = (reason: DropReason) => dropped.push({ line: i + 1, reason });
        const riskTitle = columnText(line.title, 200);
        if (riskTitle === null || riskTitle === false) return drop("title");
        if (!categories.includes(line.category)) return drop("category");
        if (!rating(line.likelihood) || !rating(line.impact)) return drop("rating");
        const mitigation = columnText(line.mitigation, 2000);
        if (mitigation === null || mitigation === false) return drop("mitigation");
        if (items.length >= MAX_RISKS) return drop("too_many");
        texts.push(riskTitle, mitigation);
        items.push({
          title: riskTitle,
          category: line.category,
          likelihood: line.likelihood,
          impact: line.impact,
          mitigation,
          confidence: confidenceOf(line.confidence),
        });
      });
      const unrated = "The context does not support a rating; a qualified person sets it.";
      proposals = items.map((risk) => ({
        operationId: "records.create",
        targetId: null,
        summary: `Add risk: ${risk.title}`,
        fields: [
          field("record_kind", "Risk", 1, ""),
          field("record_subtype", risk.category, risk.confidence, ""),
          field("title", risk.title, risk.confidence, ""),
          field("risk.likelihood", risk.likelihood, risk.confidence, unrated),
          field("risk.impact", risk.impact, risk.confidence, unrated),
          field("risk.mitigation", risk.mitigation, risk.confidence, ""),
        ],
      }));
      const rate = (n: number | null) => (n === null ? "unrated" : String(n));
      value = {
        kind: "risk_assessment",
        title,
        body: items
          .map(
            (r) =>
              `- ${r.title} (${r.category}): likelihood ${rate(r.likelihood)}, impact ${rate(r.impact)}. Mitigation: ${r.mitigation}`,
          )
          .join("\n"),
        items: items.map((r) => ({
          title: r.title,
          category: r.category,
          likelihood: r.likelihood,
          impact: r.impact,
          mitigation: r.mitigation,
        })),
        flags: [],
        gaps: [],
        dropped,
        verbiageMisses: [],
      };
    }

    const marked = texts.flatMap((t) => [...t.matchAll(NEEDS)].map((m) => m[1] ?? ""));
    const gaps = [
      ...new Set([...modelGaps, ...marked].map((g) => g.trim()).filter((g) => g !== "")),
    ];
    if (value.items.length === 0) {
      return {
        kind: "no-answer",
        missing:
          gaps.length > 0
            ? `The context does not hold enough to draft a line: ${gaps.join("; ")}.`
            : dropped.length > 0
              ? "Every line Aurora drafted broke a rule of the list, so none was kept."
              : "The context does not hold enough to draft a line.",
        ...done,
      };
    }
    return {
      kind: "answer",
      value: {
        ...value,
        gaps,
        verbiageMisses: findVerbiageMisses(`${title}\n${texts.join("\n")}`, input.verbiage),
      },
      proposals,
      ...done,
    };
  });
}
