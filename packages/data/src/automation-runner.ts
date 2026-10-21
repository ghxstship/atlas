import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTOMATION_LIMITS, renderField } from "@xos/schemas/automations";

/**
 * The automation worker (A91, ADR 0047; migration 1481): one pass over the queued automation.run jobs, the logic the
 * automation-run Edge Function runs on a schedule. Every action is a public API call made as the automation's owner
 * with a short-lived token minted for that person, so row level security and capabilities decide every write; the
 * service role only claims jobs and writes the runs ledger. The database decides before each run whether the owner
 * may still act (app.begin_automation_run, fail closed) and settles each run through the job queue's backoff
 * (app.finish_automation_run).
 *
 * Failures are sorted by what can fix them: 401 and 403 mean the API refused the owner, so the run fails and the
 * automation pauses with a notice (refused); 408, 409, 425, 429, 5xx and a network error may pass, so the job queue
 * retries the run from the failed step (retry); anything else fails the run for good (failed). Each POST carries an
 * Idempotency-Key per run and action, so a retry never repeats a write the API already made.
 *
 * The token is an HS256 JWT signed with the project's JWT secret (XOS_API_JWT_SIGNING_KEY, the same secret api-token
 * and A83's chat sessions use), valid for two minutes, minted per action and never stored or logged. Its claims carry
 * the org it is bound to and the run (xos_automation_run_id), which the fan-out trigger reads to keep automation-caused
 * chains within private.automation_max_depth().
 */

export const AUTOMATION_RUN_JOB = "automation.run";
export const OWNER_TOKEN_SECONDS = 120;

export interface ClaimedAutomationJob {
  readonly jobId: string;
  readonly runId: string;
}

/** One action as app.begin_automation_run returns it, with due dates on the org's calendar. */
export interface BegunAction {
  readonly position: number;
  readonly action_id: string;
  readonly type: string;
  readonly title?: string;
  readonly body?: string;
  readonly project_id?: string;
  readonly phase_code?: string;
  readonly xyz?: string;
  readonly due_at?: string;
  readonly to_state?: string;
  readonly assignee_person_id?: string;
  readonly recipient_person_id?: string;
  readonly webhook_endpoint_id?: string;
}

export interface BegunRun {
  readonly outcome: "run";
  readonly run_id: string;
  readonly org_id: string;
  readonly automation_id: string;
  readonly automation_name: string;
  readonly owner_person_id: string;
  readonly owner_user_id: string;
  readonly depth: number;
  readonly event: unknown;
  readonly actions: readonly BegunAction[];
  readonly completed: readonly number[];
}

export type BeginOutcome =
  | BegunRun
  | {
      readonly outcome: "missing" | "settled" | "skipped" | "refused";
      readonly error_code?: string;
    };

export type StepStatus = "Succeeded" | "Failed" | "Skipped";
export type FinishOutcome = "succeeded" | "retry" | "failed" | "refused";

export interface StepRecord {
  readonly runId: string;
  readonly position: number;
  readonly actionId: string | null;
  readonly actionType: string;
  readonly operationId: string | null;
  readonly status: StepStatus;
  readonly request: unknown;
  readonly response: unknown;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
}

/** The service-role half: claim, begin, record and finish (the 0510 and 1481 RPCs). */
export interface AutomationRunStore {
  claim(worker: string, limit: number): Promise<ClaimedAutomationJob[]>;
  begin(runId: string, jobId: string): Promise<BeginOutcome>;
  recordStep(step: StepRecord): Promise<void>;
  finish(
    runId: string,
    jobId: string,
    outcome: FinishOutcome,
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<string>;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected text in ${key}.`);
  return value;
}

/** AutomationRunStore over a service-role Supabase client. */
export function supabaseAutomationRunStore(client: SupabaseClient): AutomationRunStore {
  const app = client.schema("app");
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await app.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    async claim(worker, limit) {
      const rows = (await call("claim_jobs", {
        p_worker: worker,
        p_job_kind: AUTOMATION_RUN_JOB,
        p_limit: limit,
      })) as Record<string, unknown>[] | null;
      return (rows ?? []).map((r) => ({ jobId: text(r, "id"), runId: text(r, "subject_id") }));
    },
    async begin(runId, jobId) {
      return (await call("begin_automation_run", {
        p_run_id: runId,
        p_job_id: jobId,
      })) as BeginOutcome;
    },
    async recordStep(step) {
      await call("record_automation_step", {
        p_run_id: step.runId,
        p_position: step.position,
        p_action_id: step.actionId,
        p_action_type: step.actionType,
        p_operation_id: step.operationId,
        p_step_status: step.status,
        p_request_body: step.request ?? null,
        p_response_body: step.response ?? null,
        p_http_status: step.httpStatus,
        p_error_code: step.errorCode,
        p_error_message: step.errorMessage,
        p_started_at: step.startedAt,
        p_duration_ms: step.durationMs,
      });
    },
    async finish(runId, jobId, outcome, errorCode, errorMessage) {
      return String(
        await call("finish_automation_run", {
          p_run_id: runId,
          p_job_id: jobId,
          p_outcome: outcome,
          p_error_code: errorCode,
          p_error_message: errorMessage,
        }),
      );
    },
  };
}

// The owner's token ---------------------------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export interface OwnerTokenInput {
  readonly userId: string;
  readonly orgId: string;
  readonly automationId: string;
  readonly runId: string;
  readonly signingKey: string;
  readonly issuer: string;
  readonly nowSeconds: number;
}

/** The claims of an owner token: an ordinary session of the owner, bound to the org and marked with the run. */
export function ownerTokenClaims(
  input: Omit<OwnerTokenInput, "signingKey">,
): Record<string, unknown> {
  return {
    iss: input.issuer,
    sub: input.userId,
    aud: "authenticated",
    role: "authenticated",
    iat: input.nowSeconds,
    exp: input.nowSeconds + OWNER_TOKEN_SECONDS,
    org_id: input.orgId,
    is_anonymous: false,
    amr: [{ method: "xos_automation", timestamp: input.nowSeconds }],
    xos_automation_id: input.automationId,
    xos_automation_run_id: input.runId,
  };
}

/** An HS256 JWT acting as the automation's owner for OWNER_TOKEN_SECONDS. */
export async function mintOwnerToken(input: OwnerTokenInput): Promise<string> {
  if (input.signingKey.length < 32) throw new Error("The JWT signing key is too short.");
  const head = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(ownerTokenClaims(input))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(head));
  return `${head}.${base64url(new Uint8Array(signature))}`;
}

// Calling the API ------------------------------------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** A failed step and what can fix it. */
export class StepFailure extends Error {
  constructor(
    readonly kind: Exclude<FinishOutcome, "succeeded">,
    readonly code: string,
    message: string,
    readonly httpStatus: number | null = null,
    readonly response: unknown = null,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

const RETRYABLE = new Set([408, 409, 425, 429]);

/** The failure an API answer means (see the module comment). */
export function failureOf(answer: ApiAnswer): StepFailure {
  const problem = (answer.body ?? {}) as { rule?: unknown; detail?: unknown; title?: unknown };
  const rule = typeof problem.rule === "string" ? problem.rule : null;
  const message =
    typeof problem.detail === "string"
      ? problem.detail
      : typeof problem.title === "string"
        ? problem.title
        : `The API answered ${answer.status}.`;
  const response = summarize(answer.body);
  if (answer.status === 401 || answer.status === 403) {
    return new StepFailure("refused", "owner_access_refused", message, answer.status, response);
  }
  if (RETRYABLE.has(answer.status) || answer.status >= 500) {
    return new StepFailure(
      "retry",
      answer.status === 429 ? "api_rate_limited" : "api_unavailable",
      message,
      answer.status,
      response,
    );
  }
  return new StepFailure(
    "failed",
    (rule ?? `http_${answer.status}`).toLowerCase().replace(/[^a-z0-9_]/g, "_"),
    message,
    answer.status,
    response,
  );
}

const KEPT = [
  "id",
  "record_state",
  "title",
  "comment_thread_id",
  "notification_id",
  "webhook_delivery_id",
  "type",
  "status",
  "detail",
  "rule",
] as const;

/** An API answer trimmed to its identifying fields or the problem it reported, for the ledger. */
export function summarize(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const kept = Object.fromEntries(
    KEPT.filter((k) => k in body).map((k) => [k, (body as Record<string, unknown>)[k]]),
  );
  return Object.keys(kept).length > 0 ? kept : null;
}

interface CallOptions {
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}

type Caller = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  options?: CallOptions,
) => Promise<ApiAnswer>;

function apiCaller(fetcher: FetchLike, baseUrl: string, token: () => Promise<string>): Caller {
  const base = baseUrl.replace(/\/$/, "");
  return async (method, path, options = {}) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await token()}`,
      Accept: "application/json",
      "Accept-Language": "en-US",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new StepFailure(
        "retry",
        "api_unreachable",
        `The API could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const raw = await response.text();
    let body: unknown;
    try {
      body = raw === "" ? null : JSON.parse(raw);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

async function expectSuccess(answer: Promise<ApiAnswer>): Promise<ApiAnswer> {
  const settled = await answer;
  if (settled.status < 200 || settled.status > 299) throw failureOf(settled);
  return settled;
}

// The actions ----------------------------------------------------------------------------------------------------

interface ActionContext {
  readonly run: BegunRun;
  readonly api: Caller;
}

interface StepResult {
  readonly status: Exclude<StepStatus, "Failed">;
  readonly operationId: string;
  readonly request: unknown;
  readonly answer: ApiAnswer;
}

function eventText(event: unknown, ...path: string[]): string | null {
  let current: unknown = event;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current !== "" ? current : null;
}

function subjectRecord(event: unknown): string {
  const id = eventText(event, "subject", "id");
  if (eventText(event, "subject", "table") !== "records" || id === null) {
    throw new StepFailure(
      "failed",
      "automation_subject_not_record",
      "This action works on a record, and the event's subject is not one.",
    );
  }
  return id;
}

function filled(template: string | undefined, event: unknown, limit: number, what: string): string {
  const value = renderField(template ?? "", event, limit);
  if (value === "") {
    throw new StepFailure(
      "failed",
      "automation_text_empty",
      `The ${what} came out empty for this event.`,
    );
  }
  return value;
}

const idempotencyKey = (run: BegunRun, action: BegunAction) =>
  `automation-${run.run_id}-${action.position}`;

async function createTask(action: BegunAction, { run, api }: ActionContext): Promise<StepResult> {
  const projectId = action.project_id ?? eventText(run.event, "project_id");
  if (projectId === null) {
    throw new StepFailure(
      "failed",
      "automation_no_project",
      "The event has no project and the action names none, so there is nowhere to create the Task.",
    );
  }
  const query = new URLSearchParams({
    "filter[project_id][eq]": projectId,
    "filter[parent_id][is_null]": "true",
    fields: "id",
    limit: "1",
  });
  const roots = await expectSuccess(api("GET", `/scope-nodes?${query.toString()}`));
  const root = ((roots.body as { data?: { id?: unknown }[] } | null)?.data ?? [])[0]?.id;
  if (typeof root !== "string") {
    throw new StepFailure(
      "failed",
      "automation_project_unknown",
      "The person this automation runs as cannot see the project, or it has no engagement root.",
      roots.status,
    );
  }
  const body = {
    scope_node_id: root,
    record_kind: "Task",
    title: filled(action.title, run.event, AUTOMATION_LIMITS.title, "Task title"),
    phase_code: action.phase_code,
    xyz: action.xyz,
    external_visibility: [],
    ...(action.due_at ? { due_at: action.due_at } : {}),
  };
  const answer = await expectSuccess(
    api("POST", "/records", { body, idempotencyKey: idempotencyKey(run, action) }),
  );
  return { status: "Succeeded", operationId: "records.create", request: body, answer };
}

async function updateStatus(action: BegunAction, { run, api }: ActionContext): Promise<StepResult> {
  const id = subjectRecord(run.event);
  const current = await expectSuccess(api("GET", `/records/${id}?fields=id,record_state`));
  const state = (current.body as { record_state?: unknown } | null)?.record_state;
  if (state === action.to_state) {
    return {
      status: "Skipped",
      operationId: "records.transition",
      request: { to_state: action.to_state },
      answer: current,
    };
  }
  const note = action.body ? renderField(action.body, run.event, AUTOMATION_LIMITS.body) : null;
  const body = {
    expected_state: state,
    to_state: action.to_state,
    ...(action.to_state === "Blocked" && note ? { blocker_text: note } : {}),
    ...(action.to_state === "Deferred" && note ? { replan_reason: note } : {}),
  };
  const answer = await expectSuccess(
    api("POST", `/records/${id}/transitions`, {
      body,
      idempotencyKey: idempotencyKey(run, action),
    }),
  );
  return { status: "Succeeded", operationId: "records.transition", request: body, answer };
}

async function assign(action: BegunAction, { run, api }: ActionContext): Promise<StepResult> {
  const id = subjectRecord(run.event);
  const body = { owner_party_id: action.assignee_person_id };
  const answer = await expectSuccess(api("PATCH", `/records/${id}`, { body, ifMatch: "*" }));
  return { status: "Succeeded", operationId: "records.update", request: body, answer };
}

async function addComment(action: BegunAction, { run, api }: ActionContext): Promise<StepResult> {
  const table = eventText(run.event, "subject", "table");
  const subjectId = eventText(run.event, "subject", "id");
  if (table === null || subjectId === null) {
    throw new StepFailure(
      "failed",
      "automation_no_subject",
      "The event has no subject to comment on.",
    );
  }
  const body = {
    subject_table: table,
    subject_id: subjectId,
    body: filled(action.body, run.event, AUTOMATION_LIMITS.body, "comment"),
  };
  const answer = await expectSuccess(
    api("POST", "/comments/on-subject", { body, idempotencyKey: idempotencyKey(run, action) }),
  );
  return { status: "Succeeded", operationId: "comments.postOnSubject", request: body, answer };
}

async function notify(action: BegunAction, { run, api }: ActionContext): Promise<StepResult> {
  const message = action.body ? renderField(action.body, run.event, AUTOMATION_LIMITS.body) : "";
  const body = {
    recipient_person_id: action.recipient_person_id,
    title: filled(action.title, run.event, AUTOMATION_LIMITS.title, "notification title"),
    ...(message === "" ? {} : { body: message }),
  };
  const answer = await expectSuccess(
    api("POST", `/automation-runs/${run.run_id}/notices`, {
      body,
      idempotencyKey: idempotencyKey(run, action),
    }),
  );
  return { status: "Succeeded", operationId: "automationRuns.notify", request: body, answer };
}

async function callWebhook(action: BegunAction, { run, api }: ActionContext): Promise<StepResult> {
  const body = { webhook_endpoint_id: action.webhook_endpoint_id };
  const answer = await expectSuccess(
    api("POST", `/automation-runs/${run.run_id}/webhook-deliveries`, {
      body,
      idempotencyKey: idempotencyKey(run, action),
    }),
  );
  return {
    status: "Succeeded",
    operationId: "automationRuns.deliverWebhook",
    request: body,
    answer,
  };
}

const ACTIONS: Readonly<
  Record<string, (action: BegunAction, context: ActionContext) => Promise<StepResult>>
> = {
  create_task: createTask,
  update_status: updateStatus,
  assign,
  add_comment: addComment,
  notify,
  call_webhook: callWebhook,
};

// One pass -------------------------------------------------------------------------------------------------------

export interface AutomationWorkerDeps {
  readonly store: AutomationRunStore;
  readonly fetch: FetchLike;
  /** The public API, such as https://atlas.example/api/v1 (XOS_APP_URL with /api/v1). */
  readonly apiBaseUrl: string;
  readonly signingKey: string;
  /** The JWT issuer, `${SUPABASE_URL}/auth/v1` as api-token signs. */
  readonly issuer: string;
  readonly worker: string;
  readonly limit?: number;
  readonly now?: () => number;
}

export interface AutomationRunResult {
  readonly runId: string;
  readonly outcome: string;
  readonly status: string | null;
  readonly errorCode: string | null;
}

/** Runs one claimed run: its remaining actions in order, then settles it. */
async function runOne(
  deps: AutomationWorkerDeps,
  job: ClaimedAutomationJob,
): Promise<AutomationRunResult> {
  const now = deps.now ?? Date.now;
  const begun = await deps.store.begin(job.runId, job.jobId);
  if (begun.outcome !== "run") {
    return {
      runId: job.runId,
      outcome: begun.outcome,
      status: null,
      errorCode: begun.error_code ?? null,
    };
  }
  const api = apiCaller(deps.fetch, deps.apiBaseUrl, () =>
    mintOwnerToken({
      userId: begun.owner_user_id,
      orgId: begun.org_id,
      automationId: begun.automation_id,
      runId: begun.run_id,
      signingKey: deps.signingKey,
      issuer: deps.issuer,
      nowSeconds: Math.floor(now() / 1000),
    }),
  );
  const done = new Set(begun.completed);
  let failure: StepFailure | null = null;
  for (const action of [...begun.actions].sort((a, b) => a.position - b.position)) {
    if (done.has(action.position)) continue;
    const started = now();
    const step = {
      runId: begun.run_id,
      position: action.position,
      actionId: action.action_id,
      actionType: action.type,
      startedAt: new Date(started).toISOString(),
    };
    try {
      const run = ACTIONS[action.type];
      if (run === undefined) {
        throw new StepFailure(
          "failed",
          "automation_action_unknown",
          `${action.type} is not an action.`,
        );
      }
      const result = await run(action, { run: begun, api });
      await deps.store.recordStep({
        ...step,
        operationId: result.operationId,
        status: result.status,
        request: result.request,
        response: summarize(result.answer.body),
        httpStatus: result.answer.status,
        errorCode: null,
        errorMessage: null,
        durationMs: Math.max(0, Math.round(now() - started)),
      });
    } catch (error) {
      failure =
        error instanceof StepFailure
          ? error
          : new StepFailure(
              "retry",
              "worker_error",
              error instanceof Error ? error.message : String(error),
            );
      await deps.store.recordStep({
        ...step,
        operationId: null,
        status: "Failed",
        request: null,
        response: failure.response,
        httpStatus: failure.httpStatus,
        errorCode: failure.code,
        errorMessage: failure.message.slice(0, 2000),
        durationMs: Math.max(0, Math.round(now() - started)),
      });
      break;
    }
  }
  const status = await deps.store.finish(
    begun.run_id,
    job.jobId,
    failure === null ? "succeeded" : failure.kind,
    failure?.code ?? null,
    failure?.message.slice(0, 2000) ?? null,
  );
  return { runId: begun.run_id, outcome: "run", status, errorCode: failure?.code ?? null };
}

/** One pass of the automation worker: claims up to `limit` jobs (10 by default) and runs each in turn. */
export async function runAutomationJobs(
  deps: AutomationWorkerDeps,
): Promise<AutomationRunResult[]> {
  const jobs = await deps.store.claim(deps.worker, deps.limit ?? 10);
  const results: AutomationRunResult[] = [];
  for (const job of jobs) {
    try {
      results.push(await runOne(deps, job));
    } catch (error) {
      // The ledger could not be written; hand the run back to the queue's backoff if the database still answers.
      const message = error instanceof Error ? error.message : String(error);
      await deps.store
        .finish(job.runId, job.jobId, "retry", "worker_error", message)
        .catch(() => null);
      results.push({ runId: job.runId, outcome: "error", status: null, errorCode: "worker_error" });
    }
  }
  return results;
}
