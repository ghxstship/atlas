/**
 * The Aurora API client for every surface: the Atlas panel in the browser and Compass on the
 * device. It talks only to the public API (`/api/v1/aurora/*` and `/api/v1/ai-suggestions/*`) with
 * the person's own credential, so Aurora can never see or do more than they can. It holds no model
 * provider code and no secrets, so it is safe in any bundle.
 */
import type { AiFeature } from "./model.ts";

export interface AuroraProposalSummary {
  readonly suggestion_id: string;
  readonly operation_id: string;
  readonly summary: string;
}

/** `AuroraResult` in the OpenAPI document. */
export interface AuroraApiResult<A = unknown> {
  readonly outcome: "answer" | "no_answer" | "failed";
  readonly ai_generated: true;
  readonly request_id: string | null;
  readonly model: string | null;
  readonly missing: string | null;
  readonly failure_code: string | null;
  readonly answer: A | null;
  readonly suggestions: readonly AuroraProposalSummary[];
}

export interface AuroraStatusResult {
  readonly enabled_features: readonly AiFeature[];
  readonly used: number;
  readonly allowance: number | null;
  readonly plan_includes_aurora: boolean;
}

export interface AuroraSuggestionField {
  readonly field_path: string;
  readonly proposed_value: unknown;
  readonly confidence: number | null;
  readonly refusal: "NO_ANSWER" | null;
  readonly missing: string | null;
  readonly source_excerpt: string | null;
  readonly provenance: "agent";
}

export interface AuroraSuggestion {
  readonly id: string;
  readonly operation_id: string;
  readonly target_id: string | null;
  readonly summary: string;
  readonly suggestion_state: "Proposed" | "Confirmed" | "Applied" | "Rejected" | "Expired";
  readonly expires_at: string;
  readonly applied_id: string | null;
  readonly proposed_fields: readonly AuroraSuggestionField[];
}

export interface AssistantAnswerBody {
  readonly text: string;
  readonly citations: readonly {
    readonly path: string;
    readonly id: string;
    readonly label: string;
  }[];
}

/** One of a page's own filters, offered to `aurora.filter` instead of the API fields (A95). */
export interface AuroraFilterField {
  readonly name: string;
  readonly type: "string" | "number" | "date" | "boolean" | "enum";
  readonly values?: readonly string[];
  readonly description?: string;
  readonly ops?: readonly (
    "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "is_null" | "contains"
  )[];
}

/** The answer of `aurora.filter`. */
export interface AuroraBuiltFilter {
  readonly collection: string;
  readonly name: string;
  readonly conditions: readonly {
    readonly field: string;
    readonly op: string;
    readonly value: string;
  }[];
  readonly sort: readonly string[];
  readonly query: string;
}

/** The answer of `aurora.draft`. */
export interface AuroraDraft {
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly gaps: readonly string[];
  readonly verbiageMisses: readonly string[];
  /** For a governance kind, the outline headings the draft lacks. */
  readonly missingHeadings?: readonly string[];
}

/** One flag of the gaps and clashes check on a drafted run of show (`@xos/ai/lists`). */
export interface AuroraRunOfShowFlag {
  readonly type: "overlap" | "gap" | "untimed" | "out_of_order";
  readonly positions: readonly number[];
  readonly minutes?: number;
}

/** A drafted cue, with the suggestion that holds it. */
export interface AuroraDraftedCue {
  readonly suggestion_id: string;
  readonly position: number;
  readonly label: string;
  readonly planned_at: string | null;
  readonly local_time: string | null;
  readonly day_offset: 0 | 1;
  readonly duration: string | null;
  readonly segment: string | null;
  readonly description: string | null;
}

/** A drafted risk, with the suggestion that holds it. */
export interface AuroraDraftedRisk {
  readonly suggestion_id: string;
  readonly title: string;
  readonly category: string;
  readonly likelihood: number | null;
  readonly impact: number | null;
  readonly mitigation: string;
}

interface AuroraListDraftBase {
  readonly title: string;
  readonly body: string;
  readonly gaps: readonly string[];
  readonly dropped: readonly { readonly line: number; readonly reason: string }[];
  readonly verbiageMisses: readonly string[];
  readonly flags: readonly AuroraRunOfShowFlag[];
}

/** The answer of `aurora.draft` for a run of show or a risk assessment (P6). */
export type AuroraListDraft =
  | (AuroraListDraftBase & {
      readonly kind: "run_of_show";
      readonly items: readonly AuroraDraftedCue[];
    })
  | (AuroraListDraftBase & {
      readonly kind: "risk_assessment";
      readonly items: readonly AuroraDraftedRisk[];
      /** The canon Risk subtypes a risk may take. */
      readonly categories: readonly string[];
    });

/** One kept line of a drafted list, with the values the person changed (`aurora.applyDraft`). */
export interface AuroraApplyDraftItem {
  readonly suggestion_id: string;
  readonly values?: Readonly<Record<string, unknown>>;
}

/** `AuroraAppliedDraft` in the OpenAPI document. */
export interface AuroraAppliedDraft {
  readonly written: readonly { readonly suggestion_id: string; readonly id: string }[];
  readonly rejected: number;
}

/** The answer of `aurora.summarize`. */
export interface AuroraSummary {
  readonly kind: string;
  readonly headline: string;
  readonly bullets: readonly { readonly text: string; readonly citations: readonly string[] }[];
}

/** A value an extraction read for a check, never proposed. */
export interface AuroraCheckValue {
  readonly value: unknown;
  readonly source_excerpt: string | null;
}

/** The tie-out of extracted lines against the printed totals (`@xos/ai/tieout`). */
export interface AuroraTieOut {
  readonly linesMinor: number;
  readonly subtotalResidualMinor: number | null;
  readonly totalResidualMinor: number | null;
  readonly unpricedLines: readonly number[];
  readonly status: "ties" | "residual" | "incomplete";
  readonly flags: readonly "currency_mismatch"[];
}

/** An earlier line of the same vendor (app.vendor_line_history), a hint beside an extracted line. */
export interface AuroraLineHistory {
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

/** A traveler or party a printed name may be (app.itinerary_traveler_candidates, app.intake_party_candidates). */
export interface AuroraCandidate {
  readonly name_index: number;
  readonly candidate_kind?: "counterparty" | "person" | "engagement";
  readonly candidate_id?: string;
  readonly person_id?: string;
  readonly name?: string;
  readonly full_name?: string;
  readonly roster_entry_id?: string | null;
  readonly engagement_id?: string | null;
  readonly already_booked?: boolean;
  readonly similarity: number;
}

/** One flag of the itinerary checks (`@xos/ai/itinerary`). */
export interface AuroraItineraryFlag {
  readonly type:
    | "arrival_before_departure"
    | "unknown_airport"
    | "duplicate_in_batch"
    | "inferred_zone"
    | "inferred_year";
  readonly line: number;
}

/** The answer of `aurora.extract`. */
export interface AuroraExtraction {
  readonly kind: string;
  readonly answered: number;
  readonly refused: number;
  readonly check?: Readonly<Record<string, AuroraCheckValue | null>>;
  /** A receipt's items, read-only. */
  readonly lines?: readonly Readonly<Record<string, AuroraCheckValue | null>>[];
  readonly tie_out?: AuroraTieOut;
  readonly history?: readonly AuroraLineHistory[];
  readonly checks?: readonly AuroraItineraryFlag[];
  readonly candidates?: readonly AuroraCandidate[];
  readonly dropped?: number;
  readonly inferred_year?: readonly number[];
}

/** The kinds `aurora.extract` reads. */
export type AuroraExtractKind =
  | "rider"
  | "insurance_certificate"
  | "invoice"
  | "receipt"
  | "quote"
  | "itinerary"
  | "contract"
  | "intake_rider"
  | "invoice_lines";

/** An Aurora intake batch with its requests and Proposed suggestions (auroraIntakes.get). */
export interface AuroraIntake {
  readonly id: string;
  readonly project_id: string;
  readonly intake_kind: "Itineraries" | "Contracts and Riders";
  readonly fulfillment_id: string | null;
  readonly file_count: number;
  readonly closed_at: string | null;
  readonly requests: readonly {
    readonly id: string;
    readonly outcome: "Pending" | "Answered" | "No Answer" | "Failed";
    readonly failure_code: string | null;
    readonly created_at: string;
  }[];
  readonly suggestions: readonly (AuroraSuggestion & { readonly request_id: string })[];
}

/** One kept segment of an itinerary intake, with the person's values (auroraIntakes.applyItineraries). */
export interface AuroraItineraryItem {
  readonly suggestion_id: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** One preview row of an itinerary intake, checked against the traveler's live segments. */
export interface AuroraItineraryCheckRow {
  readonly person_id: string;
  readonly service_identifier?: string | null;
  readonly departs_at?: string | null;
}

/** One act of a contract intake (auroraIntakes.applyContracts). */
export interface AuroraContractGroup {
  readonly act_name: string;
  readonly engagement: {
    readonly mode: "new" | "existing";
    readonly engagement_id?: string;
    readonly contract_suggestion_id?: string;
    readonly values?: Readonly<Record<string, unknown>>;
  };
  readonly riders?: readonly {
    readonly header_suggestion_id: string;
    readonly title?: string;
    readonly line_suggestion_ids?: readonly string[];
    readonly line_values?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }[];
}

/** What a contract intake wrote. */
export interface AuroraAppliedContracts {
  readonly applied: readonly { readonly suggestion_id: string; readonly id: string }[];
  readonly engagements: number;
  readonly riders: number;
  readonly rider_lines: number;
  readonly rejected: number;
}

/** A drafted advance answer line, in R9's line shape with the names it was read as. */
export interface AuroraAdvanceAnswerLine {
  readonly label: string;
  readonly asset_class_id?: string;
  readonly credential_category_id?: string;
  readonly quantity?: number;
  readonly roster_entry_id?: string;
  readonly person_name?: string;
  readonly needed_window_start?: string;
  readonly needed_window_end?: string;
  readonly window_zone?: string;
  readonly from_local?: string;
  readonly to_local?: string;
  readonly note?: string;
}

/** The answer of `aurora.draft` for advance answers (B15). */
export interface AuroraAdvanceAnswers {
  readonly answers: readonly {
    readonly suggestion_id: string | null;
    readonly section_id: string;
    readonly section_title: string;
    readonly kind: "Text" | "Schedule Window" | "Item Request" | "Credential Request";
    readonly body: string | null;
    readonly lines: readonly AuroraAdvanceAnswerLine[];
    readonly source_excerpt: string | null;
    readonly dropped: readonly {
      readonly line: number;
      readonly reason: string;
      readonly choice?: string;
    }[];
  }[];
  readonly unanswered: readonly { readonly section_id: string; readonly title: string }[];
}

/** The source of drafted advance answers: a project inbox message or a document. */
export type AuroraDraftSource =
  | { readonly inbound_message_id: string }
  | {
      readonly document: {
        readonly media_type:
          "application/pdf" | "text/plain" | "image/png" | "image/jpeg" | "image/webp";
        readonly content_base64: string;
        readonly file_name: string;
      };
    };

/** The governance kinds drafted into project documents (B15). */
export type AuroraGovernanceKind = "event_plan" | "event_brief" | "approval_pack" | "waste_plan";

/** The answer of `aurora.bindCode`. */
export interface AuroraCodeBinding {
  readonly code: string;
  readonly elementId: string;
  readonly name: string;
  readonly urid: string;
  readonly confidence: number;
  readonly reason: string;
}

/** `AuroraPreviewRequest` in the OpenAPI document. */
export interface AuroraPreviewRequest {
  readonly feature: "drafting" | "summaries";
  /** For a drafted list, advance answers or a governance draft: what is drafted, so the preview reads what the draft reads. */
  readonly draft_kind?:
    "run_of_show" | "risk_assessment" | "advance_answers" | AuroraGovernanceKind;
  /** For a drafted list: the running order or project it fills. */
  readonly target?: { readonly collection: string; readonly id: string };
  readonly kind?: "record_activity" | "project_week" | "gate_readiness";
  readonly subject_collection?: string;
  readonly subject_id?: string;
  readonly items: readonly { readonly collection: string; readonly id: string }[];
}

/** One record a request would send, as the model would see it. */
export interface AuroraPreviewRecord {
  readonly collection: string;
  readonly id: string;
  /** False when the record cannot be read or its whole table is never sent. */
  readonly sent: boolean;
  /** Fields that would be sent. */
  readonly fields: readonly string[];
  /** Fields left out: Restricted columns and masked values. */
  readonly withheld: readonly string[];
  /** The values that would be sent; null when nothing of the record is sent. */
  readonly data: Readonly<Record<string, unknown>> | null;
}

/** `AuroraPreview` in the OpenAPI document. */
export interface AuroraPreviewResult {
  readonly records: readonly AuroraPreviewRecord[];
  /** Verbiage library terms a draft would follow. */
  readonly vocabulary_terms: number;
  /** For a risk assessment, the canon Risk categories the draft may use. */
  readonly categories?: readonly string[];
}

/** A failed call: a problem the API answered (refusal, not found) or a network failure (status 0). */
export interface AuroraProblem {
  readonly status: number;
  /** The refusal rule; `timeout` when the client gave up waiting (status 0). */
  readonly rule: string | null;
  readonly detail: string;
}

export type AuroraCall<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problem: AuroraProblem };

export interface AuroraClientOptions {
  /** API origin and prefix, for example `/api/v1` in Atlas or `https://api.ghxstship.tech/v1`. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Extra headers, for example `Authorization: Bearer <session JWT>` on Compass. */
  readonly headers?: () =>
    Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /** Idempotency keys for POSTs; defaults to crypto.randomUUID. */
  readonly idempotencyKey?: () => string;
  /**
   * How long to wait for an answer before giving up, in milliseconds. A call that runs longer
   * answers with the problem `{ status: 0, rule: "timeout" }`; no limit when unset.
   */
  readonly timeoutMs?: number;
}

/** The rule of the problem a call answers when it waited longer than `timeoutMs`. */
export const TIMEOUT_RULE = "timeout";

function timedOut(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export interface AuroraClient {
  status(): Promise<AuroraCall<AuroraStatusResult>>;
  ask(
    question: string,
    history?: readonly { question: string; answer: string }[],
  ): Promise<AuroraCall<AuroraApiResult<AssistantAnswerBody>>>;
  filter(input: {
    sentence: string;
    collections: readonly string[];
    time_zone: string;
    /** A page's own filters, used instead of the collection's API fields (A95). */
    fields?: readonly AuroraFilterField[];
  }): Promise<AuroraCall<AuroraApiResult<AuroraBuiltFilter>>>;
  /**
   * Reads a document, or for an itinerary a project inbox message, into proposed fields. B15: an
   * intake batch or an invoice can be the subject; exactly one of content_base64 and
   * inbound_message_id is given.
   */
  extract(input: {
    kind: AuroraExtractKind;
    document_id?: string | null;
    intake_batch_id?: string;
    invoice_id?: string;
    inbound_message_id?: string;
    media_type?: "application/pdf" | "text/plain" | "image/png" | "image/jpeg" | "image/webp";
    content_base64?: string;
    file_name?: string;
  }): Promise<AuroraCall<AuroraApiResult<AuroraExtraction>>>;
  /** Prose drafts; a governance kind (B15) names its project as `target`. */
  draft(
    input:
      | {
          kind: "sop" | "advance_packet" | "email" | "day_sheet" | "change_order_description";
          instructions: string;
          context?: readonly { collection: string; id: string }[];
          verbiage?: readonly { term: string; preferred: string }[];
        }
      | {
          kind: AuroraGovernanceKind;
          instructions: string;
          target: { collection: "projects"; id: string };
          verbiage?: readonly { term: string; preferred: string }[];
          /** The outline headings in the person's locale; the English outline when absent. */
          outline?: readonly string[];
        },
  ): Promise<AuroraCall<AuroraApiResult<AuroraDraft>>>;
  /** A run of show or risk assessment drafted into an empty list (P6); `target` names the list. */
  draft(input: {
    kind: "run_of_show" | "risk_assessment";
    instructions: string;
    target: { collection: string; id: string };
    context?: readonly { collection: string; id: string }[];
    verbiage?: readonly { term: string; preferred: string }[];
  }): Promise<AuroraCall<AuroraApiResult<AuroraListDraft>>>;
  /** Advance answers drafted for a recipient of a sent packet from one source (B15). */
  draft(input: {
    kind: "advance_answers";
    instructions: string;
    target: { collection: "advance-recipients"; id: string };
    source: AuroraDraftSource;
  }): Promise<AuroraCall<AuroraApiResult<AuroraAdvanceAnswers>>>;
  /** Opens an intake batch: one metered request per file, applied together (B15). */
  startIntake(input: {
    project_id: string;
    kind: "Itineraries" | "Contracts and Riders";
    file_count: number;
    fulfillment_id?: string;
  }): Promise<AuroraCall<AuroraIntake>>;
  /** An intake batch with its requests and Proposed suggestions, so a preview reloads. */
  getIntake(id: string): Promise<AuroraCall<AuroraIntake>>;
  /** Closes an intake batch, rejecting what is left. */
  closeIntake(id: string): Promise<AuroraCall<{ readonly rejected: number }>>;
  /** Files the kept segments of an itinerary intake in one step. */
  applyItineraries(
    id: string,
    items: readonly AuroraItineraryItem[],
  ): Promise<AuroraCall<AuroraAppliedDraft>>;
  /** Which preview rows the traveler already has as live segments (positions from 1), to start them unchecked. */
  checkItineraries(
    id: string,
    segments: readonly AuroraItineraryCheckRow[],
  ): Promise<AuroraCall<{ readonly booked: readonly number[] }>>;
  /** Books the kept acts of a contract intake with their riders in one step. */
  applyContracts(
    id: string,
    groups: readonly AuroraContractGroup[],
  ): Promise<AuroraCall<AuroraAppliedContracts>>;
  /** Records one drafted advance answer on the recipient's behalf. */
  applyAdvanceAnswer(input: {
    suggestion_id: string;
    values?: Readonly<Record<string, unknown>>;
    source: { inbound_message_id: string } | { file_name: string };
  }): Promise<AuroraCall<{ readonly submission_id: string }>>;
  /**
   * Adds the kept lines of a drafted list in one step (aurora.applyDraft), only while the list is
   * still empty; every other line of the draft is rejected. Calls no model.
   */
  applyDraft(input: {
    request_id: string;
    items: readonly AuroraApplyDraftItem[];
  }): Promise<AuroraCall<AuroraAppliedDraft>>;
  summarize(input: {
    kind: "record_activity" | "project_week" | "gate_readiness";
    subject_collection: string;
    subject_id: string;
    items: readonly { collection: string; id: string }[];
  }): Promise<AuroraCall<AuroraApiResult<AuroraSummary>>>;
  /** Import column suggestions (aurora.mapColumns): a target field or null per column, with a confidence. */
  mapColumns(input: {
    collection: string;
    columns: readonly { header: string; samples: readonly string[] }[];
    fields: readonly { name: string; description: string }[];
  }): Promise<
    AuroraCall<
      AuroraApiResult<readonly { column: string; field: string | null; confidence: number }[]>
    >
  >;
  bindCode(input: {
    code: string;
    description: string | null;
    candidates: readonly { element_id: string; name: string; urid: string }[];
  }): Promise<AuroraCall<AuroraApiResult<AuroraCodeBinding>>>;
  /** What a drafting or summary request would send, read and scrubbed as the request would be. */
  preview(input: AuroraPreviewRequest): Promise<AuroraCall<AuroraPreviewResult>>;
  suggestion(id: string): Promise<AuroraCall<AuroraSuggestion>>;
  confirm(
    id: string,
    reason: string,
    values?: Readonly<Record<string, unknown>>,
  ): Promise<AuroraCall<AuroraSuggestion>>;
  reject(id: string, reason: string): Promise<AuroraCall<AuroraSuggestion>>;
}

async function toProblem(response: Response): Promise<AuroraProblem> {
  let body: { rule?: unknown; detail?: unknown; title?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    return {
      status: response.status,
      rule: null,
      detail: `The API answered ${response.status}: ${String(error)}`,
    };
  }
  return {
    status: response.status,
    rule: typeof body.rule === "string" ? body.rule : null,
    detail:
      typeof body.detail === "string"
        ? body.detail
        : typeof body.title === "string"
          ? body.title
          : `The API answered ${response.status}.`,
  };
}

export function createAuroraClient(options: AuroraClientOptions): AuroraClient {
  const doFetch = options.fetch ?? fetch;
  const key = options.idempotencyKey ?? (() => crypto.randomUUID());

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<AuroraCall<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(await options.headers?.()),
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = key();
    }
    const signal =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const failure = (error: unknown): AuroraCall<T> => ({
      ok: false,
      problem: timedOut(error, signal)
        ? {
            status: 0,
            rule: TIMEOUT_RULE,
            detail: `No answer within ${Math.round((options.timeoutMs ?? 0) / 1000)} seconds.`,
          }
        : { status: 0, rule: null, detail: error instanceof Error ? error.message : String(error) },
    });
    let response: Response;
    try {
      response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return failure(error);
    }
    if (!response.ok) return { ok: false, problem: await toProblem(response) };
    try {
      return { ok: true, data: (await response.json()) as T };
    } catch (error) {
      return failure(error);
    }
  }

  return {
    status: () => call("GET", "/aurora/status"),
    ask: (question, history = []) => call("POST", "/aurora/ask", { question, history }),
    filter: (input) => call("POST", "/aurora/filter", input),
    extract: (input) => call("POST", "/aurora/extract", input),
    // One route answers every draft overload; the kind decides the answer's shape.
    draft: ((input: unknown) => call("POST", "/aurora/draft", input)) as AuroraClient["draft"],
    applyDraft: (input) => call("POST", "/aurora/apply-draft", input),
    startIntake: (input) => call("POST", "/aurora/intakes", input),
    getIntake: (id) => call("GET", `/aurora/intakes/${encodeURIComponent(id)}`),
    closeIntake: (id) => call("POST", `/aurora/intakes/${encodeURIComponent(id)}/close`, {}),
    applyItineraries: (id, items) =>
      call("POST", `/aurora/intakes/${encodeURIComponent(id)}/apply-itineraries`, { items }),
    checkItineraries: (id, segments) =>
      call("POST", `/aurora/intakes/${encodeURIComponent(id)}/check-itineraries`, { segments }),
    applyContracts: (id, groups) =>
      call("POST", `/aurora/intakes/${encodeURIComponent(id)}/apply-contracts`, { groups }),
    applyAdvanceAnswer: (input) => call("POST", "/aurora/apply-advance-answer", input),
    summarize: (input) => call("POST", "/aurora/summarize", input),
    mapColumns: (input) => call("POST", "/aurora/map-columns", input),
    bindCode: (input) => call("POST", "/aurora/bind-code", input),
    preview: (input) => call("POST", "/aurora/preview", input),
    suggestion: (id) => call("GET", `/ai-suggestions/${encodeURIComponent(id)}`),
    confirm: (id, reason, values) =>
      call(
        "POST",
        `/ai-suggestions/${encodeURIComponent(id)}/confirm`,
        values ? { reason, values } : { reason },
      ),
    reject: (id, reason) =>
      call("POST", `/ai-suggestions/${encodeURIComponent(id)}/reject`, { reason }),
  };
}
