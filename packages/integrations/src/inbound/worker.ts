import { SYNC_SCOPES, scopesFor, isProviderCode, type SyncScope } from "../framework/catalog.ts";
import { StoreError, unwrap, type DbClient } from "../framework/db.ts";
import { asIntegrationError, IntegrationError } from "../framework/errors.ts";
import { callJson, type HttpClient } from "../framework/http.ts";
import type { JobQueue } from "../framework/runner.ts";
import { parseCredential } from "../framework/support.ts";
import {
  slackFailure,
  unfurlLinks,
  type ChatRequestDeps,
} from "../connectors/communication/index.ts";
import type { InboundKind } from "./handler.ts";

/**
 * The inbound half of the integration worker (A83, finding A65-013): claims integration.inbound jobs and
 * processes one attempt of each recorded webhook. The event owns its attempts and backoff (migration 1400):
 * a retryable failure comes back after private.integration_backoff, and an event that fails for good goes to
 * Dead Letter for an admin. The job itself finishes as succeeded once the outcome is recorded.
 *   * Change Notice: queues a sync run of the scope the provider's notice names, with an idempotency key per
 *     event, so a notice queued twice still syncs once. A run of that scope already on its way is enough.
 *   * Link Unfurl: unfurls the Atlas record links a Slack message named, as the person linked to the Slack
 *     user (row level security decides what they see), through chat.unfurl with the connection's token.
 */

export const INTEGRATION_INBOUND_JOB = "integration.inbound";

export interface InboundEvent {
  readonly id: string;
  readonly connectionId: string;
  readonly providerCode: string;
  readonly kind: InboundKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempt: number;
}

export type EnqueueResult =
  { readonly runId: string } | { readonly refused: string; readonly message: string };

export interface InboundEventStore {
  claim(eventId: string): Promise<InboundEvent>;
  complete(eventId: string, outcome: string): Promise<void>;
  fail(eventId: string, code: string, message: string, retryable: boolean): Promise<string>;
  enqueueSync(
    connectionId: string,
    scope: SyncScope,
    idempotencyKey: string,
  ): Promise<EnqueueResult>;
  credential(connectionId: string): Promise<string>;
}

export interface InboundWorkerOptions {
  readonly queue: JobQueue;
  readonly events: InboundEventStore;
  readonly chat: ChatRequestDeps;
  readonly http: HttpClient;
  /** Origin of Atlas, whose record links are unfurled (XOS_APP_URL). */
  readonly atlasOrigin: string;
  readonly worker: string;
  readonly limit?: number;
}

export type InboundOutcome =
  | { readonly eventId: string; readonly result: "processed"; readonly outcome: string }
  | { readonly eventId: string; readonly result: "retrying" | "dead letter"; readonly code: string }
  | { readonly eventId: string; readonly result: "skipped"; readonly reason: string };

/** Direction of the sync a change notice queues. */
function directionOf(scope: SyncScope): "Inbound" | "Two Way" {
  return scope === "Calendar Sync" ? "Two Way" : "Inbound";
}

async function changeNotice(event: InboundEvent, options: InboundWorkerOptions): Promise<string> {
  const scope = event.payload["scope"];
  if (
    typeof scope !== "string" ||
    !(SYNC_SCOPES as readonly string[]).includes(scope) ||
    !isProviderCode(event.providerCode) ||
    !scopesFor(event.providerCode).includes(scope as SyncScope)
  ) {
    throw new IntegrationError(
      "inbound_scope_unknown",
      `The notice names no sync scope ${event.providerCode} runs.`,
    );
  }
  const result = await options.events.enqueueSync(
    event.connectionId,
    scope as SyncScope,
    `inbound:${event.id}`,
  );
  if ("runId" in result) return `Queued ${scope} run ${result.runId}.`;
  if (result.refused === "integration_sync_in_progress") {
    return `A ${scope} run was already on its way; it picks up this change.`;
  }
  if (result.refused === "integration_not_connected") {
    return "The connection is not Connected, so no sync was queued.";
  }
  throw new IntegrationError(result.refused, result.message);
}

async function linkUnfurl(event: InboundEvent, options: InboundWorkerOptions): Promise<string> {
  const p = event.payload;
  const text = (key: string) => (typeof p[key] === "string" ? (p[key] as string) : null);
  const urls = Array.isArray(p["links"])
    ? p["links"].filter((u): u is string => typeof u === "string")
    : [];
  const team = text("team_id");
  const user = text("user");
  if (team === null || user === null || urls.length === 0) return "No record links to unfurl.";
  const unfurls = await unfurlLinks(
    { provider: "slack", externalAccountId: team, externalUserId: user, urls },
    options.atlasOrigin,
    options.chat,
  );
  const entries = Object.entries(unfurls);
  if (entries.length === 0) return "No link named a record the person can see.";
  const credential = parseCredential(await options.events.credential(event.connectionId));
  const target =
    text("unfurl_id") !== null && text("source") !== null
      ? { unfurl_id: text("unfurl_id"), source: text("source") }
      : { channel: text("channel"), ts: text("message_ts") };
  const response = await callJson<{ ok: boolean; error?: string }>(options.http, "Slack", {
    method: "POST",
    url: "https://slack.com/api/chat.unfurl",
    token: credential.token,
    json: { ...target, unfurls: Object.fromEntries(entries.map(([url, t]) => [url, { text: t }])) },
  });
  if (!response.ok) throw slackFailure(response.error ?? "unknown_error");
  return `Unfurled ${entries.length} record link${entries.length === 1 ? "" : "s"}.`;
}

async function processOne(eventId: string, options: InboundWorkerOptions): Promise<InboundOutcome> {
  let event: InboundEvent;
  try {
    event = await options.events.claim(eventId);
  } catch (error) {
    // Already processed, not due, or sent back by an admin and claimed elsewhere: nothing to do.
    if (error instanceof StoreError && error.error.kind === "refusal") {
      return { eventId, result: "skipped", reason: error.error.rule };
    }
    throw error;
  }
  let outcome: string;
  try {
    outcome =
      event.kind === "Change Notice"
        ? await changeNotice(event, options)
        : await linkUnfurl(event, options);
  } catch (error) {
    const failure = asIntegrationError(error);
    const state = await options.events.fail(
      event.id,
      failure.code,
      failure.message,
      failure.retryable,
    );
    return {
      eventId,
      result: state === "Retrying" ? "retrying" : "dead letter",
      code: failure.code,
    };
  }
  await options.events.complete(event.id, outcome);
  return { eventId, result: "processed", outcome };
}

/** One pass: claims ready integration.inbound jobs and processes one attempt of each event. */
export async function runInboundEvents(
  options: InboundWorkerOptions,
): Promise<readonly InboundOutcome[]> {
  const jobs = await options.queue.claim(
    options.worker,
    INTEGRATION_INBOUND_JOB,
    options.limit ?? 25,
  );
  const outcomes: InboundOutcome[] = [];
  for (const job of jobs) {
    try {
      outcomes.push(await processOne(job.subjectId, options));
      await options.queue.finish(job.id, true, null);
    } catch (error) {
      // Recording the outcome failed (database unreachable): the job keeps the error and comes back.
      await options.queue.finish(
        job.id,
        false,
        error instanceof Error ? error.message : String(error),
      );
      outcomes.push({ eventId: job.subjectId, result: "skipped", reason: "runner_error" });
    }
  }
  return outcomes;
}

interface EventRow {
  id: string;
  integration_connection_id: string;
  provider_code: string;
  inbound_kind: InboundKind;
  payload: Record<string, unknown> | null;
  attempt: number;
}

/** The event store over the service-role client (migration 1400 and the enqueue RPC of 0600). */
export function supabaseInboundEventStore(db: DbClient): InboundEventStore {
  return {
    async claim(eventId) {
      const row = await unwrap<EventRow>(
        db.rpc("claim_integration_inbound_event", { p_event_id: eventId }),
      );
      return {
        id: row.id,
        connectionId: row.integration_connection_id,
        providerCode: row.provider_code,
        kind: row.inbound_kind,
        payload: row.payload ?? {},
        attempt: row.attempt,
      };
    },
    async complete(eventId, outcome) {
      await unwrap(
        db.rpc("complete_integration_inbound_event", { p_event_id: eventId, p_outcome: outcome }),
      );
    },
    async fail(eventId, code, message, retryable) {
      return unwrap<string>(
        db.rpc("fail_integration_inbound_event", {
          p_event_id: eventId,
          p_error_code: code,
          p_error_message: message,
          p_retryable: retryable,
        }),
      );
    },
    async enqueueSync(connectionId, scope, idempotencyKey) {
      try {
        const runId = await unwrap<string>(
          db.rpc("enqueue_integration_sync", {
            p_connection_id: connectionId,
            p_scope: scope,
            p_direction: directionOf(scope),
            p_idempotency_key: idempotencyKey,
          }),
        );
        return { runId };
      } catch (error) {
        if (error instanceof StoreError && error.error.kind === "refusal") {
          return { refused: error.error.rule, message: error.error.message };
        }
        throw error;
      }
    },
    async credential(connectionId) {
      return unwrap<string>(
        db.rpc("read_integration_credential", { p_connection_id: connectionId }),
      );
    },
  };
}
