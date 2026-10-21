import type { XosClient } from "./client.ts";
import type { Database } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Webhooks in Settings (A86, RRR-131, finding A65-004; Section 4.5.6 org settings item 34, Section 10.1):
 * endpoints with the events they subscribe to, recent signed deliveries and replay (migration 0510). Creating
 * an endpoint returns its signing secret once. Everything needs org.webhooks.manage, which row level security
 * and the RPCs check.
 */

export type DeliveryStatus = Database["app"]["Enums"]["delivery_status"];

export interface EventType {
  readonly code: string;
  readonly subject: string;
  readonly description: string;
}

/** The domain events an endpoint may subscribe to, by code. */
export async function listEventTypes(db: XosClient): Promise<Result<EventType[]>> {
  const { data, error } = await db
    .from("domain_event_catalog")
    .select("code, subject, description")
    .order("code");
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      r.code ? [{ code: r.code, subject: r.subject ?? "", description: r.description ?? "" }] : [],
    ),
  );
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly description: string | null;
  readonly disabledAt: string | null;
  readonly events: readonly string[];
}

export async function listWebhookEndpoints(
  db: XosClient,
  orgId: string,
): Promise<Result<WebhookEndpoint[]>> {
  const { data, error } = await db
    .from("webhook_endpoints")
    .select("id, url, description, disabled_at, webhook_endpoint_events(event_type, deleted_at)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      url: r.url,
      description: r.description,
      disabledAt: r.disabled_at,
      events: (r.webhook_endpoint_events ?? [])
        .filter((e) => e.deleted_at === null)
        .map((e) => e.event_type)
        .sort(),
    })),
  );
}

export interface WebhookEndpointInput {
  readonly orgId: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly description: string | null;
}

/** Creates an endpoint; the signing secret (`whsec_` and 64 hex digits) comes back once. */
export async function createWebhookEndpoint(
  db: XosClient,
  input: WebhookEndpointInput,
): Promise<Result<{ readonly id: string; readonly secret: string }>> {
  const { data, error } = await db.rpc("create_webhook_endpoint", {
    p_org_id: input.orgId,
    p_url: input.url,
    p_event_types: [...input.events],
    ...(input.description === null ? {} : { p_description: input.description }),
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "unexpected", message: "create_webhook_endpoint returned no row" });
  return ok({ id: row.webhook_endpoint_id, secret: row.signing_secret });
}

/** Pauses (or resumes) deliveries to an endpoint. */
export async function setWebhookEndpointDisabled(
  db: XosClient,
  endpointId: string,
  disabled: boolean,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("webhook_endpoints")
    .update({ disabled_at: disabled ? new Date().toISOString() : null })
    .eq("id", endpointId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

/** Removes an endpoint: no further deliveries; its delivery history stays. */
export async function removeWebhookEndpoint(
  db: XosClient,
  endpointId: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("webhook_endpoints")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", endpointId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

export interface WebhookDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly lastResponseStatus: number | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly replay: boolean;
}

/** The org's most recent deliveries across its endpoints, newest first. */
export async function listWebhookDeliveries(
  db: XosClient,
  orgId: string,
  limit = 20,
): Promise<Result<WebhookDelivery[]>> {
  const { data, error } = await db
    .from("webhook_deliveries")
    .select(
      "id, webhook_endpoint_id, delivery_status, attempt_count, last_response_status, last_error, created_at, delivered_at, replay_requested_by",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      endpointId: r.webhook_endpoint_id,
      status: r.delivery_status,
      attempts: r.attempt_count,
      lastResponseStatus: r.last_response_status,
      lastError: r.last_error,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at,
      replay: r.replay_requested_by !== null,
    })),
  );
}

/** Sends a delivery again as a new delivery; returns the new delivery's id. */
export async function replayWebhookDelivery(
  db: XosClient,
  deliveryId: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("replay_webhook_delivery", { p_delivery_id: deliveryId });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}
