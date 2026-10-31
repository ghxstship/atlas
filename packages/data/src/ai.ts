import type { Database, Json } from "./database.types.ts";
import { uploadAttachment } from "./attachments.ts";
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

// Intake batches and drafted answers (B15, migrations 3040 to 3044) ---------------------------

export type AiIntakeKind = Database["app"]["Enums"]["ai_intake_kind"];

/** A refusal for a value of the wrong type or format, named by its item, is an invalid value. */
function intakeError(error: { code?: string; message: string; hint?: string | null }) {
  if (["22007", "22008", "23502", "22003", "22P02"].includes(error.code ?? "")) {
    return fail({ kind: "invalid", message: error.message });
  }
  return fail(toDataError(error));
}

/** Opens an intake batch (app.start_ai_intake): the capabilities, plan, switch and allowance are checked there. */
export async function startIntake(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly kind: AiIntakeKind;
    readonly fileCount: number;
    readonly fulfillmentId?: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("start_ai_intake", {
    p_project_id: input.projectId,
    p_kind: input.kind,
    p_file_count: input.fileCount,
    ...(input.fulfillmentId ? { p_fulfillment_id: input.fulfillmentId } : {}),
  });
  if (error) return intakeError(error);
  return ok(String(data));
}

export interface AiIntakeSuggestion {
  readonly id: string;
  readonly request_id: string;
  readonly operation_id: string;
  readonly target_id: string | null;
  readonly summary: string;
  readonly suggestion_state: AiSuggestionState;
  readonly expires_at: string;
  readonly applied_id: string | null;
  readonly proposed_fields: readonly {
    readonly field_path: string;
    readonly proposed_value: unknown;
    readonly confidence: number | null;
    readonly refusal: "NO_ANSWER" | null;
    readonly missing: string | null;
    readonly source_excerpt: string | null;
    readonly provenance: "agent";
  }[];
}

export interface AiIntake {
  readonly id: string;
  readonly org_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly updated_by: string | null;
  readonly project_id: string;
  readonly intake_kind: AiIntakeKind;
  readonly fulfillment_id: string | null;
  readonly file_count: number;
  readonly closed_at: string | null;
  /** Who opened the batch; only they read files into it and apply it. */
  readonly created_by: string | null;
  readonly requests: readonly {
    readonly id: string;
    readonly outcome: Database["app"]["Enums"]["ai_request_outcome"];
    readonly failure_code: string | null;
    readonly created_at: string;
  }[];
  readonly suggestions: readonly AiIntakeSuggestion[];
}

/**
 * A batch with its requests and Proposed suggestions, read in the caller's session, so a batch of
 * someone else is not found and a Restricted field stays hidden from anyone who may not read it.
 */
export async function getIntake(db: XosClient, id: string): Promise<Result<AiIntake>> {
  const batch = await db
    .from("ai_intake_batches")
    .select(
      "id, org_id, project_id, intake_kind, fulfillment_id, file_count, closed_at, created_at, created_by, updated_at, updated_by",
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (batch.error) return fail(toDataError(batch.error));
  if (!batch.data) return fail({ kind: "not-found" });
  const requests = await db
    .from("ai_requests")
    .select("id, outcome, failure_code, created_at")
    .eq("subject_table", "app.ai_intake_batches")
    .eq("subject_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (requests.error) return fail(toDataError(requests.error));
  const requestIds = (requests.data ?? []).map((r) => r.id);
  let suggestions: AiIntakeSuggestion[] = [];
  if (requestIds.length > 0) {
    const rows = await db
      .from("ai_suggestions")
      .select(
        "id, request_id, operation_id, target_id, summary, suggestion_state, expires_at, applied_id",
      )
      .in("request_id", requestIds)
      .eq("suggestion_state", "Proposed")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (rows.error) return fail(toDataError(rows.error));
    const ids = (rows.data ?? []).map((r) => r.id);
    const fields =
      ids.length === 0
        ? { data: [], error: null }
        : await db
            .from("ai_suggestion_fields")
            .select(
              "suggestion_id, field_path, proposed_value, confidence, refusal, missing, source_excerpt, position",
            )
            .in("suggestion_id", ids)
            .is("deleted_at", null)
            .order("position", { ascending: true });
    if (fields.error) return fail(toDataError(fields.error));
    suggestions = (rows.data ?? []).map((r) => ({
      ...r,
      proposed_fields: (fields.data ?? [])
        .filter((f) => f.suggestion_id === r.id)
        .map((f) => ({
          field_path: f.field_path,
          proposed_value: f.proposed_value ?? null,
          confidence: f.confidence === null ? null : Number(f.confidence),
          refusal: (f.refusal as "NO_ANSWER" | null) ?? null,
          missing: f.missing ?? null,
          source_excerpt: f.source_excerpt ?? null,
          provenance: "agent" as const,
        })),
    }));
  }
  const b = batch.data;
  return ok({
    id: b.id,
    org_id: b.org_id,
    created_at: b.created_at,
    updated_at: b.updated_at,
    updated_by: b.updated_by ?? null,
    project_id: b.project_id,
    intake_kind: b.intake_kind,
    fulfillment_id: b.fulfillment_id ?? null,
    file_count: b.file_count,
    closed_at: b.closed_at ?? null,
    created_by: b.created_by ?? null,
    requests: (requests.data ?? []).map((r) => ({
      id: r.id,
      outcome: r.outcome,
      failure_code: r.failure_code ?? null,
      created_at: r.created_at,
    })),
    suggestions,
  });
}

/** Closes the caller's batch (app.close_ai_intake) and returns how many suggestions it rejected. */
export async function closeIntake(db: XosClient, id: string): Promise<Result<number>> {
  const { data, error } = await db.rpc("close_ai_intake", { p_batch_id: id });
  if (error) return fail(toDataError(error));
  return ok(Number(data ?? 0));
}

export interface AppliedIntake {
  readonly written: readonly { readonly suggestion_id: string; readonly id: string }[];
  readonly rejected: number;
}

/** Files the kept segments of an itinerary batch in one transaction (app.apply_itinerary_intake). */
export async function applyItineraryIntake(
  db: XosClient,
  batchId: string,
  items: readonly {
    readonly suggestion_id: string;
    readonly values: Readonly<Record<string, unknown>>;
  }[],
): Promise<Result<AppliedIntake>> {
  const { data, error } = await db.rpc("apply_itinerary_intake", {
    p_batch_id: batchId,
    p_items: items as unknown as Json,
  });
  if (error) return intakeError(error);
  const value = (data ?? {}) as { written?: unknown; rejected?: unknown };
  return ok({
    written: Array.isArray(value.written) ? (value.written as AppliedIntake["written"]) : [],
    rejected: typeof value.rejected === "number" ? value.rejected : 0,
  });
}

/** A preview row of an itinerary intake, as the already-booked check reads it. */
export interface ItineraryCheckRow {
  readonly person_id: string;
  readonly service_identifier: string | null;
  readonly departs_at: string | null;
}

const serviceKey = (service: string) => service.trim().toUpperCase();

/** Preview rows per travel_segments lookup in bookedItinerarySegments. */
const CHECK_CHUNK = 100;

/**
 * Which preview rows of an itinerary intake the traveler already has as a live segment of the org with the same
 * service identifier and departure, the rule app.apply_itinerary_intake refuses as itinerary_duplicate. It reads
 * app.travel_segments in the caller's session, so row level security decides what it sees: the answer is a hint
 * for the preview, and the apply still decides. Rows without a traveler, service or departure are never booked.
 * Positions from 1.
 */
export async function bookedItinerarySegments(
  db: XosClient,
  orgId: string,
  rows: readonly ItineraryCheckRow[],
): Promise<Result<readonly number[]>> {
  const checked = rows.flatMap((row, i) => {
    const at = row.departs_at ? Date.parse(row.departs_at) : Number.NaN;
    const service = row.service_identifier?.trim() ?? "";
    return row.person_id && service && Number.isFinite(at)
      ? [{ position: i + 1, person: row.person_id, service: serviceKey(service), at }]
      : [];
  });
  const live = new Set<string>();
  // A full batch has up to 1,500 rows; each lookup carries at most CHECK_CHUNK rows' travelers and
  // departures, so its query string stays well inside gateway URL limits.
  for (let start = 0; start < checked.length; start += CHECK_CHUNK) {
    const chunk = checked.slice(start, start + CHECK_CHUNK);
    const { data, error } = await db
      .from("travel_segments")
      .select("person_id, service_identifier, departs_at")
      .eq("org_id", orgId)
      .in("person_id", [...new Set(chunk.map((c) => c.person))])
      .in("departs_at", [...new Set(chunk.map((c) => new Date(c.at).toISOString()))])
      .not("service_identifier", "is", null)
      .is("deleted_at", null);
    if (error) return fail(toDataError(error));
    for (const s of data ?? []) {
      live.add(
        `${s.person_id}|${serviceKey(s.service_identifier ?? "")}|${Date.parse(s.departs_at)}`,
      );
    }
  }
  return ok(
    checked.filter((c) => live.has(`${c.person}|${c.service}|${c.at}`)).map((c) => c.position),
  );
}

export interface AppliedContractIntake {
  readonly applied: readonly { readonly suggestion_id: string; readonly id: string }[];
  readonly engagements: number;
  readonly riders: number;
  readonly rider_lines: number;
  readonly rejected: number;
}

/** Books the kept acts of a contract batch with their riders in one transaction (app.apply_contract_intake). */
export async function applyContractIntake(
  db: XosClient,
  batchId: string,
  groups: readonly unknown[],
): Promise<Result<AppliedContractIntake>> {
  const { data, error } = await db.rpc("apply_contract_intake", {
    p_batch_id: batchId,
    p_groups: groups as unknown as Json,
  });
  if (error) return intakeError(error);
  const v = (data ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof v[key] === "number" ? (v[key] as number) : 0);
  return ok({
    applied: Array.isArray(v["applied"]) ? (v["applied"] as AppliedContractIntake["applied"]) : [],
    engagements: n("engagements"),
    riders: n("riders"),
    rider_lines: n("rider_lines"),
    rejected: n("rejected"),
  });
}

export interface TravelerCandidate {
  readonly name_index: number;
  readonly person_id: string;
  readonly full_name: string;
  readonly roster_entry_id: string | null;
  readonly engagement_id: string | null;
  readonly similarity: number;
}

/** The project's people a printed passenger name may be (app.itinerary_traveler_candidates); names and ids only. */
export async function itineraryTravelerCandidates(
  db: XosClient,
  batchId: string,
  names: readonly string[],
): Promise<Result<readonly TravelerCandidate[]>> {
  if (names.length === 0) return ok([]);
  const { data, error } = await db.rpc("itinerary_traveler_candidates", {
    p_batch_id: batchId,
    p_names: [...names],
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({ ...r, similarity: Number(r.similarity) })) as TravelerCandidate[],
  );
}

export interface PartyCandidate {
  readonly name_index: number;
  readonly candidate_kind: "counterparty" | "person" | "engagement";
  readonly candidate_id: string;
  readonly name: string;
  readonly similarity: number;
  readonly engagement_id: string | null;
  readonly already_booked: boolean;
}

/** The org's counterparties, held people and booked Artist engagements a name may be (app.intake_party_candidates). */
export async function intakePartyCandidates(
  db: XosClient,
  batchId: string,
  names: readonly string[],
): Promise<Result<readonly PartyCandidate[]>> {
  if (names.length === 0) return ok([]);
  const { data, error } = await db.rpc("intake_party_candidates", {
    p_batch_id: batchId,
    p_names: [...names],
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({ ...r, similarity: Number(r.similarity) })) as PartyCandidate[],
  );
}

export interface VendorLineHistoryEntry {
  readonly description_index: number;
  readonly source: "invoice" | "purchase_order";
  readonly reference: string | null;
  readonly line_number: number;
  readonly issued_on: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unit_price_minor: number | null;
  readonly currency_code: string;
  readonly similarity: number;
}

/** Earlier lines of the invoice's vendor, as hints (app.vendor_line_history); never a budget line. */
export async function vendorLineHistory(
  db: XosClient,
  invoiceId: string,
  descriptions: readonly string[],
): Promise<Result<readonly VendorLineHistoryEntry[]>> {
  if (descriptions.length === 0) return ok([]);
  const { data, error } = await db.rpc("vendor_line_history", {
    p_invoice_id: invoiceId,
    p_descriptions: [...descriptions],
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      ...r,
      quantity: Number(r.quantity),
      unit_price_minor: r.unit_price_minor === null ? null : Number(r.unit_price_minor),
      similarity: Number(r.similarity),
    })) as VendorLineHistoryEntry[],
  );
}

export interface DraftableAdvanceSections {
  readonly recipient_id: string;
  readonly packet_id: string;
  readonly project_id: string;
  readonly time_zone: string;
  readonly engagement_id: string | null;
  readonly sections: readonly {
    readonly id: string;
    readonly title: string;
    readonly prompt: string | null;
    readonly kind: "Text" | "Schedule Window" | "Item Request" | "Credential Request";
    readonly window_kind: string | null;
    readonly max_lines: number | null;
    readonly per_person: boolean;
    readonly choices: readonly {
      readonly asset_class_id?: string;
      readonly credential_category_id?: string;
      readonly code?: string;
      readonly name: string;
      readonly offering?: string | null;
    }[];
  }[];
  readonly roster: readonly { readonly id: string; readonly name: string }[];
}

/** What Aurora may draft for a recipient of a sent packet (app.draftable_advance_sections). */
export async function draftableAdvanceSections(
  db: XosClient,
  recipientId: string,
): Promise<Result<DraftableAdvanceSections>> {
  const { data, error } = await db.rpc("draftable_advance_sections", {
    p_recipient_id: recipientId,
  });
  if (error) return fail(toDataError(error));
  return ok(data as unknown as DraftableAdvanceSections);
}

/** Records one drafted advance answer on the recipient's behalf (app.apply_drafted_advance_answer). */
export async function applyDraftedAdvanceAnswer(
  db: XosClient,
  input: {
    readonly suggestionId: string;
    readonly values?: Readonly<Record<string, unknown>>;
    readonly source: { readonly inbound_message_id: string } | { readonly file_name: string };
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("apply_drafted_advance_answer", {
    p_suggestion_id: input.suggestionId,
    p_values: (input.values ?? {}) as unknown as Json,
    p_source: input.source as unknown as Json,
  });
  if (error) return intakeError(error);
  return ok(String(data));
}

/** Whether the caller may read pay rates on the project, decided by the database (never a client flag). */
export async function readsPayroll(db: XosClient, projectId: string): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("my_capabilities_on_project", {
    p_project_id: projectId,
    p_capabilities: ["data.restricted.read.payroll"],
  });
  if (error) return fail(toDataError(error));
  return ok((data ?? []).includes("data.restricted.read.payroll"));
}

/** Which of the codes are active IATA airports (app.airports, R5), for the itinerary checks. */
export async function activeAirportCodes(
  db: XosClient,
  codes: readonly string[],
): Promise<Result<ReadonlySet<string>>> {
  const unique = [...new Set(codes.filter((c) => /^[A-Z]{3}$/.test(c)))];
  if (unique.length === 0) return ok(new Set());
  const { data, error } = await db
    .from("airports")
    .select("iata_code")
    .in("iata_code", unique.slice(0, 200))
    .eq("is_active", true);
  if (error) return fail(toDataError(error));
  return ok(new Set((data ?? []).map((r) => String(r.iata_code))));
}

export interface DraftSource {
  readonly id: string;
  readonly subject: string | null;
  readonly fromAddress: string;
  readonly receivedAt: string;
}

/**
 * Project inbox mail Aurora may read (B15): DKIM-verified, live, neither Rejected nor discarded,
 * newest first, at most 50, as the caller reads it (knowledge.document.write on the project). No
 * body leaves the database here; the handler reads it again when the person sends it.
 */
export async function listDraftSources(
  db: XosClient,
  projectId: string,
): Promise<Result<readonly DraftSource[]>> {
  const addresses = await db.from("inbound_addresses").select("id").eq("project_id", projectId);
  if (addresses.error) return fail(toDataError(addresses.error));
  if ((addresses.data ?? []).length === 0) return ok([]);
  const { data, error } = await db
    .from("inbound_messages")
    .select("id, subject_line, from_address, received_at")
    .in(
      "inbound_address_id",
      (addresses.data ?? []).map((a) => a.id),
    )
    .eq("purpose", "Project Inbox")
    .eq("dkim_verified", true)
    .neq("inbound_status", "Rejected")
    .is("discarded_at", null)
    .is("deleted_at", null)
    .order("received_at", { ascending: false })
    .limit(50);
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((m) => ({
      id: m.id,
      subject: m.subject_line ?? null,
      fromAddress: m.from_address,
      receivedAt: m.received_at,
    })),
  );
}

/**
 * Saves a governance draft (B15, G-240) as a project document: the document row, then the Markdown
 * as a text/plain attachment named `<title>.md`, which becomes the document's first version once it
 * scans Clean (0590). The caller writes the AI label as the file's first line.
 */
export async function saveDraftDocument(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly title: string;
    readonly markdown: string;
  },
): Promise<Result<{ readonly documentId: string; readonly scanStatus: string }>> {
  const title = input.title.trim().slice(0, 200);
  const created = await db
    .from("documents")
    .insert({ org_id: input.orgId, title, project_id: input.projectId })
    .select("id")
    .single();
  if (created.error) return fail(toDataError(created.error));
  const file = new Blob([input.markdown], { type: "text/plain" });
  const uploaded = await uploadAttachment(db, {
    subject: { table: "app.documents", id: created.data.id },
    file,
    filename: `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Draft"}.md`,
  });
  if (!uploaded.ok) return uploaded;
  return ok({ documentId: created.data.id, scanStatus: uploaded.data.scanStatus });
}

export interface IntakeTerm {
  /** role_code|worker_classification|pay_basis|arrangement, one canon rate card row. */
  readonly value: string;
  readonly label: string;
}

/**
 * The terms a contract intake's batch defaults offer (B15, G-177): canon rate card rows whose worker
 * classification is not an employee one, so XOS-ENG-2 cannot fire and every pick names a rate card
 * row, the Artist department's roles (2000) first. The person chooses one for the batch; Aurora
 * never proposes it.
 */
export async function intakeTermOptions(db: XosClient): Promise<Result<readonly IntakeTerm[]>> {
  const canon = db.schema("xpms" as "app") as unknown as XosClient;
  const [classes, cards] = await Promise.all([
    canon.from("worker_classification" as never).select("code, label, is_employee"),
    canon
      .from("rate_card" as never)
      .select("role_code, worker_classification, pay_basis, arrangement")
      .limit(2000),
  ]);
  if (classes.error) return fail(toDataError(classes.error));
  if (cards.error) return fail(toDataError(cards.error));
  const contractor = new Map(
    ((classes.data ?? []) as unknown as { code: string; label: string; is_employee: boolean }[])
      .filter((c) => !c.is_employee)
      .map((c) => [c.code, c.label]),
  );
  const rows = (
    (cards.data ?? []) as unknown as {
      role_code: string;
      worker_classification: string;
      pay_basis: string;
      arrangement: string;
    }[]
  ).filter((r) => contractor.has(r.worker_classification));
  const roleCodes = [...new Set(rows.map((r) => r.role_code))];
  const roles =
    roleCodes.length === 0
      ? { data: [], error: null }
      : await canon
          .from("role" as never)
          .select("role_code, job_title")
          .in("role_code", roleCodes.slice(0, 500));
  if (roles.error) return fail(toDataError(roles.error));
  const titles = new Map(
    ((roles.data ?? []) as unknown as { role_code: string; job_title: string }[]).map((r) => [
      r.role_code,
      r.job_title,
    ]),
  );
  const artistFirst = (code: string) => (code.startsWith("2000.") ? 0 : 1);
  return ok(
    rows
      .sort(
        (a, b) =>
          artistFirst(a.role_code) - artistFirst(b.role_code) ||
          a.role_code.localeCompare(b.role_code) ||
          a.worker_classification.localeCompare(b.worker_classification) ||
          a.pay_basis.localeCompare(b.pay_basis) ||
          a.arrangement.localeCompare(b.arrangement),
      )
      .slice(0, 300)
      .map((r) => ({
        value: [r.role_code, r.worker_classification, r.pay_basis, r.arrangement].join("|"),
        label: [
          titles.get(r.role_code) ?? r.role_code,
          contractor.get(r.worker_classification) ?? r.worker_classification,
          r.pay_basis,
          r.arrangement,
        ].join(" · "),
      })),
  );
}

/**
 * Recipients of the project's sent, live packets, as a picker lists them (B15, drafting from mail):
 * the person's name or the account's name, then the packet's title. Row level security decides
 * which the caller sees; app.draftable_advance_sections still needs advancing.submission.review.
 */
export async function listDraftRecipients(
  db: XosClient,
  projectId: string,
): Promise<Result<readonly { readonly id: string; readonly label: string }[]>> {
  const { data, error } = await db
    .from("advance_recipients")
    .select(
      "id, person:people(full_name), counterparty:counterparties(organization:organizations!counterparties_organization_id_fkey(name)), packet:advance_packets!inner(title, project_id, sent_at, deleted_at)",
    )
    .eq("packet.project_id", projectId)
    .not("packet.sent_at", "is", null)
    .is("packet.deleted_at", null)
    .is("deleted_at", null)
    .limit(200);
  if (error) return fail(toDataError(error));
  return ok(
    (
      (data ?? []) as unknown as {
        id: string;
        person: { full_name: string | null } | null;
        counterparty: { organization: { name: string } | null } | null;
        packet: { title: string } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      label: `${r.person?.full_name ?? r.counterparty?.organization?.name ?? ""} · ${r.packet?.title ?? ""}`,
    })),
  );
}

export interface AnswerDraft {
  readonly submissionId: string;
  readonly recorderName: string | null;
  /** The mail's subject, only when the reader may read that message; null otherwise. */
  readonly messageSubject: string | null;
  readonly fromMessage: boolean;
  readonly fileName: string | null;
}

/**
 * Which advance answers were recorded from an Aurora draft (B15, app.advance_answer_drafts), with
 * the recorder and the source. The subject of a source message is read again as the caller, so a
 * reader who may not read the project inbox sees only that it was a project inbox message; it is
 * never copied into the provenance.
 */
export async function listAnswerDrafts(
  db: XosClient,
  submissionIds: readonly string[],
): Promise<Result<readonly AnswerDraft[]>> {
  if (submissionIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("advance_answer_drafts")
    .select(
      "advance_submission_id, inbound_message_id, source_file_name, recorder:people!advance_answer_drafts_created_by_fkey(full_name)",
    )
    .in("advance_submission_id", [...submissionIds]);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    advance_submission_id: string;
    inbound_message_id: string | null;
    source_file_name: string | null;
    recorder: { full_name: string | null } | null;
  }[];
  const messageIds = rows.flatMap((r) => (r.inbound_message_id ? [r.inbound_message_id] : []));
  const subjects = new Map<string, string | null>();
  if (messageIds.length > 0) {
    const messages = await db
      .from("inbound_messages")
      .select("id, subject_line")
      .in("id", messageIds);
    if (messages.error) return fail(toDataError(messages.error));
    for (const m of messages.data ?? []) subjects.set(m.id, m.subject_line ?? null);
  }
  return ok(
    rows.map((r) => ({
      submissionId: r.advance_submission_id,
      recorderName: r.recorder?.full_name ?? null,
      messageSubject: r.inbound_message_id ? (subjects.get(r.inbound_message_id) ?? null) : null,
      fromMessage: r.inbound_message_id !== null,
      fileName: r.source_file_name,
    })),
  );
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
