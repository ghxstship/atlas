import type { Database, Json } from "./database.types.ts";
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import * as enums from "./enums.generated.ts";

/**
 * Aurora AI repository (Section 4.7, migration 0650). Every call runs with the signed-in person's
 * session, so row level security and the 0650 RPCs decide what they may read, start and confirm.
 * `createAuroraStore` is the persistence the `@xos/ai` request runner takes.
 */

export type AiFeature = Database["app"]["Enums"]["ai_feature"];
export type AiSuggestionState = Database["app"]["Enums"]["ai_suggestion_state"];

/** The features in settings order (Section 4.7 table order). */
export const AI_FEATURE_ORDER: readonly AiFeature[] = enums.aiFeature;

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

// Drafted lists (P6, migration 3830) ---------------------------------------------------------

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
  /**
   * The connected app that proposed a change through hosted MCP (B16, 6052), named instead of Aurora; null for
   * Aurora's own requests. The name is null too when the reader cannot see the app (org.settings.read).
   */
  readonly connectedApp: { readonly id: string; readonly name: string | null } | null;
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
      "id, person_id, feature, model, outcome, created_at, oauth_app_id, oauth_apps(name), ai_usage(input_tokens, output_tokens)",
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
        oauth_app_id?: string | null;
        oauth_apps?: { name: string } | { name: string }[] | null;
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
      connectedApp: r.oauth_app_id
        ? {
            id: r.oauth_app_id,
            name: (Array.isArray(r.oauth_apps) ? r.oauth_apps[0] : r.oauth_apps)?.name ?? null,
          }
        : null,
    })),
  );
}

// Aurora intake (B15, migrations 6270 to 6274; ADR 0154) ------------------------------------------

/** A refusal for a value of the wrong type or format, named by its line, is an invalid value. */
function intakeError(error: { code?: string; message: string; hint?: string | null }) {
  if (["22007", "22008", "23502", "22003", "22P02"].includes(error.code ?? "")) {
    return fail({ kind: "invalid", message: error.message });
  }
  return fail(toDataError(error));
}

export type IntakeScopeKind = "itinerary" | "contract" | "governance";

export interface IntakeScope {
  readonly project_id: string;
  /** A contract: the caller reads pay, so the model is asked for a fee. */
  readonly fee_visible?: boolean;
  /** A contract: the caller may add riders. */
  readonly can_write_riders?: boolean;
}

/** The capability check of an intake or governance draft, before any model call (app.aurora_intake_scope). */
export async function auroraIntakeScope(
  db: XosClient,
  kind: IntakeScopeKind,
  projectId: string,
): Promise<Result<IntakeScope>> {
  const { data, error } = await db.rpc("aurora_intake_scope", {
    p_kind: kind,
    p_project_id: projectId,
  });
  if (error) return fail(toDataError(error));
  return ok(data as unknown as IntakeScope);
}

export interface TravelerCandidate {
  readonly person_id: string;
  readonly engagement_id: string | null;
  readonly display_name: string;
  readonly source: "Member" | "Engagement" | "Roster";
}

/** Who an itinerary's passengers may be: names only, no travel value (app.itinerary_traveler_candidates). */
export async function itineraryTravelerCandidates(
  db: XosClient,
  projectId: string,
): Promise<Result<readonly TravelerCandidate[]>> {
  const { data, error } = await db.rpc("itinerary_traveler_candidates", {
    p_project_id: projectId,
  });
  if (error) return fail(toDataError(error));
  return ok((data ?? []) as unknown as TravelerCandidate[]);
}

export interface ContractParty {
  readonly kind: "counterparty" | "person";
  readonly id: string;
  readonly name: string;
  /** The party's live Artist engagements on the project. */
  readonly engagement_ids: readonly string[];
}

export interface ContractRateCard {
  readonly role_code: string;
  readonly role_name: string;
  readonly worker_classification: string;
  readonly worker_classification_label: string;
  readonly pay_basis: string;
  readonly arrangement: string;
}

export interface ContractIntakeOptions {
  readonly parties: readonly ContractParty[];
  readonly rate_cards: readonly ContractRateCard[];
}

/** The parties and non-employee rate card rows a contract review offers (app.contract_intake_options). */
export async function contractIntakeOptions(
  db: XosClient,
  projectId: string,
): Promise<Result<ContractIntakeOptions>> {
  const { data, error } = await db.rpc("contract_intake_options", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(data as unknown as ContractIntakeOptions);
}

export interface AppliedItineraryLines {
  readonly written: readonly { readonly suggestion_id: string; readonly id: string }[];
  readonly duplicates_checked: number;
}

/** Adds kept itinerary lines as travel segments in one transaction (app.apply_itinerary_lines). */
export async function applyItineraryLines(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly fulfillmentId: string | null;
    readonly items: readonly {
      readonly suggestion_id: string;
      readonly values: Readonly<Record<string, unknown>>;
    }[];
  },
): Promise<Result<AppliedItineraryLines>> {
  const { data, error } = await db.rpc("apply_itinerary_lines", {
    p_project_id: input.projectId,
    // The generated argument type takes a uuid; the function accepts null for no fulfillment.
    p_fulfillment_id: input.fulfillmentId as string,
    p_items: input.items as unknown as Json,
  });
  if (error) return intakeError(error);
  return ok(data as unknown as AppliedItineraryLines);
}

export interface ContractIntakeItem {
  readonly suggestion_ids: readonly string[];
  readonly party: { readonly person_id?: string; readonly counterparty_id?: string };
  readonly engagement_id?: string;
  readonly role_code?: string;
  readonly worker_classification?: string;
  readonly pay_basis?: string;
  readonly arrangement?: string;
  readonly start_date?: string;
  readonly end_date?: string;
  readonly agreed_rate_minor?: number;
  readonly currency_code?: string;
  readonly create_riders?: boolean;
}

export interface AppliedContractIntake {
  readonly engagements: readonly {
    readonly suggestion_ids: readonly string[];
    readonly engagement_id: string;
    readonly created: boolean;
    readonly documents: readonly {
      readonly suggestion_id: string;
      readonly engagement_document_id: string | null;
      readonly document_type: "Contract" | "Rider";
    }[];
  }[];
  readonly riders: number;
}

/** Books the groups of a contract review in one transaction (app.apply_contract_intake). */
export async function applyContractIntake(
  db: XosClient,
  input: { readonly projectId: string; readonly items: readonly ContractIntakeItem[] },
): Promise<Result<AppliedContractIntake>> {
  const { data, error } = await db.rpc("apply_contract_intake", {
    p_project_id: input.projectId,
    p_items: input.items as unknown as Json,
  });
  if (error) return intakeError(error);
  return ok(data as unknown as AppliedContractIntake);
}

export interface OpenProposalField {
  readonly field_path: string;
  readonly proposed_value: unknown;
  readonly confidence: number | null;
  readonly refusal: string | null;
  readonly missing: string | null;
  readonly source_excerpt: string | null;
}

export interface OpenProposal {
  readonly id: string;
  readonly request_id: string;
  readonly operation_id: string;
  readonly target_id: string | null;
  readonly summary: string;
  readonly expires_at: string;
  readonly proposed_fields: readonly OpenProposalField[];
}

async function withFields(
  db: XosClient,
  rows: readonly Omit<OpenProposal, "proposed_fields">[],
): Promise<Result<readonly OpenProposal[]>> {
  if (rows.length === 0) return ok([]);
  // Read as the caller, so row level security leaves out a Restricted fee.
  const { data, error } = await db
    .from("ai_suggestion_fields")
    .select(
      "suggestion_id, field_path, proposed_value, confidence, refusal, missing, source_excerpt, position",
    )
    .in(
      "suggestion_id",
      rows.map((r) => r.id),
    )
    .is("deleted_at", null)
    .order("position");
  if (error) return fail(toDataError(error));
  return ok(
    rows.map((r) => ({
      ...r,
      proposed_fields: (data ?? [])
        .filter((f) => f.suggestion_id === r.id)
        .map((f) => ({
          field_path: f.field_path,
          proposed_value: f.proposed_value,
          confidence: f.confidence,
          refusal: f.refusal,
          missing: f.missing,
          source_excerpt: f.source_excerpt,
        })),
    })),
  );
}

const OPEN_PROPOSAL_COLUMNS = "id, request_id, operation_id, target_id, summary, expires_at";

/**
 * The caller's open proposals of a project's intake: an intake is its open suggestions, so a reload
 * resumes the review until they expire at 7 days (ADR 0154 D3). Asks no model and meters nothing.
 */
export async function listOpenProposals(
  db: XosClient,
  input: {
    readonly personId: string;
    readonly projectId: string;
    readonly operationId: string;
  },
): Promise<Result<readonly OpenProposal[]>> {
  const requests = await db
    .from("ai_requests")
    .select("id")
    .eq("person_id", input.personId)
    .eq("feature", "extraction")
    .eq("subject_table", "app.projects")
    .eq("subject_id", input.projectId)
    .is("deleted_at", null);
  if (requests.error) return fail(toDataError(requests.error));
  const ids = (requests.data ?? []).map((r) => r.id);
  if (ids.length === 0) return ok([]);
  const { data, error } = await db
    .from("ai_suggestions")
    .select(OPEN_PROPOSAL_COLUMNS)
    .in("request_id", ids)
    .eq("operation_id", input.operationId)
    .eq("suggestion_state", "Proposed")
    .gt("expires_at", new Date().toISOString())
    .is("deleted_at", null)
    .order("created_at")
    .limit(500);
  if (error) return fail(toDataError(error));
  return withFields(db, data ?? []);
}

/**
 * The caller's open line suggestions of an invoice: the lines whose request's invoices.create
 * suggestion was saved as this invoice, never another invoice's (ADR 0154).
 */
export async function listInvoiceLineProposals(
  db: XosClient,
  invoiceId: string,
  personId: string,
): Promise<Result<readonly OpenProposal[]>> {
  const headers = await db
    .from("ai_suggestions")
    .select("request_id, ai_requests!inner(person_id)")
    .eq("operation_id", "invoices.create")
    .eq("suggestion_state", "Applied")
    .eq("applied_id", invoiceId)
    .eq("ai_requests.person_id", personId)
    .is("deleted_at", null);
  if (headers.error) return fail(toDataError(headers.error));
  const ids = (headers.data ?? []).map((h) => h.request_id);
  if (ids.length === 0) return ok([]);
  const { data, error } = await db
    .from("ai_suggestions")
    .select(OPEN_PROPOSAL_COLUMNS)
    .in("request_id", ids)
    .eq("operation_id", "invoiceLines.create")
    .eq("suggestion_state", "Proposed")
    .gt("expires_at", new Date().toISOString())
    .is("deleted_at", null)
    .order("created_at")
    .limit(100);
  if (error) return fail(toDataError(error));
  return withFields(db, data ?? []);
}

/** Adds kept invoice lines, as the caller (app.apply_invoice_line_suggestions). */
export async function applyInvoiceLineSuggestions(
  db: XosClient,
  invoiceId: string,
  items: readonly {
    readonly suggestion_id: string;
    readonly values: Readonly<Record<string, unknown>>;
  }[],
): Promise<Result<{ readonly written: readonly { suggestion_id: string; id: string }[] }>> {
  const { data, error } = await db.rpc("apply_invoice_line_suggestions", {
    p_invoice_id: invoiceId,
    p_items: items as unknown as Json,
  });
  if (error) return intakeError(error);
  return ok(data as unknown as { written: { suggestion_id: string; id: string }[] });
}

export interface VendorLineHistoryEntry {
  readonly description_index: number;
  readonly description: string;
  readonly quantity: number;
  readonly unit_price_minor: number | null;
  readonly currency_code: string;
  readonly invoice_number: string | null;
  readonly issued_on: string | null;
  readonly budget_line_id: string | null;
  readonly budget_line_name: string | null;
}

/** What the same counterparty billed before, by row level security (app.vendor_line_history). */
export async function vendorLineHistory(
  db: XosClient,
  invoiceId: string,
  descriptions: readonly string[],
): Promise<Result<readonly VendorLineHistoryEntry[]>> {
  const { data, error } = await db.rpc("vendor_line_history", {
    p_invoice_id: invoiceId,
    p_descriptions: [...descriptions],
  });
  if (error) return fail(toDataError(error));
  return ok((data ?? []) as unknown as VendorLineHistoryEntry[]);
}

export interface InvoiceTieOutRow {
  readonly invoice_id: string;
  readonly printed_total_minor: number | null;
  readonly computed_total_minor: number | null;
  readonly residual_minor: number | null;
}

/** An invoice's printed total against its lines, computed and never stored (app.invoice_tie_out). */
export async function getInvoiceTieOut(
  db: XosClient,
  invoiceId: string,
): Promise<Result<InvoiceTieOutRow | null>> {
  const { data, error } = await db
    .from("invoice_tie_out")
    .select("invoice_id, printed_total_minor, computed_total_minor, residual_minor")
    .eq("invoice_id", invoiceId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok((data as InvoiceTieOutRow | null) ?? null);
}

// Advance answers (B15) -----------------------------------------------------------------------------

export interface AdvanceDraftScope {
  readonly recipient_id: string;
  readonly packet_id: string;
  readonly project_id: string;
  readonly time_zone: string;
  readonly sections: readonly {
    readonly id: string;
    readonly title: string;
    readonly prompt: string | null;
    readonly kind: "Text" | "Schedule Window" | "Item Request" | "Credential Request";
    readonly window_kind: string | null;
    readonly max_lines: number | null;
    readonly choices: readonly { readonly id: string; readonly name: string }[];
  }[];
}

/** What Aurora may draft for a recipient, before any model call (app.advance_draft_scope). */
export async function advanceDraftScope(
  db: XosClient,
  recipientId: string,
): Promise<Result<AdvanceDraftScope>> {
  const { data, error } = await db.rpc("advance_draft_scope", { p_recipient_id: recipientId });
  if (error) return fail(toDataError(error));
  return ok(data as unknown as AdvanceDraftScope);
}

/** Records one accepted answer for the person who accepts it (app.record_drafted_advance_answer). */
export async function recordDraftedAdvanceAnswer(
  db: XosClient,
  suggestionId: string,
  values: Readonly<Record<string, unknown>> = {},
): Promise<Result<string>> {
  const { data, error } = await db.rpc("record_drafted_advance_answer", {
    p_suggestion_id: suggestionId,
    p_values: values as unknown as Json,
  });
  if (error) return intakeError(error);
  return ok(data as string);
}

/** Where an advance answer recorded from an Aurora draft came from. */
export interface AnswerSource {
  readonly submissionId: string;
  readonly sourceKind: "Project Inbox" | "File";
  readonly fileName: string | null;
  readonly excerpt: string;
  /** The sender of the mail, only when the reader may read that message. */
  readonly fromAddress: string | null;
  readonly accepterName: string | null;
}

/** The sources of the given answers, as the caller reads them (app.advance_answer_sources). */
export async function listAnswerSources(
  db: XosClient,
  submissionIds: readonly string[],
): Promise<Result<readonly AnswerSource[]>> {
  if (submissionIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("advance_answer_sources")
    .select(
      "advance_submission_id, source_kind, inbound_message_id, file_name, source_excerpt, created_by",
    )
    .in("advance_submission_id", [...submissionIds]);
  if (error) return fail(toDataError(error));
  const rows = data ?? [];
  const messageIds = rows.flatMap((r) => (r.inbound_message_id ? [r.inbound_message_id] : []));
  const senders = new Map<string, string>();
  if (messageIds.length > 0) {
    const messages = await db
      .from("inbound_messages")
      .select("id, from_address")
      .in("id", messageIds);
    if (messages.error) return fail(toDataError(messages.error));
    for (const m of messages.data ?? []) senders.set(m.id, m.from_address);
  }
  const people = rows.flatMap((r) => (r.created_by ? [r.created_by] : []));
  const names = new Map<string, string>();
  if (people.length > 0) {
    const named = await db.rpc("person_names", { p_person_ids: people });
    if (named.error) return fail(toDataError(named.error));
    for (const p of named.data ?? []) names.set(p.person_id, p.full_name);
  }
  return ok(
    rows.map((r) => ({
      submissionId: r.advance_submission_id,
      sourceKind: r.source_kind,
      fileName: r.file_name,
      excerpt: r.source_excerpt,
      fromAddress: r.inbound_message_id ? (senders.get(r.inbound_message_id) ?? null) : null,
      accepterName: r.created_by ? (names.get(r.created_by) ?? null) : null,
    })),
  );
}
