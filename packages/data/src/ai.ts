import type { Database, Json } from "./database.types.ts";
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Aurora AI repository (Section 4.7, migration 0650). Every call runs with the signed-in person's
 * session, so row level security and the 0650 RPCs decide what they may read, start and confirm.
 * `createAuroraStore` is the persistence the `@xos/ai` request runner takes.
 */

export type AiFeature = Database["app"]["Enums"]["ai_feature"];
export type AiSuggestionState = Database["app"]["Enums"]["ai_suggestion_state"];

/** The features in settings order (Section 4.7 table order). */
export const AI_FEATURE_ORDER: readonly AiFeature[] = [
  "assistant",
  "plain_language",
  "extraction",
  "drafting",
  "summaries",
  "mapping",
];

export type AiSettings = Readonly<Record<AiFeature, boolean>>;

const COLUMN: Readonly<Record<AiFeature, keyof Database["app"]["Tables"]["ai_settings"]["Row"]>> = {
  assistant: "assistant_enabled",
  plain_language: "plain_language_enabled",
  extraction: "extraction_enabled",
  drafting: "drafting_enabled",
  summaries: "summaries_enabled",
  mapping: "mapping_enabled",
};

const ALL_OFF: AiSettings = {
  assistant: false,
  plain_language: false,
  extraction: false,
  drafting: false,
  summaries: false,
  mapping: false,
};

/** The org's switches. An org without a settings row has every feature off. */
export async function getAiSettings(db: XosClient, orgId: string): Promise<Result<AiSettings>> {
  const { data, error } = await db
    .from("ai_settings")
    .select(
      "assistant_enabled, plain_language_enabled, extraction_enabled, drafting_enabled, summaries_enabled, mapping_enabled",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(ALL_OFF);
  const row = data as Record<string, boolean>;
  return ok(
    Object.fromEntries(AI_FEATURE_ORDER.map((f) => [f, row[COLUMN[f]] === true])) as AiSettings,
  );
}

/** Saves the switches (org.ai.write). Turning a feature on without aurora_ai refuses with aurora_not_in_plan. */
export async function saveAiSettings(
  db: XosClient,
  orgId: string,
  settings: AiSettings,
): Promise<Result<null>> {
  const row = { org_id: orgId } as Record<string, unknown>;
  for (const feature of AI_FEATURE_ORDER) row[COLUMN[feature]] = settings[feature];
  const { error } = await db
    .from("ai_settings")
    .upsert(row as Database["app"]["Tables"]["ai_settings"]["Insert"], { onConflict: "org_id" });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface AiAllowance {
  readonly used: number;
  /** Null when the plan sets no monthly limit. */
  readonly allowance: number | null;
  readonly planIncludesAurora: boolean;
}

export async function getAiAllowance(db: XosClient, orgId: string): Promise<Result<AiAllowance>> {
  const { data, error } = await db.rpc("ai_allowance", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "not-found" });
  return ok({
    used: row.used,
    allowance: (row.allowance as number | null) ?? null,
    planIncludesAurora: row.plan_includes_aurora,
  });
}

/** Features the person may use now: turned on and in the plan. */
export async function listEnabledAiFeatures(
  db: XosClient,
  orgId: string,
): Promise<Result<readonly AiFeature[]>> {
  const { data, error } = await db.rpc("ai_enabled_features", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const enabled = new Set(data);
  return ok(AI_FEATURE_ORDER.filter((f) => enabled.has(f)));
}

export interface NeverSendRow {
  readonly table: string;
  readonly column: string | null;
}

/** Everything stripped before a model call: Restricted columns and excluded tables. */
export async function listAiNeverSend(db: XosClient): Promise<Result<readonly NeverSendRow[]>> {
  const { data, error } = await db.from("ai_never_send").select("table_name, column_name");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((r) => ({ table: r.table_name ?? "", column: r.column_name ?? null }))
      .filter((r) => r.table !== ""),
  );
}

// Request runner store -----------------------------------------------------------------------

export interface ProposedFieldInput {
  readonly field_path: string;
  readonly value?: unknown;
  readonly confidence?: number;
  readonly refusal?: "NO_ANSWER";
  readonly missing?: string;
  readonly source_excerpt?: string;
}

export interface ProposedChangeInput {
  readonly operationId: string;
  readonly targetId: string | null;
  readonly summary: string;
  readonly fields: readonly ProposedFieldInput[];
}

/** Implements the `@xos/ai` AuroraStore over the 0650 RPCs. */
export function createAuroraStore(db: XosClient) {
  return {
    async begin(
      orgId: string,
      feature: AiFeature,
      model: string,
      subject: { readonly table: string; readonly id: string } | null,
    ): Promise<Result<string>> {
      const { data, error } = await db.rpc("ai_begin_request", {
        p_org_id: orgId,
        p_feature: feature,
        p_model: model,
        ...(subject ? { p_subject_table: subject.table, p_subject_id: subject.id } : {}),
      });
      return error ? fail(toDataError(error)) : ok(data);
    },
    async complete(input: {
      readonly requestId: string;
      readonly outcome: "Answered" | "No Answer" | "Failed";
      readonly prompt: string;
      readonly output: string | null;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
      readonly failureCode: string | null;
    }): Promise<Result<null>> {
      const { error } = await db.rpc("ai_complete_request", {
        p_request_id: input.requestId,
        p_outcome: input.outcome,
        p_prompt: input.prompt,
        p_output: input.output as string,
        ...(input.usage
          ? { p_input_tokens: input.usage.inputTokens, p_output_tokens: input.usage.outputTokens }
          : {}),
        ...(input.failureCode ? { p_failure_code: input.failureCode } : {}),
      });
      return error ? fail(toDataError(error)) : ok(null);
    },
    async propose(requestId: string, change: ProposedChangeInput): Promise<Result<string>> {
      const { data, error } = await db.rpc("ai_propose_suggestion", {
        p_request_id: requestId,
        p_operation_id: change.operationId,
        p_target_id: change.targetId as string,
        p_summary: change.summary,
        p_fields: change.fields as unknown as Json,
      });
      return error ? fail(toDataError(error)) : ok(data);
    },
  };
}

// Suggestions --------------------------------------------------------------------------------

export interface AiSuggestionField {
  readonly fieldPath: string;
  readonly value: unknown;
  readonly confidence: number | null;
  readonly refusal: "NO_ANSWER" | null;
  readonly missing: string | null;
  readonly sourceExcerpt: string | null;
}

export interface AiSuggestion {
  readonly id: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly targetId: string | null;
  readonly summary: string;
  readonly state: AiSuggestionState;
  readonly expiresAt: string;
  readonly appliedId: string | null;
  readonly fields: readonly AiSuggestionField[];
}

interface SuggestionRow {
  id: string;
  request_id: string;
  operation_id: string;
  target_id: string | null;
  summary: string;
  suggestion_state: AiSuggestionState;
  expires_at: string;
  applied_id: string | null;
  ai_suggestion_fields: {
    field_path: string;
    proposed_value: unknown;
    confidence: number | null;
    refusal: string | null;
    missing: string | null;
    source_excerpt: string | null;
    position: number;
  }[];
}

function toSuggestion(row: SuggestionRow): AiSuggestion {
  return {
    id: row.id,
    requestId: row.request_id,
    operationId: row.operation_id,
    targetId: row.target_id,
    summary: row.summary,
    state: row.suggestion_state,
    expiresAt: row.expires_at,
    appliedId: row.applied_id,
    fields: [...row.ai_suggestion_fields]
      .sort((a, b) => a.position - b.position)
      .map((f) => ({
        fieldPath: f.field_path,
        value: f.proposed_value,
        confidence: f.confidence === null ? null : Number(f.confidence),
        refusal: f.refusal === "NO_ANSWER" ? "NO_ANSWER" : null,
        missing: f.missing,
        sourceExcerpt: f.source_excerpt,
      })),
  };
}

const SUGGESTION_COLUMNS =
  "id, request_id, operation_id, target_id, summary, suggestion_state, expires_at, applied_id, ai_suggestion_fields(field_path, proposed_value, confidence, refusal, missing, source_excerpt, position)";

/** Suggestions the person may read in an org, newest first, optionally in one state. */
export async function listAiSuggestions(
  db: XosClient,
  orgId: string,
  state?: AiSuggestionState,
): Promise<Result<readonly AiSuggestion[]>> {
  let query = db
    .from("ai_suggestions")
    .select(SUGGESTION_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (state) query = query.eq("suggestion_state", state);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as SuggestionRow[]).map(toSuggestion));
}

export async function getAiSuggestion(db: XosClient, id: string): Promise<Result<AiSuggestion>> {
  const { data, error } = await db
    .from("ai_suggestions")
    .select(SUGGESTION_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toSuggestion(data as unknown as SuggestionRow));
}

/** Moves a suggestion with compare-and-set (app.transition_ai_suggestion). */
export async function transitionAiSuggestion(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: AiSuggestionState;
    readonly next: AiSuggestionState;
    readonly reason: string;
    readonly appliedId?: string;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("transition_ai_suggestion", {
    p_suggestion_id: input.id,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason,
    ...(input.appliedId ? { p_applied_id: input.appliedId } : {}),
  });
  return error ? fail(toDataError(error)) : ok(null);
}

// Drafted lists (P6, migration 2830) ---------------------------------------------------------

export type DraftedListKind = "run_of_show" | "risk_assessment";

/**
 * Whether a running order (run_of_show) or a project's risk list (risk_assessment) has no entry yet,
 * counting entries the caller cannot see. A caller who may not write to the list gets not-found.
 */
export async function draftedListIsEmpty(
  db: XosClient,
  kind: DraftedListKind,
  targetId: string,
): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("drafted_list_is_empty", {
    p_kind: kind,
    p_target_id: targetId,
  });
  return error ? fail(toDataError(error)) : ok(data === true);
}

export interface AppliedDraftedList {
  readonly written: readonly { readonly suggestion_id: string; readonly id: string }[];
  readonly rejected: number;
}

/**
 * Writes the kept lines of a drafted list in one transaction (app.apply_drafted_list), only while
 * the list is still empty. A line the database refuses names its line number; a value of the wrong
 * type or format (a malformed time, a missing value) is an invalid value like a broken check.
 */
export async function applyDraftedList(
  db: XosClient,
  input: {
    readonly requestId: string;
    readonly items: readonly {
      readonly suggestion_id: string;
      readonly values?: Readonly<Record<string, unknown>>;
    }[];
  },
): Promise<Result<AppliedDraftedList>> {
  const { data, error } = await db.rpc("apply_drafted_list", {
    p_request_id: input.requestId,
    p_items: input.items.map((i) => ({
      suggestion_id: i.suggestion_id,
      values: i.values ?? {},
    })) as unknown as Json,
  });
  if (error) {
    if (
      error.code === "22007" ||
      error.code === "22008" ||
      error.code === "23502" ||
      error.code === "22003"
    ) {
      return fail({ kind: "invalid", message: error.message });
    }
    return fail(toDataError(error));
  }
  const value = (data ?? {}) as { written?: unknown; rejected?: unknown };
  return ok({
    written: Array.isArray(value.written)
      ? (value.written as { suggestion_id: string; id: string }[])
      : [],
    rejected: typeof value.rejected === "number" ? value.rejected : 0,
  });
}

// Request log --------------------------------------------------------------------------------

export interface AiRequestLogEntry {
  readonly id: string;
  readonly personId: string;
  readonly feature: AiFeature;
  readonly model: string;
  readonly outcome: Database["app"]["Enums"]["ai_request_outcome"];
  readonly createdAt: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

interface UsageCell {
  input_tokens: number | null;
  output_tokens: number | null;
}

/** PostgREST embeds a one-to-one relation as an object and a one-to-many as a list. */
function firstUsage(cell: UsageCell | UsageCell[] | null): UsageCell | null {
  if (Array.isArray(cell)) return cell[0] ?? null;
  return cell;
}

/** The request log an Admin audits (audit.log.read), or the person's own requests. */
export async function listAiRequests(
  db: XosClient,
  orgId: string,
  limit = 50,
): Promise<Result<readonly AiRequestLogEntry[]>> {
  const { data, error } = await db
    .from("ai_requests")
    .select(
      "id, person_id, feature, model, outcome, created_at, ai_usage(input_tokens, output_tokens)",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        person_id: string;
        feature: AiFeature;
        model: string;
        outcome: AiRequestLogEntry["outcome"];
        created_at: string;
        ai_usage: UsageCell | UsageCell[] | null;
      }[]
    ).map((r) => ({
      id: r.id,
      personId: r.person_id,
      feature: r.feature,
      model: r.model,
      outcome: r.outcome,
      createdAt: r.created_at,
      inputTokens: firstUsage(r.ai_usage)?.input_tokens ?? null,
      outputTokens: firstUsage(r.ai_usage)?.output_tokens ?? null,
    })),
  );
}
