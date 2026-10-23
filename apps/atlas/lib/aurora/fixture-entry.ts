import type { ModelContent, ModelRequest, ModelResponse } from "@xos/ai";

/**
 * The fixture model's answers for the A95 entry points (finding A65-020): plain-language filters,
 * drafts, summaries, code bindings and the invoice, receipt and quote documents of the journeys.
 * Like the rest of the fixture model (fixture-model.ts, finding A24-007) it is deterministic,
 * answers from what the request carries, and refuses with NO ANSWER whatever it was not recorded
 * for, so the journeys exercise the real API, handlers, metering and confirmation steps without a
 * model provider. It never runs in production.
 */

const usage = { inputTokens: 0, outputTokens: 0 };

function toolCall(name: string, input: unknown): ModelResponse {
  return {
    content: [{ type: "tool_use", id: `fixture_${name}`, name, input }],
    stopReason: "tool_use",
    usage,
  };
}

/** The JSON inside a `<data source="...">` block of the first message, or null. */
export function dataOf(content: readonly ModelContent[], source: string): unknown {
  const opening = `<data source="${source}">\n`;
  for (const block of content) {
    if (block.type !== "text" || !block.text.startsWith(opening)) continue;
    const body = block.text.slice(opening.length, block.text.lastIndexOf("\n</data>"));
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return null;
}

function first(request: ModelRequest): readonly ModelContent[] {
  return request.messages[0]?.content ?? [];
}

// Plain-language filters ------------------------------------------------------------------------

interface CatalogField {
  readonly name: string;
  readonly type: string;
  readonly values?: readonly string[];
}

/** Recorded sentences: "overdue", "from <Name>" and a state name; anything else is NO ANSWER. */
export function fixtureFilter(request: ModelRequest): ModelResponse {
  const catalog = (dataOf(first(request), "catalog") ?? []) as {
    collection: string;
    fields: CatalogField[];
  }[];
  const sentence = String(dataOf(first(request), "sentence") ?? "");
  const target = catalog[0];
  const field = (name: string) => target?.fields.find((f) => f.name === name);
  const conditions: { field: string; op: string; value: string }[] = [];
  if (/\boverdue\b/i.test(sentence) && field("overdue")) {
    conditions.push({ field: "overdue", op: "eq", value: "true" });
  }
  const party = /\bfrom ([A-Z][A-Za-z0-9&'-]+)/.exec(sentence);
  if (party?.[1] && field("q")) conditions.push({ field: "q", op: "contains", value: party[1] });
  const states = field("state")?.values ?? [];
  const state = states.find((s) => new RegExp(`\\b${s}\\b`, "i").test(sentence));
  if (state) conditions.push({ field: "state", op: "eq", value: state });
  if (!target || conditions.length === 0) {
    return toolCall("build_filter", {
      no_answer: {
        missing:
          "The fixture model filters only by the recorded words: overdue, from a name, or a state.",
      },
    });
  }
  const name = sentence
    .split(/\s+/)
    .slice(0, 6)
    .map((w) => (w ? `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}` : w))
    .join(" ");
  return toolCall("build_filter", {
    collection: target.collection,
    name: name.slice(0, 80),
    conditions,
    sort: [],
  });
}

// Drafts ------------------------------------------------------------------------------------------

/** A draft built from the instructions and the titles of the context records; a price is a gap. */
export function fixtureDraft(request: ModelRequest): ModelResponse {
  const instructions = String(dataOf(first(request), "instructions") ?? "").trim();
  const records = (dataOf(first(request), "context records") ?? []) as {
    data?: Record<string, unknown>;
  }[];
  const named = records
    .map((r) => r.data?.["title"] ?? r.data?.["name"])
    .filter((v): v is string => typeof v === "string");
  const title = (instructions.split(/[.\n]/)[0] ?? "").slice(0, 120) || "Draft";
  const lines = [
    `1. ${instructions || "Describe the work."}`,
    ...named.map((n, i) => `${i + 2}. Confirm the details of ${n}.`),
  ];
  if (/\b(price|cost|fee)\b/i.test(instructions)) lines.push("Cost: [needs: the agreed price]");
  return toolCall("draft", { title, body: lines.join("\n"), gaps: [] });
}

// Summaries ---------------------------------------------------------------------------------------

function describe(data: Record<string, unknown>): string {
  for (const key of ["description", "title", "body", "summary", "to_state", "event_type"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 200);
  }
  return "An entry was recorded";
}

/** One point per item, up to four, each citing the item it came from; gate readiness is counted. */
export function fixtureSummary(request: ModelRequest): ModelResponse {
  const items = (dataOf(first(request), "items") ?? []) as {
    id: string;
    data: Record<string, unknown>;
  }[];
  const readiness = items.find((i) => Array.isArray(i.data["gate_readiness"]));
  if (readiness) {
    const rows = readiness.data["gate_readiness"] as {
      criterion_id?: string;
      blocking?: boolean;
      satisfied?: boolean;
    }[];
    const met = rows.filter((r) => r.satisfied === true).length;
    const blocked = rows.filter((r) => r.blocking === true && r.satisfied !== true);
    return toolCall("summary", {
      headline: `${met} of ${rows.length} criteria have evidence`,
      bullets: [
        {
          text:
            blocked.length === 0
              ? "No blocking criterion lacks evidence."
              : `Blocking without evidence: ${blocked.map((r) => r.criterion_id ?? "").join(", ")}.`,
          citations: [readiness.id],
        },
      ],
    });
  }
  return toolCall("summary", {
    headline: `${items.length} ${items.length === 1 ? "entry" : "entries"} reviewed`,
    bullets: items.slice(0, 4).map((i) => ({ text: `${describe(i.data)}.`, citations: [i.id] })),
  });
}

// Code bindings -----------------------------------------------------------------------------------

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );

/** The candidate sharing the most words with the label; none in common is NO ANSWER. */
export function fixtureBinding(request: ModelRequest): ModelResponse {
  const candidates = (dataOf(first(request), "candidates") ?? []) as {
    elementId: string;
    name: string;
  }[];
  const scanned = (dataOf(first(request), "scanned code") ?? {}) as { description?: string | null };
  const label = words(scanned.description ?? "");
  let best: { elementId: string; score: number } | null = null;
  for (const c of candidates) {
    const score = [...words(c.name)].filter((w) => label.has(w)).length;
    if (score > 0 && (best === null || score > best.score))
      best = { elementId: c.elementId, score };
  }
  if (best === null) {
    return toolCall("bind_code", {
      no_answer: { missing: "The label shares no words with any candidate, so none was chosen." },
    });
  }
  return toolCall("bind_code", {
    element_id: best.elementId,
    confidence: Math.min(0.95, 0.6 + best.score * 0.1),
    reason: "The label names this element.",
  });
}

// Documents ---------------------------------------------------------------------------------------

interface Read {
  readonly value: string | number;
  readonly excerpt: string;
  readonly confidence: number;
}

interface FixtureDocument {
  /** Words the recorded document carries; any other document is not read. */
  readonly marker: string;
  readonly fields: Readonly<Record<string, Read>>;
  readonly lines?: readonly Readonly<Record<string, Read>>[];
}

/** The journeys' invoice, receipt and quote, by document kind. */
export const FIXTURE_DOCUMENTS: Readonly<Record<string, FixtureDocument>> = {
  invoice: {
    marker: "Invoice No. BW-20417",
    fields: {
      invoice_number: { value: "BW-20417", excerpt: "Invoice No. BW-20417", confidence: 0.96 },
      issued_on: { value: "2026-09-02", excerpt: "Invoice date: 2026-09-02", confidence: 0.93 },
      due_on: { value: "2026-10-02", excerpt: "Payment due: 2026-10-02", confidence: 0.91 },
      currency_code: { value: "USD", excerpt: "Total due: USD 18,450.00", confidence: 0.88 },
    },
  },
  receipt: {
    marker: "HARBOR HARDWARE",
    fields: {
      description: { value: "Gaffer tape", excerpt: "Gaffer tape 2in black x6", confidence: 0.84 },
      amount_minor: { value: 8994, excerpt: "TOTAL USD 89.94", confidence: 0.92 },
      currency_code: { value: "USD", excerpt: "TOTAL USD 89.94", confidence: 0.9 },
      incurred_on: { value: "2026-10-03", excerpt: "10/03/2026", confidence: 0.89 },
    },
  },
  quote: {
    marker: "QUOTE Q-5521",
    fields: {
      valid_until: { value: "2026-12-31", excerpt: "Valid until 2026-12-31", confidence: 0.87 },
      currency_code: { value: "USD", excerpt: "All prices USD.", confidence: 0.9 },
    },
    lines: [
      {
        description: {
          value: "LED Wall Panel 500mm",
          excerpt: "LED Wall Panel 500mm",
          confidence: 0.9,
        },
        quantity: { value: 48, excerpt: "Qty 48", confidence: 0.92 },
        unit_price_minor: { value: 12500, excerpt: "$125.00 each", confidence: 0.9 },
        currency_code: { value: "USD", excerpt: "All prices USD.", confidence: 0.85 },
      },
      {
        description: { value: "Video processor", excerpt: "Video processor", confidence: 0.9 },
        quantity: { value: 2, excerpt: "Qty 2", confidence: 0.92 },
        // The recorded quote prints no price for this line: NO ANSWER, never a guess.
        currency_code: { value: "USD", excerpt: "All prices USD.", confidence: 0.85 },
      },
    ],
  },
};

/** The kind a document extraction asks for, from its task sentence. */
export function documentKind(request: ModelRequest): string | null {
  const match = /read the attached ([a-z ]+?) and fill/i.exec(request.system);
  return match?.[1]?.replaceAll(" ", "_") ?? null;
}

/** The fields the task lists, in order: `- path (kind): description`. */
function listedPaths(section: string): string[] {
  return [...section.matchAll(/^- ([a-z_]+) \(/gm)].map((m) => m[1] ?? "");
}

function fieldsFor(
  paths: readonly string[],
  read: Readonly<Record<string, Read>>,
  text: string,
): unknown[] {
  return paths.map((path) => {
    const f = read[path];
    return f && text.includes(f.excerpt)
      ? {
          field_path: path,
          value: f.value,
          confidence: f.confidence,
          source_excerpt: f.excerpt,
          missing: null,
        }
      : {
          field_path: path,
          value: null,
          confidence: null,
          source_excerpt: null,
          missing: "The recorded document does not state this.",
        };
  });
}

/** Reads a recorded invoice, receipt or quote; any other document gets NO ANSWER on every field. */
export function fixtureDocument(request: ModelRequest, text: string): ModelResponse | null {
  const kind = documentKind(request);
  const doc = kind ? FIXTURE_DOCUMENTS[kind] : undefined;
  if (!kind || !(kind in FIXTURE_DOCUMENTS)) return null;
  const [header = "", lineSection = ""] = request.system.split("Each line has these fields:");
  const known = doc !== undefined && text.includes(doc.marker);
  const fields = fieldsFor(listedPaths(header), known ? doc.fields : {}, text);
  const lines = known
    ? (doc.lines ?? []).map((line) => ({ fields: fieldsFor(listedPaths(lineSection), line, text) }))
    : [];
  return toolCall("record_fields", { fields, lines });
}
