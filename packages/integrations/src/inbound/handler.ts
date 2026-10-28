import type { ProviderCode, SyncScope } from "../framework/catalog.ts";
import { unwrap, type DbClient } from "../framework/db.ts";
import { sha256Hex } from "../framework/support.ts";
import {
  handleSlashCommand,
  verifySlackRequest,
  verifyTeamsRequest,
  type ChatRequestDeps,
} from "../connectors/communication/index.ts";
import { verifyQuickBooksSignature, verifySharedToken, verifyXeroSignature } from "./verify.ts";
import type { Database } from "@xos/data/database.types";

/**
 * The inbound webhook endpoint (the integration-inbound Edge Function; A83, finding A65-013). It answers
 * the providers that push to XOS, always verifying the signature on the raw body first:
 *
 *   POST /integration-inbound/slack/events             Slack Events API: URL check and link_shared unfurls
 *   POST /integration-inbound/slack/commands           Slack slash commands, answered at once
 *   POST /integration-inbound/microsoft_teams/{id}     Teams outgoing webhook, answered at once
 *   POST /integration-inbound/xero                     Xero change notices (app webhook key)
 *   POST /integration-inbound/quickbooks_online        QuickBooks Online change notices (app verifier token)
 *   POST /integration-inbound/google_calendar/{id}     Google Calendar push notifications (channel token)
 *   POST /integration-inbound/microsoft_365/{id}       Microsoft Graph change notifications (client state)
 *
 * Work that can wait (an unfurl, a change notice) is recorded once per provider event in
 * app.integration_inbound_events (idempotency) and answered at once; the integration worker processes it
 * with retries, backoff and a dead letter state (worker.ts). Slash commands and Teams messages must be
 * answered in the request, as the person linked to the chat user, under row level security.
 */

export type InboundKind = Database["app"]["Enums"]["integration_inbound_kind"];

export interface InboundConnection {
  readonly id: string;
  readonly providerCode: string;
  readonly externalAccountId: string | null;
  readonly state: string;
}

/** What the endpoint needs from the database (service role); supabaseInboundStore implements it. */
export interface InboundStore {
  findConnection(provider: ProviderCode, externalAccountId: string): Promise<string | null>;
  connection(connectionId: string): Promise<InboundConnection | null>;
  inboundSecret(connectionId: string): Promise<string | null>;
  record(
    connectionId: string,
    kind: InboundKind,
    idempotencyKey: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly eventId: string; readonly duplicate: boolean }>;
}

/** App-wide signing secrets, set as Edge Function secrets; an endpoint whose secret is unset answers 503. */
export interface InboundSecrets {
  readonly slackSigningSecret?: string | undefined;
  readonly xeroWebhookKey?: string | undefined;
  readonly quickbooksVerifierToken?: string | undefined;
}

export interface InboundDeps {
  readonly store: InboundStore;
  readonly secrets: InboundSecrets;
  /** Chat lookups and a client acting as the linked person, for slash commands and Teams messages. */
  readonly chat: ChatRequestDeps;
  readonly now?: () => Date;
}

/** Bodies above this are refused before they are read in full (providers send far less). */
export const INBOUND_MAX_BYTES = 256 * 1024;
const MAX_LINKS = 20;
const MAX_CHANGES = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(status: number, title: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title, status }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const accepted = (status = 200) => new Response(null, { status });

/** The path after the function name, for example ["slack", "events"]. */
export function inboundRoute(url: string): string[] {
  const parts = new URL(url).pathname.split("/").filter((p) => p.length > 0);
  const at = parts.indexOf("integration-inbound");
  return at < 0 ? [] : parts.slice(at + 1);
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > INBOUND_MAX_BYTES) return null;
  const body = await request.text();
  return new TextEncoder().encode(body).byteLength > INBOUND_MAX_BYTES ? null : body;
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null; // Not JSON: the caller answers 400.
  }
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Answers one inbound request. Never throws for a bad request; a store failure becomes a 503 so the provider retries. */
export async function handleInboundRequest(request: Request, deps: InboundDeps): Promise<Response> {
  const [provider, segment, ...rest] = inboundRoute(request.url);
  if (provider === undefined || rest.length > 0) return problem(404, "Not Found");
  const isValidation =
    provider === "microsoft_365" && new URL(request.url).searchParams.has("validationToken");
  if (request.method !== "POST" && !isValidation) return problem(405, "Method Not Allowed");
  const body = await readBody(request);
  if (body === null) return problem(413, "Payload Too Large");
  try {
    switch (provider) {
      case "slack":
        if (segment === "events") return await slackEvents(request, body, deps);
        if (segment === "commands") return await slackCommand(request, body, deps);
        return problem(404, "Not Found");
      case "microsoft_teams":
        return await teamsMessage(request, body, segment, deps);
      case "xero":
        return segment === undefined
          ? await xeroNotice(request, body, deps)
          : problem(404, "Not Found");
      case "quickbooks_online":
        return segment === undefined
          ? await quickBooksNotice(request, body, deps)
          : problem(404, "Not Found");
      case "google_calendar":
        return await googleCalendarNotice(request, segment, deps);
      case "microsoft_365":
        return await graphNotice(request, body, segment, deps);
      default:
        return problem(404, "Not Found");
    }
  } catch {
    // The database could not record the event: answer 503 so the provider delivers it again.
    return problem(503, "Service Unavailable");
  }
}

// Slack --------------------------------------------------------------------------------------------------------

function slackVerified(request: Request, body: string, deps: InboundDeps): boolean | null {
  const secret = deps.secrets.slackSigningSecret;
  if (!secret) return null;
  return verifySlackRequest(
    secret,
    request.headers.get("x-slack-request-timestamp") ?? "",
    request.headers.get("x-slack-signature") ?? "",
    body,
    (deps.now ?? (() => new Date()))(),
  );
}

async function slackEvents(request: Request, body: string, deps: InboundDeps): Promise<Response> {
  const verified = slackVerified(request, body, deps);
  if (verified === null) return problem(503, "Service Unavailable");
  if (!verified) return problem(401, "Unauthorized");
  const envelope = parseJson(body);
  if (envelope === null) return problem(400, "Bad Request");
  if (envelope["type"] === "url_verification") {
    return json(200, { challenge: str(envelope["challenge"]) ?? "" });
  }
  const event = envelope["event"] as Record<string, unknown> | undefined;
  const eventId = str(envelope["event_id"]);
  const teamId = str(envelope["team_id"]);
  if (
    envelope["type"] !== "event_callback" ||
    event?.["type"] !== "link_shared" ||
    !eventId ||
    !teamId
  ) {
    return accepted(); // Events XOS does not subscribe to are acknowledged and dropped.
  }
  const connectionId = await deps.store.findConnection("slack", teamId);
  if (connectionId === null) return accepted(); // A workspace without a Connected connection.
  const links = list(event["links"])
    .map((l) => str((l as Record<string, unknown> | null)?.["url"]))
    .filter((u): u is string => u !== null && u.length <= 2000)
    .slice(0, MAX_LINKS);
  await deps.store.record(connectionId, "Link Unfurl", eventId.slice(0, 200), {
    team_id: teamId,
    user: str(event["user"]),
    channel: str(event["channel"]),
    message_ts: str(event["message_ts"]),
    unfurl_id: str(event["unfurl_id"]),
    source: str(event["source"]),
    links,
  });
  return accepted();
}

async function slackCommand(request: Request, body: string, deps: InboundDeps): Promise<Response> {
  const verified = slackVerified(request, body, deps);
  if (verified === null) return problem(503, "Service Unavailable");
  if (!verified) return problem(401, "Unauthorized");
  const form = new URLSearchParams(body);
  const teamId = form.get("team_id");
  const userId = form.get("user_id");
  if (!teamId || !userId) return problem(400, "Bad Request");
  const text = await handleSlashCommand(
    {
      provider: "slack",
      externalAccountId: teamId,
      externalUserId: userId,
      text: form.get("text") ?? "",
    },
    deps.chat,
  );
  return json(200, { response_type: "ephemeral", text });
}

// Microsoft Teams ----------------------------------------------------------------------------------------------------

/** A connection of the named provider, by the id in the endpoint path, that is not disconnected. */
async function pathConnection(
  segment: string | undefined,
  provider: ProviderCode,
  deps: InboundDeps,
): Promise<InboundConnection | null> {
  if (segment === undefined || !UUID.test(segment)) return null;
  const connection = await deps.store.connection(segment);
  return connection !== null &&
    connection.providerCode === provider &&
    connection.state !== "Disconnected"
    ? connection
    : null;
}

/** The message text with the bot's @mention removed. */
export function teamsCommandText(html: string): string {
  return html
    .replace(/<at>[^<]*<\/at>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function teamsMessage(
  request: Request,
  body: string,
  segment: string | undefined,
  deps: InboundDeps,
): Promise<Response> {
  const connection = await pathConnection(segment, "microsoft_teams", deps);
  if (connection === null) return problem(404, "Not Found");
  const secret = await deps.store.inboundSecret(connection.id);
  if (secret === null) return problem(503, "Service Unavailable");
  if (!verifyTeamsRequest(secret, request.headers.get("authorization") ?? "", body)) {
    return problem(401, "Unauthorized");
  }
  const activity = parseJson(body);
  const from = activity?.["from"] as Record<string, unknown> | undefined;
  const userId = str(from?.["aadObjectId"]) ?? str(from?.["id"]);
  if (activity === null || userId === null || connection.externalAccountId === null) {
    return problem(400, "Bad Request");
  }
  const text = await handleSlashCommand(
    {
      provider: "microsoft_teams",
      externalAccountId: connection.externalAccountId,
      externalUserId: userId,
      text: teamsCommandText(str(activity["text"]) ?? ""),
    },
    deps.chat,
  );
  return json(200, { type: "message", text });
}

// Change notices ------------------------------------------------------------------------------------------------------

/** The sync scope a provider's change notice queues. */
export const NOTICE_SCOPE: Readonly<Partial<Record<ProviderCode, SyncScope>>> = {
  xero: "Payment Sync",
  quickbooks_online: "Payment Sync",
  google_calendar: "Calendar Sync",
  microsoft_365: "Calendar Sync",
};

async function xeroNotice(request: Request, body: string, deps: InboundDeps): Promise<Response> {
  const key = deps.secrets.xeroWebhookKey;
  if (!key) return problem(503, "Service Unavailable");
  // Xero's intent-to-receive check expects exactly 401 for a bad signature and 200 for a good one.
  if (!verifyXeroSignature(key, request.headers.get("x-xero-signature") ?? "", body)) {
    return accepted(401);
  }
  const payload = parseJson(body);
  if (payload === null) return problem(400, "Bad Request");
  const byTenant = new Map<string, Record<string, unknown>[]>();
  for (const raw of list(payload["events"])) {
    const event = raw as Record<string, unknown> | null;
    const tenant = str(event?.["tenantId"]);
    if (event && tenant) byTenant.set(tenant, [...(byTenant.get(tenant) ?? []), event]);
  }
  const digest = sha256Hex(body);
  for (const [tenant, events] of byTenant) {
    const connectionId = await deps.store.findConnection("xero", tenant);
    if (connectionId === null) continue;
    await deps.store.record(connectionId, "Change Notice", `xero:${digest}`, {
      scope: NOTICE_SCOPE.xero,
      changes: events.slice(0, MAX_CHANGES).map((e) => ({
        category: str(e["eventCategory"]),
        type: str(e["eventType"]),
        resource_id: str(e["resourceId"]),
      })),
    });
  }
  return accepted();
}

async function quickBooksNotice(
  request: Request,
  body: string,
  deps: InboundDeps,
): Promise<Response> {
  const token = deps.secrets.quickbooksVerifierToken;
  if (!token) return problem(503, "Service Unavailable");
  if (!verifyQuickBooksSignature(token, request.headers.get("intuit-signature") ?? "", body)) {
    return problem(401, "Unauthorized");
  }
  const payload = parseJson(body);
  if (payload === null) return problem(400, "Bad Request");
  const digest = sha256Hex(body);
  for (const raw of list(payload["eventNotifications"])) {
    const notice = raw as Record<string, unknown> | null;
    const realm = str(notice?.["realmId"]);
    if (!notice || !realm) continue;
    const connectionId = await deps.store.findConnection("quickbooks_online", realm);
    if (connectionId === null) continue;
    const entities = list(
      (notice["dataChangeEvent"] as Record<string, unknown> | undefined)?.["entities"],
    );
    await deps.store.record(connectionId, "Change Notice", `qbo:${realm}:${digest}`.slice(0, 200), {
      scope: NOTICE_SCOPE.quickbooks_online,
      changes: entities.slice(0, MAX_CHANGES).map((raw) => {
        const e = raw as Record<string, unknown>;
        return { category: str(e["name"]), type: str(e["operation"]), resource_id: str(e["id"]) };
      }),
    });
  }
  return accepted();
}

async function googleCalendarNotice(
  request: Request,
  segment: string | undefined,
  deps: InboundDeps,
): Promise<Response> {
  const connection = await pathConnection(segment, "google_calendar", deps);
  if (connection === null) return problem(404, "Not Found");
  const secret = await deps.store.inboundSecret(connection.id);
  if (!verifySharedToken(secret, request.headers.get("x-goog-channel-token"))) {
    return problem(401, "Unauthorized");
  }
  const state = request.headers.get("x-goog-resource-state");
  const channel = request.headers.get("x-goog-channel-id");
  const message = request.headers.get("x-goog-message-number");
  // "sync" only confirms a new channel; nothing changed yet.
  if (state === "sync" || !channel || !message) return accepted();
  await deps.store.record(
    connection.id,
    "Change Notice",
    `gcal:${channel}:${message}`.slice(0, 200),
    {
      scope: NOTICE_SCOPE.google_calendar,
      changes: [
        {
          category: "calendar",
          type: state,
          resource_id: request.headers.get("x-goog-resource-id"),
        },
      ],
    },
  );
  return accepted();
}

async function graphNotice(
  request: Request,
  body: string,
  segment: string | undefined,
  deps: InboundDeps,
): Promise<Response> {
  const connection = await pathConnection(segment, "microsoft_365", deps);
  if (connection === null) return problem(404, "Not Found");
  const validation = new URL(request.url).searchParams.get("validationToken");
  if (validation !== null) {
    // Graph checks a new subscription by asking for its token back as plain text within 10 seconds.
    if (validation.length === 0 || validation.length > 1024) return problem(400, "Bad Request");
    return new Response(validation, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  const secret = await deps.store.inboundSecret(connection.id);
  const payload = parseJson(body);
  if (payload === null) return problem(400, "Bad Request");
  const notices = list(payload["value"]).map((v) => v as Record<string, unknown>);
  if (notices.length === 0) return problem(400, "Bad Request");
  if (!notices.every((n) => verifySharedToken(secret, str(n["clientState"])))) {
    return problem(401, "Unauthorized");
  }
  await deps.store.record(connection.id, "Change Notice", `graph:${sha256Hex(body)}`, {
    scope: NOTICE_SCOPE.microsoft_365,
    changes: notices.slice(0, MAX_CHANGES).map((n) => ({
      category: "calendar",
      type: str(n["changeType"]),
      resource_id: str((n["resourceData"] as Record<string, unknown> | undefined)?.["id"]),
    })),
  });
  return accepted(202);
}

// Store ------------------------------------------------------------------------------------------------------------------

/** The inbound store over the service-role client (the RPCs of migration 1400). */
export function supabaseInboundStore(db: DbClient): InboundStore {
  return {
    async findConnection(provider, externalAccountId) {
      return unwrap<string | null>(
        db.rpc("find_integration_connection", {
          p_provider_code: provider,
          p_external_account_id: externalAccountId,
        }),
      );
    },
    async connection(connectionId) {
      const row = await unwrap<{
        id: string;
        provider_code: string;
        external_account_id: string | null;
        connection_state: string;
      } | null>(
        db
          .from("integration_connections")
          .select("id, provider_code, external_account_id, connection_state")
          .eq("id", connectionId)
          .is("deleted_at", null)
          .maybeSingle(),
      );
      return row === null
        ? null
        : {
            id: row.id,
            providerCode: row.provider_code,
            externalAccountId: row.external_account_id,
            state: row.connection_state,
          };
    },
    async inboundSecret(connectionId) {
      return unwrap<string | null>(
        db.rpc("read_integration_inbound_secret", { p_connection_id: connectionId }),
      );
    },
    async record(connectionId, kind, idempotencyKey, payload) {
      const rows = await unwrap<{ event_id: string; duplicate: boolean }[]>(
        db.rpc("record_integration_inbound_event", {
          p_connection_id: connectionId,
          p_kind: kind,
          p_idempotency_key: idempotencyKey,
          p_payload: payload,
        }),
      );
      const row = rows[0];
      if (row === undefined) throw new Error("record_integration_inbound_event returned nothing.");
      return { eventId: row.event_id, duplicate: row.duplicate };
    },
  };
}
