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
import type { DocumentContent, ModelUsage } from "../model.ts";
import type { NeverSendList } from "../redact.ts";
import { scrubRecord, withholdIdentity } from "../redact.ts";
import {
  FeatureError,
  runFeature,
  type AuroraContext,
  type AuroraResult,
  type ProposedChange,
  type ProposedField,
  type Subject,
} from "../session.ts";
import { excerptSupports, localDateTimeSupport } from "./extraction.ts";
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
  "advance_answers",
  "event_plan",
  "event_brief",
  "approval_pack",
  "waste_plan",
] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** Governance drafts (B15, G-240): prose with a fixed outline, saved as a labeled project document. */
export const GOVERNANCE_KINDS = [
  "event_plan",
  "event_brief",
  "approval_pack",
  "waste_plan",
] as const;
export type GovernanceKind = (typeof GOVERNANCE_KINDS)[number];

export function isGovernanceKind(kind: string): kind is GovernanceKind {
  return (GOVERNANCE_KINDS as readonly string[]).includes(kind);
}

/**
 * The outline of each governance kind, as aurora catalog keys under entry.governance.outline. The
 * caller passes the headings in the person's locale; checkOutline compares the body with them.
 */
export const OUTLINES: Readonly<Record<GovernanceKind, readonly string[]>> = {
  event_plan: [
    "overview",
    "schedule",
    "siteAndVenue",
    "staffingAndRoles",
    "safetyAndRisk",
    "medicalAndEmergency",
    "communications",
    "permitsAndApprovals",
  ],
  event_brief: ["purpose", "keyFacts", "scheduleHighlights", "contactsByRole", "whatIsNeeded"],
  approval_pack: [
    "coverLetter",
    "eventSummary",
    "permitsHeldAndPending",
    "insurance",
    "riskSummary",
    "sitePlanAndCapacity",
    "contacts",
  ],
  waste_plan: [
    "wasteStreams",
    "binsAndPlacement",
    "vendorResponsibilities",
    "collectionSchedule",
    "diversionTargets",
    "reporting",
  ],
};

/** Headings of the outline the body does not carry as a Markdown heading, in outline order. */
export function checkOutline(body: string, headings: readonly string[]): string[] {
  const present = new Set(
    [...body.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => (m[1] ?? "").trim().toLowerCase()),
  );
  return headings.filter((h) => !present.has(h.trim().toLowerCase()));
}

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
  /** For a governance kind, the outline headings the body lacks. */
  readonly missingHeadings?: readonly string[];
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
  advance_answers:
    "Draft the party's answers to the advance sections from the message or document they sent.",
  event_plan:
    "Draft an event management plan from the project's own records: how the event runs, who is responsible, and how safety, medical care, communications and permits are handled.",
  event_brief:
    "Draft a one-page event brief for the team: why the event happens, its key facts, schedule highlights, contacts by role and what is still needed.",
  approval_pack:
    "Draft the cover letter and summary of a permit approval pack for the authority having jurisdiction, from the permits, insurance and risks on file.",
  waste_plan:
    "Draft a waste management plan: the waste streams the event produces, bins and their placement, what each vendor is responsible for, the collection schedule, diversion targets and reporting.",
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
  /** For a governance kind, its outline headings in the person's locale, in order. */
  readonly outline?: readonly string[];
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
      ...(input.outline && input.outline.length > 0
        ? [
            `Use exactly these headings, in this order, each as a Markdown ## heading: ${input.outline.join("; ")}.`,
            "Write a number, a date, a capacity or a target only when the context records give it; otherwise write [needs: ...].",
          ]
        : []),
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
        ...(input.outline ? { missingHeadings: checkOutline(value.body, input.outline) } : {}),
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

// Advance answers (B15, G-173) ------------------------------------------------------------------

/** A choice a section offers, as app.draftable_advance_sections returns it. */
export interface AdvanceChoice {
  readonly asset_class_id?: string;
  readonly credential_category_id?: string;
  /** The asset class's catalog code (element_id). */
  readonly code?: string;
  readonly name: string;
  readonly offering?: string | null;
}

/** A section Aurora may draft, as app.draftable_advance_sections returns it (3044). */
export interface DraftableSection {
  readonly id: string;
  readonly title: string;
  readonly prompt: string | null;
  readonly kind: "Text" | "Schedule Window" | "Item Request" | "Credential Request";
  readonly window_kind: string | null;
  readonly max_lines: number | null;
  readonly per_person: boolean;
  readonly choices: readonly AdvanceChoice[];
}

/** What the draft is read from: a project inbox message the person chose, or a document. */
export type AdvanceSource =
  | { readonly kind: "message"; readonly messageId: string; readonly body: string }
  | { readonly kind: "document"; readonly document: DocumentContent; readonly fileName: string };

export interface AdvanceAnswersInput {
  readonly recipientId: string;
  readonly sections: readonly DraftableSection[];
  /** The live roster of the recipient's engagement, ids and names only. */
  readonly roster: readonly { readonly id: string; readonly name: string }[];
  /** The project's IANA zone: windows are read in it. */
  readonly timeZone: string;
  readonly source: AdvanceSource;
  readonly neverSend: NeverSendList;
}

/** One line of R9's p_lines shape (private.record_advance_answer, 2716). */
export interface AdvanceAnswerLine {
  readonly asset_class_id?: string;
  readonly credential_category_id?: string;
  readonly quantity?: number;
  readonly roster_entry_id?: string;
  readonly needed_window_start?: string;
  readonly needed_window_end?: string;
  readonly window_zone?: string;
  readonly note?: string;
}

export type AdvanceDropReason = "choice" | "quantity" | "time" | "person" | "too_many";

export interface DraftedAdvanceAnswer {
  readonly section_id: string;
  readonly kind: DraftableSection["kind"];
  /** A Text answer's body. */
  readonly body: string | null;
  /** A typed answer's lines, with the names they were read as for the panel. */
  readonly lines: readonly (AdvanceAnswerLine & {
    readonly label: string;
    readonly person_name?: string;
    readonly from_local?: string;
    readonly to_local?: string;
  })[];
  readonly source_excerpt: string | null;
  /** Lines the check dropped, numbered as the model wrote them. */
  readonly dropped: readonly {
    readonly line: number;
    readonly reason: AdvanceDropReason;
    readonly choice?: string;
  }[];
}

export interface AdvanceAnswersDraft {
  readonly answers: readonly DraftedAdvanceAnswer[];
  /** Sections the source does not answer, never invented. */
  readonly unanswered: readonly string[];
}

const AdvanceAnswersSchema = z.object({
  answers: z.array(
    z.object({
      section_id: z.string(),
      body: z.string().max(20000).nullable().optional(),
      lines: z
        .array(
          z.object({
            choice: z.string().nullable().optional(),
            quantity: z.number().nullable().optional(),
            person_name: z.string().nullable().optional(),
            from_local: z.string().nullable().optional(),
            to_local: z.string().nullable().optional(),
            note: z.string().max(500).nullable().optional(),
            source_excerpt: z.string().max(2000).nullable().optional(),
          }),
        )
        .default([]),
      source_excerpt: z.string().max(2000).nullable().optional(),
      confidence: z.number().optional(),
    }),
  ),
  unanswered: z.array(z.string()).default([]),
});

const foldName = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The roster entry a printed name names: the same folded name, else exactly one sharing its words. */
export function matchRosterEntry(
  name: string | null | undefined,
  roster: readonly { readonly id: string; readonly name: string }[],
): string | null {
  if (!name) return null;
  const probe = foldName(name);
  if (probe === "") return null;
  const exact = roster.filter((r) => foldName(r.name) === probe);
  if (exact.length === 1) return exact[0]?.id ?? null;
  const words = probe.split(" ");
  const partial = roster.filter((r) => {
    const own = foldName(r.name).split(" ");
    return words.every((w) => own.includes(w));
  });
  return partial.length === 1 ? (partial[0]?.id ?? null) : null;
}

/** The choice a printed item or pass names: an asset class code, or a class or category name. */
export function matchChoice(
  text: string | null | undefined,
  choices: readonly AdvanceChoice[],
): AdvanceChoice | null {
  if (!text) return null;
  const probe = foldName(text);
  return (
    choices.find(
      (c) => c.code !== undefined && c.code.toLowerCase() === text.trim().toLowerCase(),
    ) ??
    choices.find((c) => foldName(c.name) === probe) ??
    null
  );
}

/**
 * Drafts answers to a recipient's open advance sections (B15, G-173) from one source, a project inbox
 * message (sent as a text/plain document, so the request log never holds its body) or a document.
 * At most one answer per section. Text answers are a body; window answers are local times in the
 * project zone, each shown in the source; item and credential answers name a choice of the
 * section and a quantity shown in the source, and a person on the roster for a per-person section
 * (a credential for one person is one). A line that breaks a rule is dropped and reported, never
 * repaired; a section the source does not answer is listed in `unanswered`. Each answer is stored
 * as one aurora.applyAdvanceAnswer suggestion whose target is the section, for
 * app.apply_drafted_advance_answer.
 */
export async function draftAdvanceAnswers(
  ctx: AuroraContext,
  input: AdvanceAnswersInput,
): Promise<AuroraResult<AdvanceAnswersDraft>> {
  const document: DocumentContent =
    input.source.kind === "message"
      ? {
          type: "document",
          mediaType: "text/plain",
          data: String(
            scrubRecord(
              "app.inbound_messages",
              { body_text: input.source.body },
              input.neverSend,
            )?.["body_text"] ?? "",
          ),
        }
      : input.source.document;
  const sections = input.sections.map((s) => ({
    id: s.id,
    title: s.title,
    prompt: s.prompt,
    kind: s.kind,
    window_kind: s.window_kind,
    max_lines: s.max_lines,
    per_person: s.per_person,
    choices: s.choices.map((c) => (c.code ? `${c.code} ${c.name}` : c.name)),
  }));
  return runFeature(
    ctx,
    "drafting",
    { table: "app.advance_recipients", id: input.recipientId },
    async (model, maxTokens) => {
      const system = [
        GUARDRAILS,
        GUIDE.advance_answers,
        "Answer a section only when the attached source answers it, at most one answer per section, with source_excerpt: the exact words it came from. List every section the source does not answer in unanswered.",
        "A Text section's answer is a body. A Schedule Window section's lines are from_local and to_local, YYYY-MM-DDTHH:MM in the project's zone, exactly as the source prints them. An Item Request or Credential Request section's lines name one of the section's choices and a quantity the source states, and, for a per-person section, the person's name from the roster.",
        "Never invent a time, a quantity, an item or a person. Never quote a passport number, a date of birth or a known traveler number.",
        `The project's time zone is ${input.timeZone}. Today is ${ctx.today}.`,
      ].join("\n\n");
      const result = await callTool({
        client: ctx.client,
        model,
        maxTokens,
        system,
        content: [
          document,
          { type: "text", text: dataBlock("sections", sections) },
          {
            type: "text",
            text: dataBlock(
              "roster",
              input.roster.map((r) => r.name),
            ),
          },
          {
            type: "text",
            text: dataBlock(
              "source",
              input.source.kind === "message"
                ? "the project inbox message above"
                : input.source.fileName,
            ),
          },
        ],
        tool: {
          name: "draft_advance_answers",
          description:
            "Returns at most one answer per section and the sections the source does not answer.",
          inputSchema: z.toJSONSchema(AdvanceAnswersSchema) as Record<string, unknown>,
        },
        schema: AdvanceAnswersSchema,
      });
      if (result.stopReason === "max_tokens") {
        throw new FeatureError(
          "model_output_invalid",
          "The model's answers were cut off at the token limit.",
        );
      }

      const answers: DraftedAdvanceAnswer[] = [];
      const proposals: ProposedChange[] = [];
      const answeredIds = new Set<string>();
      for (const raw of result.value.answers) {
        const section = input.sections.find((s) => s.id === raw.section_id);
        if (!section || answeredIds.has(section.id)) continue;
        const excerpt = raw.source_excerpt ? withholdIdentity(raw.source_excerpt) : null;
        const conf = confidenceOf(raw.confidence);
        const dropped: { line: number; reason: AdvanceDropReason; choice?: string }[] = [];
        if (section.kind === "Text") {
          const body = columnText(raw.body ?? null, 20000);
          if (body === null || body === false) continue;
          answeredIds.add(section.id);
          answers.push({
            section_id: section.id,
            kind: section.kind,
            body,
            lines: [],
            source_excerpt: excerpt,
            dropped,
          });
          proposals.push({
            operationId: "aurora.applyAdvanceAnswer",
            targetId: section.id,
            summary: `Answer ${section.title}.`,
            fields: [
              {
                field_path: "body",
                value: body,
                confidence: conf,
                ...(excerpt ? { source_excerpt: excerpt } : {}),
              },
            ],
          });
          continue;
        }
        const kept: DraftedAdvanceAnswer["lines"][number][] = [];
        raw.lines.forEach((line, i) => {
          const drop = (reason: AdvanceDropReason, choice?: string) =>
            dropped.push({ line: i + 1, reason, ...(choice ? { choice } : {}) });
          const shown = `${line.source_excerpt ?? ""}\n${raw.source_excerpt ?? ""}`;
          if ((section.max_lines ?? 0) <= kept.length) return drop("too_many");
          if (section.kind === "Schedule Window") {
            const from = line.from_local ?? null;
            const to = line.to_local ?? null;
            if (
              !from ||
              !to ||
              localDateTimeSupport(from, shown) !== "printed" ||
              localDateTimeSupport(to, shown) !== "printed"
            ) {
              return drop("time");
            }
            const start = zonedInstant(from.slice(0, 10), from.slice(11), input.timeZone);
            const end = zonedInstant(to.slice(0, 10), to.slice(11), input.timeZone);
            if (!start || !end || Date.parse(end) <= Date.parse(start)) return drop("time");
            kept.push({
              label: section.window_kind ?? section.title,
              needed_window_start: start,
              needed_window_end: end,
              window_zone: input.timeZone,
              from_local: from,
              to_local: to,
            });
            return;
          }
          const choice = matchChoice(line.choice, section.choices);
          if (!choice) return drop("choice", line.choice ?? undefined);
          let roster: string | null = null;
          if (section.per_person) {
            roster = matchRosterEntry(line.person_name, input.roster);
            if (!roster) return drop("person");
          }
          const quantity =
            section.kind === "Credential Request" && roster !== null ? 1 : (line.quantity ?? null);
          if (
            quantity === null ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            (!(section.kind === "Credential Request" && roster !== null) &&
              !excerptSupports("quantity", quantity, shown))
          ) {
            return drop("quantity");
          }
          const note = columnText(line.note ?? null, 500);
          kept.push({
            label: choice.name,
            ...(choice.asset_class_id ? { asset_class_id: choice.asset_class_id } : {}),
            ...(choice.credential_category_id
              ? { credential_category_id: choice.credential_category_id }
              : {}),
            quantity,
            ...(roster ? { roster_entry_id: roster, person_name: line.person_name ?? "" } : {}),
            ...(note ? { note } : {}),
          });
        });
        answeredIds.add(section.id);
        answers.push({
          section_id: section.id,
          kind: section.kind,
          body: null,
          lines: kept,
          source_excerpt: excerpt,
          dropped,
        });
        // R9's line shape only: the names the lines were read as stay in the value for the panel.
        const lines: AdvanceAnswerLine[] = kept.map((l) => ({
          ...(l.asset_class_id ? { asset_class_id: l.asset_class_id } : {}),
          ...(l.credential_category_id ? { credential_category_id: l.credential_category_id } : {}),
          ...(l.quantity !== undefined ? { quantity: l.quantity } : {}),
          ...(l.roster_entry_id ? { roster_entry_id: l.roster_entry_id } : {}),
          ...(l.needed_window_start ? { needed_window_start: l.needed_window_start } : {}),
          ...(l.needed_window_end ? { needed_window_end: l.needed_window_end } : {}),
          ...(l.window_zone ? { window_zone: l.window_zone } : {}),
          ...(l.note ? { note: l.note } : {}),
        }));
        proposals.push({
          operationId: "aurora.applyAdvanceAnswer",
          targetId: section.id,
          summary: `Answer ${section.title} with ${kept.length} ${kept.length === 1 ? "line" : "lines"}.`,
          fields: [
            lines.length > 0
              ? {
                  field_path: "lines",
                  value: lines,
                  confidence: conf,
                  ...(excerpt ? { source_excerpt: excerpt } : {}),
                }
              : {
                  field_path: "lines",
                  refusal: "NO_ANSWER",
                  missing:
                    "The source does not show a time, quantity, item or person this section takes.",
                },
          ],
        });
      }
      const unanswered = input.sections.filter((s) => !answeredIds.has(s.id)).map((s) => s.id);
      if (answers.length === 0) {
        return {
          kind: "no-answer",
          missing: "The source does not answer any open section of this advance.",
          prompt: result.prompt,
          output: result.output,
          usage: result.usage,
        };
      }
      return {
        kind: "answer",
        value: { answers, unanswered },
        prompt: result.prompt,
        output: result.output,
        usage: result.usage,
        proposals,
      };
    },
  );
}
