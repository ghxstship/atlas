import assistantSet from "./datasets/assistant.json" with { type: "json" };
import draftingSet from "./datasets/drafting.json" with { type: "json" };
import extractionSet from "./datasets/extraction.json" with { type: "json" };
import mappingSet from "./datasets/mapping.json" with { type: "json" };
import plainLanguageSet from "./datasets/plain_language.json" with { type: "json" };
import summariesSet from "./datasets/summaries.json" with { type: "json" };
import { loadModelConfig, type ModelConfig } from "../src/config.ts";
import { askAssistant, type PublicApi } from "../src/features/assistant.ts";
import { draft, type DraftKind } from "../src/features/drafting.ts";
import { extractDocument, type DocumentKind } from "../src/features/extraction.ts";
import { buildFilter, type FilterCollection } from "../src/features/filters.ts";
import { suggestCatalogBinding, suggestColumnMappings } from "../src/features/mapping.ts";
import { summarize, type SummaryKind } from "../src/features/summaries.ts";
import type { AiFeature, ModelClient } from "../src/model.ts";
import { NeverSendList } from "../src/redact.ts";
import type { AuroraContext, AuroraResult, AuroraStore, ProposedChange } from "../src/session.ts";

/**
 * The Aurora evaluation suite (Section 4.7, Section 18 gate 21): a fixed test set per feature in
 * `datasets/`, each case scored pass or fail, accuracy compared with `thresholds.json`. Runs
 * against any `ModelClient`; `run.ts` wires the Anthropic client when the key is configured.
 */

export interface CaseResult {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface FeatureReport {
  readonly feature: AiFeature;
  readonly model: string;
  readonly accuracy: number;
  readonly cases: readonly CaseResult[];
}

/** Records proposals in memory; evals never touch a database. */
function evalStore(): { store: AuroraStore; proposals: ProposedChange[] } {
  const proposals: ProposedChange[] = [];
  let n = 0;
  return {
    proposals,
    store: {
      begin: async () => ({ ok: true, data: `eval-${(n += 1)}` }),
      complete: async () => ({ ok: true, data: null }),
      propose: async (_id, change) => {
        proposals.push(change);
        return { ok: true, data: `eval-suggestion-${proposals.length}` };
      },
    },
  };
}

/** Restricted columns and excluded tables of the eval fixtures, as app.ai_never_send lists them. */
export const EVAL_NEVER_SEND = new NeverSendList([
  { table: "app.medical_encounters", column: null },
  { table: "app.engagements", column: "agreed_rate_minor" },
]);

function ctxFor(
  client: ModelClient,
  config: ModelConfig,
  today: string,
  store: AuroraStore,
): AuroraContext {
  return { orgId: "eval-org", client, store, config, today };
}

function describeFailure<T>(result: AuroraResult<T>): string {
  if (result.kind === "failed") return `failed: ${result.code} ${result.message}`;
  if (result.kind === "refused") return `refused: ${result.rule}`;
  if (result.kind === "no-answer") return `no answer: ${result.missing}`;
  return "answered";
}

const lower = (s: string) => s.toLowerCase();

function textChecks(
  output: string,
  mustContain: readonly string[],
  mustNotContain: readonly string[],
): string | null {
  const missing = mustContain.find((s) => !lower(output).includes(lower(s)));
  if (missing) return `missing "${missing}"`;
  const forbidden = mustNotContain.find((s) => lower(output).includes(lower(s)));
  if (forbidden) return `contains "${forbidden}"`;
  return null;
}

function sameValue(
  expected: unknown,
  field: { value?: unknown; refusal?: string } | undefined,
): boolean {
  if (!field) return false;
  if (expected === "NO_ANSWER") return field.refusal === "NO_ANSWER";
  if (field.refusal !== undefined) return false;
  if (typeof expected === "string" && typeof field.value === "string") {
    return lower(field.value).includes(lower(expected));
  }
  return field.value === expected;
}

async function extractionCases(client: ModelClient, config: ModelConfig): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of extractionSet.cases) {
    const { store, proposals } = evalStore();
    const result = await extractDocument(ctxFor(client, config, "2026-10-14", store), {
      kind: c.kind as DocumentKind,
      document: { type: "document", mediaType: "text/plain", data: c.document },
      fileName: `${c.id}.txt`,
      subject: null,
    });
    const header = proposals[0]?.fields ?? [];
    const wrong = Object.entries(c.expected).find(
      ([path, value]) =>
        !sameValue(
          value,
          header.find((f) => f.field_path === path),
        ),
    );
    let detail = wrong ? `${wrong[0]} expected ${JSON.stringify(wrong[1])}` : "";
    const expectedLines =
      "expectedLines" in c ? (c.expectedLines as Record<string, unknown>[]) : [];
    if (!detail && expectedLines.length > 0) {
      const lines = proposals.slice(1);
      if (lines.length !== expectedLines.length)
        detail = `expected ${expectedLines.length} lines, got ${lines.length}`;
      expectedLines.forEach((line, i) => {
        const bad = Object.entries(line).find(
          ([path, value]) =>
            !sameValue(
              value,
              lines[i]?.fields.find((f) => f.field_path === path),
            ),
        );
        if (!detail && bad) detail = `line ${i + 1} ${bad[0]} expected ${JSON.stringify(bad[1])}`;
      });
    }
    if (result.kind !== "answer" && !detail) detail = describeFailure(result);
    out.push({ id: c.id, pass: detail === "", detail: detail || "ok" });
  }
  return out;
}

async function plainLanguageCases(client: ModelClient, config: ModelConfig): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of plainLanguageSet.cases) {
    const { store } = evalStore();
    const result = await buildFilter(ctxFor(client, config, plainLanguageSet.today, store), {
      sentence: c.sentence,
      catalog: plainLanguageSet.catalog as FilterCollection[],
      timeZone: plainLanguageSet.timeZone,
    });
    if ("refuse" in c && c.refuse) {
      out.push({ id: c.id, pass: result.kind === "no-answer", detail: describeFailure(result) });
      continue;
    }
    if (result.kind !== "answer") {
      out.push({ id: c.id, pass: false, detail: describeFailure(result) });
      continue;
    }
    const got = new Set(result.value.conditions.map((x) => `${x.field}|${x.op}|${x.value}`));
    const want = new Set(("conditions" in c ? c.conditions : []).map((x) => x.join("|")));
    const pass =
      result.value.collection === ("collection" in c ? c.collection : "") &&
      got.size === want.size &&
      [...want].every((w) => got.has(w));
    out.push({ id: c.id, pass, detail: pass ? "ok" : `got ${result.value.query}` });
  }
  return out;
}

async function summariesCases(client: ModelClient, config: ModelConfig): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of summariesSet.cases) {
    const { store } = evalStore();
    const result = await summarize(ctxFor(client, config, "2026-10-14", store), {
      kind: c.kind as SummaryKind,
      subject: { table: "app.projects", id: "eval-project" },
      items: c.items,
      neverSend: EVAL_NEVER_SEND,
    });
    if ("noAnswer" in c && c.noAnswer) {
      out.push({ id: c.id, pass: result.kind === "no-answer", detail: describeFailure(result) });
      continue;
    }
    if (result.kind !== "answer") {
      out.push({ id: c.id, pass: false, detail: describeFailure(result) });
      continue;
    }
    const cited = new Set(result.value.bullets.flatMap((b) => b.citations));
    const uncited = ("mustCite" in c ? c.mustCite : []).find((id) => !cited.has(id));
    const textual = [result.value.headline, ...result.value.bullets.map((b) => b.text)].join("\n");
    const problem = uncited
      ? `did not cite ${uncited}`
      : textChecks(textual, [], "mustNotContain" in c ? c.mustNotContain : []);
    out.push({ id: c.id, pass: problem === null, detail: problem ?? "ok" });
  }
  return out;
}

const MONEY = /(\$|USD)\s?\d/;

async function draftingCases(client: ModelClient, config: ModelConfig): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of draftingSet.cases) {
    const { store } = evalStore();
    const result = await draft(ctxFor(client, config, "2026-10-14", store), {
      kind: c.kind as DraftKind,
      instructions: c.instructions,
      context: c.context,
      verbiage: c.verbiage,
      neverSend: EVAL_NEVER_SEND,
      subject: null,
    });
    if (result.kind !== "answer") {
      out.push({ id: c.id, pass: false, detail: describeFailure(result) });
      continue;
    }
    const body = `${result.value.title}\n${result.value.body}`;
    let problem = textChecks(body, c.mustContain, c.mustNotContain);
    if (!problem && !c.allowMoney && MONEY.test(body))
      problem = "states a price the context does not give";
    out.push({ id: c.id, pass: problem === null, detail: problem ?? "ok" });
  }
  return out;
}

async function mappingCases(client: ModelClient, config: ModelConfig): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of mappingSet.columnCases) {
    const { store } = evalStore();
    const result = await suggestColumnMappings(ctxFor(client, config, "2026-10-14", store), {
      collection: c.collection,
      columns: c.columns,
      fields: c.fields,
    });
    if (result.kind !== "answer") {
      out.push({ id: c.id, pass: false, detail: describeFailure(result) });
      continue;
    }
    const expected = c.expected as Record<string, string | null>;
    const wrong = result.value.find((m) => (expected[m.column] ?? null) !== m.field);
    out.push({
      id: c.id,
      pass: !wrong,
      detail: wrong ? `${wrong.column} mapped to ${String(wrong.field)}` : "ok",
    });
  }
  for (const c of mappingSet.bindingCases) {
    const { store } = evalStore();
    const result = await suggestCatalogBinding(ctxFor(client, config, "2026-10-14", store), {
      code: c.code,
      description: c.description,
      candidates: c.candidates,
    });
    const pass =
      c.expected === null
        ? result.kind === "no-answer"
        : result.kind === "answer" && result.value.elementId === c.expected;
    out.push({ id: c.id, pass, detail: describeFailure(result) });
  }
  return out;
}

/** Serves the dataset's records the way the public API does, with Restricted columns masked. */
export function fixtureApi(
  records: Readonly<Record<string, readonly Record<string, unknown>[]>>,
): PublicApi {
  const mask = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        k === "agreed_rate_minor" ? { masked: true, reason: "Restricted" } : v,
      ]),
    );
  return {
    async get(path, query) {
      const [, collection, id] = path.split("/");
      const rows = (records[collection ?? ""] ?? []).map(mask);
      if (id) {
        const row = rows.find((r) => r["id"] === id);
        return row ? { status: 200, body: row } : { status: 404, body: {} };
      }
      const filtered = rows.filter((row) =>
        Object.entries(query).every(([key, value]) => {
          const match = /^filter\[(.+)\]\[(eq|contains)\]$/.exec(key);
          if (!match) return true;
          const actual = String(row[match[1] ?? ""] ?? "");
          return match[2] === "eq" ? actual === value : lower(actual).includes(lower(value));
        }),
      );
      return { status: 200, body: { data: filtered, next_cursor: null } };
    },
  };
}

async function assistantCases(client: ModelClient, config: ModelConfig): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  const api = fixtureApi(assistantSet.records);
  for (const c of assistantSet.cases) {
    const { store } = evalStore();
    const result = await askAssistant(ctxFor(client, config, "2026-10-14", store), {
      question: c.question,
      history: [],
      collections: assistantSet.collections,
      writableOperations: [],
      api,
      neverSend: EVAL_NEVER_SEND,
    });
    const shown =
      result.kind === "answer"
        ? result.value.text
        : result.kind === "no-answer"
          ? result.missing
          : "";
    const forbidden = "mustNotContain" in c ? c.mustNotContain : [];
    if ("noAnswer" in c && c.noAnswer) {
      const problem =
        result.kind === "no-answer"
          ? textChecks(shown, [], forbidden)
          : `expected NO ANSWER, ${describeFailure(result)}`;
      out.push({ id: c.id, pass: problem === null, detail: problem ?? "ok" });
      continue;
    }
    if (result.kind === "failed" || result.kind === "refused") {
      out.push({ id: c.id, pass: false, detail: describeFailure(result) });
      continue;
    }
    const cited = new Set(result.kind === "answer" ? result.value.citations.map((x) => x.id) : []);
    const mustCite = "mustCite" in c ? c.mustCite : [];
    const uncited = mustCite.find((id) => !cited.has(id));
    const problem = uncited
      ? `did not cite ${uncited}`
      : textChecks(shown, "mustContain" in c ? c.mustContain : [], forbidden);
    out.push({ id: c.id, pass: problem === null, detail: problem ?? "ok" });
  }
  return out;
}

const RUNNERS: Readonly<
  Record<AiFeature, (client: ModelClient, config: ModelConfig) => Promise<CaseResult[]>>
> = {
  assistant: assistantCases,
  plain_language: plainLanguageCases,
  extraction: extractionCases,
  drafting: draftingCases,
  summaries: summariesCases,
  mapping: mappingCases,
};

export async function runSuite(
  client: ModelClient,
  features: readonly AiFeature[],
  config: ModelConfig = loadModelConfig(),
): Promise<FeatureReport[]> {
  const reports: FeatureReport[] = [];
  for (const feature of features) {
    const cases = await RUNNERS[feature](client, config);
    const passed = cases.filter((c) => c.pass).length;
    reports.push({
      feature,
      model: config.modelFor(feature),
      accuracy: cases.length === 0 ? 0 : passed / cases.length,
      cases,
    });
  }
  return reports;
}

export interface Thresholds {
  readonly features: Readonly<
    Record<
      string,
      {
        readonly threshold: number;
        readonly baseline: number | null;
        readonly baselineAt: string | null;
      }
    >
  >;
}

/** Features whose accuracy fell below their threshold. */
export function belowThreshold(
  reports: readonly FeatureReport[],
  thresholds: Thresholds,
): FeatureReport[] {
  return reports.filter((r) => r.accuracy < (thresholds.features[r.feature]?.threshold ?? 1));
}

/** Sets each threshold from a passing baseline, rounded down to the nearest 0.05 so one flaky case does not fail CI. */
export function baselineThresholds(
  reports: readonly FeatureReport[],
  thresholds: Thresholds,
  at: string,
): Thresholds {
  const features = { ...thresholds.features };
  for (const r of reports) {
    features[r.feature] = {
      threshold: Math.floor(r.accuracy * 20) / 20,
      baseline: r.accuracy,
      baselineAt: at,
    };
  }
  return { features };
}
