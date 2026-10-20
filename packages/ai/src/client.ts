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

/** A failed call: a problem the API answered (refusal, not found) or a network failure (status 0). */
export interface AuroraProblem {
  readonly status: number;
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
  }): Promise<AuroraCall<AuroraApiResult>>;
  extract(input: {
    kind: "rider" | "insurance_certificate" | "invoice" | "receipt" | "quote";
    document_id?: string | null;
    media_type: "application/pdf" | "text/plain" | "image/png" | "image/jpeg" | "image/webp";
    content_base64: string;
    file_name: string;
  }): Promise<AuroraCall<AuroraApiResult>>;
  draft(input: {
    kind: "sop" | "advance_packet" | "email" | "day_sheet" | "change_order_description";
    instructions: string;
    context?: readonly { collection: string; id: string }[];
    verbiage?: readonly { term: string; preferred: string }[];
  }): Promise<AuroraCall<AuroraApiResult>>;
  summarize(input: {
    kind: "record_activity" | "project_week" | "gate_readiness";
    subject_collection: string;
    subject_id: string;
    items: readonly { collection: string; id: string }[];
  }): Promise<AuroraCall<AuroraApiResult>>;
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
    let response: Response;
    try {
      response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return {
        ok: false,
        problem: {
          status: 0,
          rule: null,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!response.ok) return { ok: false, problem: await toProblem(response) };
    return { ok: true, data: (await response.json()) as T };
  }

  return {
    status: () => call("GET", "/aurora/status"),
    ask: (question, history = []) => call("POST", "/aurora/ask", { question, history }),
    filter: (input) => call("POST", "/aurora/filter", input),
    extract: (input) => call("POST", "/aurora/extract", input),
    draft: (input) => call("POST", "/aurora/draft", input),
    summarize: (input) => call("POST", "/aurora/summarize", input),
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
