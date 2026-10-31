import type {
  ModelClient,
  ModelContent,
  ModelRequest,
  ModelResponse,
  ToolResultContent,
} from "@xos/ai";
import {
  fixtureBinding,
  fixtureDocument,
  fixtureDraft,
  fixtureFilter,
  fixtureRisks,
  fixtureRunOfShow,
  fixtureSummary,
} from "./fixture-entry";
import { fixtureAdvanceAnswers, fixtureIntake } from "./fixture-intake";

/**
 * Aurora's end-to-end fixture model (finding A24-007). Browser journeys 35 and 36 run Aurora
 * through the real Atlas API, handlers, database and confirmation step, with this client standing
 * in for the model provider so no test ever calls it. It answers from recorded fixtures: the
 * journey questions and the journey certificate. Anything else gets a NO ANSWER, never an invented
 * value.
 *
 * It can never run in production: it is enabled only when NODE_ENV is not "production" AND
 * XOS_AI_FAKE is exactly "1", `createFixtureModel` refuses otherwise, and the API route reaches it
 * only behind a literal `process.env.NODE_ENV` check that production builds compile away.
 */

export function fixtureModelEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env["NODE_ENV"] !== "production" && env["XOS_AI_FAKE"] === "1";
}

export class FixtureModelRefused extends Error {
  override readonly name = "FixtureModelRefused";
}

export function createFixtureModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelClient {
  if (!fixtureModelEnabled(env)) {
    throw new FixtureModelRefused(
      "The Aurora fixture model runs only outside production with XOS_AI_FAKE=1.",
    );
  }
  return new FixtureModelClient();
}

/** The journey 36 certificate: the fixture reads only a document carrying this policy number. */
export const FIXTURE_CERTIFICATE_POLICY = "GL-7731-2027";

const CERTIFICATE_FIELDS: Readonly<
  Record<string, { value: string | number; excerpt: string; confidence: number }>
> = {
  insurer: { value: "Atlantic Mutual", excerpt: "INSURER A: Atlantic Mutual", confidence: 0.97 },
  policy_identifier: {
    value: FIXTURE_CERTIFICATE_POLICY,
    excerpt: `POLICY NUMBER: ${FIXTURE_CERTIFICATE_POLICY}`,
    confidence: 0.95,
  },
  coverage_type: {
    value: "General Liability",
    excerpt: "COMMERCIAL GENERAL LIABILITY",
    confidence: 0.92,
  },
  coverage_limit_minor: {
    value: 200000000,
    excerpt: "EACH OCCURRENCE $ 2,000,000",
    confidence: 0.88,
  },
  currency_code: { value: "USD", excerpt: "All amounts in USD", confidence: 0.81 },
  valid_from: { value: "2026-10-01", excerpt: "POLICY EFFECTIVE 2026-10-01", confidence: 0.9 },
  valid_to: { value: "2027-09-30", excerpt: "POLICY EXPIRATION 2027-09-30", confidence: 0.9 },
};

/** Headers of the import journey's venues sheet that header similarity misses, and the fields they hold. */
export const FIXTURE_COLUMN_MAP: Readonly<Record<string, string>> = {
  Hall: "name",
  "Region Code": "jurisdiction_id",
  "Local Clock": "time_zone",
};

const usage = { inputTokens: 0, outputTokens: 0 };

function toolCall(name: string, input: unknown, id: string): ModelResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage };
}

/** Rows of a tool result's data block, or none when it is an error or not a block. */
function rowsOf(result: ToolResultContent | undefined): Record<string, unknown>[] {
  if (!result || result.isError) return [];
  const start = result.content.indexOf("\n");
  const end = result.content.lastIndexOf("\n</data>");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(result.content.slice(start + 1, end));
    return Array.isArray(parsed)
      ? parsed.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      : [];
  } catch {
    // A block that is not JSON holds no rows the fixture can cite.
    return [];
  }
}

function textOf(content: readonly ModelContent[]): string {
  return content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** A plain-text document's text; the API hands text/plain documents over already decoded. */
function documentText(content: readonly ModelContent[]): string {
  const doc = content.find((c) => c.type === "document");
  if (!doc || doc.type !== "document" || doc.mediaType !== "text/plain") return "";
  return doc.data;
}

type Question = "blocked-permits" | "element-price" | null;

function questionOf(text: string): Question {
  if (/blocked/i.test(text) && /permit/i.test(text)) return "blocked-permits";
  if (/(price|cost)/i.test(text) && /guard booth/i.test(text)) return "element-price";
  return null;
}

export class FixtureModelClient implements ModelClient {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const tools = new Set((request.tools ?? []).map((t) => t.name));
    if (tools.has("record_fields")) {
      return (
        fixtureIntake(request) ??
        fixtureDocument(request, documentText(request.messages[0]?.content ?? [])) ??
        this.extract(request)
      );
    }
    // B15: advance answers drafted from a message or file (fixture-intake.ts).
    if (tools.has("draft_advance_answers")) return fixtureAdvanceAnswers(request);
    if (tools.has("map_columns")) return this.mapColumns(request);
    if (tools.has("answer")) return this.assist(request);
    // The A95 entry points (fixture-entry.ts).
    if (tools.has("build_filter")) return fixtureFilter(request);
    if (tools.has("draft")) return fixtureDraft(request);
    // The drafted lists (P6).
    if (tools.has("draft_run_of_show")) return fixtureRunOfShow(request);
    if (tools.has("draft_risks")) return fixtureRisks(request);
    if (tools.has("summary")) return fixtureSummary(request);
    if (tools.has("bind_code")) return fixtureBinding(request);
    return {
      content: [{ type: "text", text: "This fixture model answers only recorded journeys." }],
      stopReason: "end_turn",
      usage,
    };
  }

  /**
   * The import wizard's journey (A83): the recorded headers of the e2e venues sheet map to their fields; any
   * other header gets null, never a guess.
   */
  private mapColumns(request: ModelRequest): ModelResponse {
    const blocks = (request.messages[0]?.content ?? []).map((c) =>
      c.type === "text" ? c.text : "",
    );
    const columns = blocks
      .filter((b) => b.startsWith('<data source="columns">'))
      .flatMap((b) => rowsOf({ type: "tool_result", toolUseId: "", content: b }));
    const mappings = columns.map((c) => {
      const header = typeof c["header"] === "string" ? c["header"] : "";
      const field = FIXTURE_COLUMN_MAP[header] ?? null;
      return { column: header, field, confidence: field === null ? 0 : 0.82 };
    });
    return toolCall("map_columns", { mappings }, "fixture-map-columns");
  }

  private extract(request: ModelRequest): ModelResponse {
    const text = documentText(request.messages[0]?.content ?? []);
    const known = text.includes(FIXTURE_CERTIFICATE_POLICY);
    const fields = Object.entries(CERTIFICATE_FIELDS).map(([path, f]) =>
      known && text.includes(f.excerpt)
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
            missing: "The fixture model reads only the recorded journey certificate.",
          },
    );
    return toolCall("record_fields", { fields, lines: [] }, "fixture_record_fields");
  }

  private assist(request: ModelRequest): ModelResponse {
    // Earlier turns arrive as history; the question is the last user text, and only the tool
    // results after it belong to this turn.
    const messages = request.messages;
    const asked = messages.findLastIndex((m) => m.role === "user" && textOf(m.content) !== "");
    const question = questionOf(textOf(messages[asked]?.content ?? []));
    const results = messages
      .slice(asked + 1)
      .flatMap((m) => m.content)
      .filter((c): c is ToolResultContent => c.type === "tool_result");
    const step = results.length;

    if (question === "blocked-permits") {
      // Projects in the jurisdiction, then blocked permits, kept when their record key carries one
      // of those projects' keys (records name their project only through the key), then the answer.
      if (step === 0) {
        return toolCall(
          "list_records",
          {
            path: "projects",
            filters: [{ field: "jurisdiction_id", op: "eq", value: "US-FL-MIAMI-DADE" }],
            limit: 25,
          },
          "fixture_projects",
        );
      }
      if (step === 1) {
        return toolCall(
          "list_records",
          {
            path: "records",
            filters: [
              { field: "record_kind", op: "eq", value: "Permit" },
              { field: "record_state", op: "eq", value: "Blocked" },
            ],
            limit: 25,
          },
          "fixture_permits",
        );
      }
      const keys = rowsOf(results[0]).flatMap((r) =>
        typeof r["project_key"] === "string" ? [`${r["project_key"]}-`] : [],
      );
      const permits = rowsOf(results[1]).filter((p) =>
        keys.some((k) => String(p["record_key"] ?? "").startsWith(k)),
      );
      if (permits.length === 0) {
        return toolCall(
          "answer",
          { no_answer: { missing: "No blocked permit is visible in US-FL-MIAMI-DADE." } },
          "fixture_answer",
        );
      }
      const titles = permits.map((p) => String(p["title"] ?? p["id"]));
      return toolCall(
        "answer",
        {
          text: `${permits.length} blocked ${permits.length === 1 ? "permit" : "permits"} in US-FL-MIAMI-DADE: ${titles.join(", ")}.`,
          citations: permits.map((p) => ({
            path: "records",
            id: String(p["id"]),
            label: String(p["title"] ?? p["id"]),
          })),
        },
        "fixture_answer",
      );
    }

    if (question === "element-price") {
      if (step === 0) {
        return toolCall(
          "list_records",
          {
            path: "budget-lines",
            filters: [{ field: "description", op: "contains", value: "guard booth" }],
            limit: 10,
          },
          "fixture_budget_lines",
        );
      }
      const lines = rowsOf(results[0]);
      const priced = lines.filter((l) => typeof l["unit_price_minor"] === "number");
      if (priced.length === 0) {
        // Unpriced is not zero: with no price on record there is nothing to quote (Section 3.7).
        return toolCall(
          "answer",
          {
            no_answer: {
              missing: "The guard booth has no price on record; the budget line is Unpriced.",
            },
          },
          "fixture_answer",
        );
      }
      return toolCall(
        "answer",
        {
          text: `The guard booth is priced at ${String(priced[0]?.["unit_price_minor"])} minor units.`,
          citations: priced.map((l) => ({
            path: "budget-lines",
            id: String(l["id"]),
            label: String(l["description"] ?? l["id"]),
          })),
        },
        "fixture_answer",
      );
    }

    return toolCall(
      "answer",
      { no_answer: { missing: "The fixture model answers only the recorded journey questions." } },
      "fixture_answer",
    );
  }
}
