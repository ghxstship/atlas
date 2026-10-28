import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import type { Database } from "./database.types.ts";
import * as enums from "./enums.generated.ts";

/**
 * Automations (A91, ADR 0047; migrations 1480 and 1481; Section 4.5.6 item 20): what Settings, Automations reads and
 * writes with the viewer's client, so row level security and the RPCs decide. Definitions travel as the JSON documents
 * of @xos/schemas/automations; app.save_automation validates them and stores them as rows. Runs and steps are the
 * ledger the engine writes; they are only read here.
 */

export interface AutomationSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly triggerEventType: string;
  readonly enabled: boolean;
  readonly pausedAt: string | null;
  readonly pauseReason: string | null;
  readonly ownerPersonId: string;
  readonly ownerName: string | null;
  readonly updatedAt: string;
  readonly lastRun: { readonly status: AutomationRunStatus; readonly at: string } | null;
}

export interface AutomationDefinitionDoc {
  /** {"all": [...]} or {"any": [...]}, as @xos/schemas AutomationConditions. */
  readonly conditions: unknown;
  /** The actions in run order, as @xos/schemas AutomationActions. */
  readonly actions: unknown;
}

export interface AutomationInput {
  readonly orgId: string;
  /** Null to create. */
  readonly id: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly triggerEventType: string;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly enabled: boolean;
  /** The version the editor opened (updated_at), compared before a change (automation_changed). */
  readonly expectedUpdatedAt?: string | null | undefined;
}

export const AUTOMATION_RUN_STATUSES = enums.automationRunStatus;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export interface AutomationRunRow {
  readonly id: string;
  readonly automationId: string;
  readonly automationName: string | null;
  readonly status: AutomationRunStatus;
  readonly eventType: string;
  readonly depth: number;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  /** The event the run started from, as webhooks send it. */
  readonly event: unknown;
}

export interface AutomationStepRow {
  readonly position: number;
  readonly actionType: string;
  readonly operationId: string | null;
  readonly status: Database["app"]["Enums"]["automation_step_status"];
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly durationMs: number;
  readonly request: unknown;
  readonly response: unknown;
}

export interface AutomationTestResult {
  readonly matched: boolean;
  readonly conditions: readonly {
    readonly field: string;
    readonly operator: string;
    readonly value: string | null;
    readonly actual: unknown;
    readonly matched: boolean;
  }[];
}

export interface EventTypeOption {
  readonly code: string;
  readonly subject: string;
  readonly description: string;
}

export interface WebhookEndpointOption {
  readonly id: string;
  readonly url: string;
  readonly description: string | null;
}

function isRunStatus(value: unknown): value is AutomationRunStatus {
  return (AUTOMATION_RUN_STATUSES as readonly unknown[]).includes(value);
}

/** The org's automations by name, each with its latest run. */
export async function listAutomations(
  db: XosClient,
  orgId: string,
): Promise<Result<AutomationSummary[]>> {
  const { data, error } = await db
    .from("automations")
    .select(
      "id, name, description, trigger_event_type, enabled, paused_at, pause_reason, owner_person_id, updated_at, owner:people!automations_owner_person_id_fkey(full_name)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  const ids = data.map((a) => a.id);
  const latest = new Map<string, { status: AutomationRunStatus; at: string }>();
  if (ids.length > 0) {
    const runs = await db
      .from("automation_runs")
      .select("automation_id, run_status, created_at")
      .in("automation_id", ids)
      .order("created_at", { ascending: false })
      .limit(Math.max(50, ids.length * 5));
    if (runs.error) return fail(toDataError(runs.error));
    for (const r of runs.data) {
      if (!latest.has(r.automation_id) && isRunStatus(r.run_status)) {
        latest.set(r.automation_id, { status: r.run_status, at: r.created_at });
      }
    }
  }
  return ok(
    data.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      triggerEventType: a.trigger_event_type,
      enabled: a.enabled,
      pausedAt: a.paused_at,
      pauseReason: a.pause_reason,
      ownerPersonId: a.owner_person_id,
      ownerName: a.owner?.full_name ?? null,
      updatedAt: a.updated_at,
      lastRun: latest.get(a.id) ?? null,
    })),
  );
}

/** An automation's conditions and actions documents (app.automation_definition). */
export async function getAutomationDefinition(
  db: XosClient,
  automationId: string,
): Promise<Result<AutomationDefinitionDoc>> {
  const { data, error } = await db.rpc("automation_definition", { p_automation_id: automationId });
  if (error) return fail(toDataError(error));
  const doc = (data ?? {}) as { conditions?: unknown; actions?: unknown };
  return ok({ conditions: doc.conditions ?? { all: [] }, actions: doc.actions ?? [] });
}

/** Creates or changes an automation (app.save_automation); returns its id. */
export async function saveAutomation(
  db: XosClient,
  input: AutomationInput,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("save_automation", {
    p_org_id: input.orgId,
    p_automation_id: input.id as string,
    p_name: input.name,
    p_description: input.description ?? "",
    p_trigger_event_type: input.triggerEventType,
    p_conditions: input.conditions as never,
    p_actions: input.actions as never,
    p_enabled: input.enabled,
    ...(input.expectedUpdatedAt ? { p_expected_updated_at: input.expectedUpdatedAt } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Turns an automation on (the caller becomes its owner) or off. */
export async function setAutomationEnabled(
  db: XosClient,
  automationId: string,
  enabled: boolean,
): Promise<Result<void>> {
  const { error } = await db.rpc("set_automation_enabled", {
    p_automation_id: automationId,
    p_enabled: enabled,
  });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

/** Deletes an automation; its run history stays. */
export async function deleteAutomation(db: XosClient, automationId: string): Promise<Result<void>> {
  const { error } = await db.rpc("delete_automation", { p_automation_id: automationId });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

/** Dry run of a saved automation's conditions against a sample event (no side effects). */
export async function testAutomation(
  db: XosClient,
  automationId: string,
  event: unknown,
): Promise<Result<AutomationTestResult>> {
  const { data, error } = await db.rpc("test_automation", {
    p_automation_id: automationId,
    p_event: event as never,
  });
  if (error) return fail(toDataError(error));
  return ok(data as unknown as AutomationTestResult);
}

/** The org's latest event of a type as webhooks send it, or an empty body naming the subject. */
export async function sampleAutomationEvent(
  db: XosClient,
  orgId: string,
  eventType: string,
): Promise<Result<unknown>> {
  const { data, error } = await db.rpc("sample_automation_event", {
    p_org_id: orgId,
    p_event_type: eventType,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Runs newest first, for one automation, one run or the whole org; `before` pages back by creation time. */
export async function listAutomationRuns(
  db: XosClient,
  orgId: string,
  options: {
    readonly automationId?: string | undefined;
    readonly runId?: string | undefined;
    readonly limit?: number;
    readonly before?: string | undefined;
  } = {},
): Promise<Result<AutomationRunRow[]>> {
  let query = db
    .from("automation_runs")
    .select(
      "id, automation_id, run_status, depth, attempts, error_code, error_message, created_at, started_at, finished_at, duration_ms, event_payload, automation:automations!automation_runs_automation_id_fkey(name)",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 25, 1), 100));
  if (options.automationId) query = query.eq("automation_id", options.automationId);
  if (options.runId) query = query.eq("id", options.runId);
  if (options.before) query = query.lt("created_at", options.before);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      isRunStatus(r.run_status)
        ? [
            {
              id: r.id,
              automationId: r.automation_id,
              automationName: r.automation?.name ?? null,
              status: r.run_status,
              eventType: String((r.event_payload as { type?: unknown } | null)?.type ?? ""),
              depth: r.depth,
              attempts: r.attempts,
              errorCode: r.error_code,
              errorMessage: r.error_message,
              createdAt: r.created_at,
              startedAt: r.started_at,
              finishedAt: r.finished_at,
              durationMs: r.duration_ms,
              event: r.event_payload,
            },
          ]
        : [],
    ),
  );
}

/** The steps of one run in action order. */
export async function listAutomationRunSteps(
  db: XosClient,
  runId: string,
): Promise<Result<AutomationStepRow[]>> {
  const { data, error } = await db
    .from("automation_run_steps")
    .select(
      "position, action_type, operation_id, step_status, http_status, error_code, error_message, duration_ms, request_body, response_body",
    )
    .eq("automation_run_id", runId)
    .order("position");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((s) => ({
      position: s.position,
      actionType: s.action_type,
      operationId: s.operation_id,
      status: s.step_status,
      httpStatus: s.http_status,
      errorCode: s.error_code,
      errorMessage: s.error_message,
      durationMs: s.duration_ms,
      request: s.request_body,
      response: s.response_body,
    })),
  );
}

/** Queues a failed run again from its failed step. */
export async function retryAutomationRun(db: XosClient, runId: string): Promise<Result<void>> {
  const { error } = await db.rpc("retry_automation_run", { p_run_id: runId });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

/** The event catalog automations trigger on: the same list webhooks subscribe to (app.domain_event_catalog). */
export async function listAutomationEventTypes(db: XosClient): Promise<Result<EventTypeOption[]>> {
  const { data, error } = await db
    .from("domain_event_catalog")
    .select("code, subject, description")
    .order("code");
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((e) =>
      e.code && e.subject && e.description
        ? [{ code: e.code, subject: e.subject, description: e.description }]
        : [],
    ),
  );
}

/** The org's live webhook endpoints a call_webhook action may name (readable with org.webhooks.manage). */
export async function listWebhookEndpointOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<WebhookEndpointOption[]>> {
  const { data, error } = await db
    .from("webhook_endpoints")
    .select("id, url, description")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("disabled_at", null)
    .order("url");
  if (error) return fail(toDataError(error));
  return ok(data.map((w) => ({ id: w.id, url: w.url, description: w.description })));
}
