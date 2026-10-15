import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderCode } from "../../framework/catalog.ts";
import { ItemTally, type Connector, type SyncContext } from "../../framework/connector.ts";
import { unwrap, type DbClient } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";
import { callJson } from "../../framework/http.ts";
import type { Translate } from "../../framework/messages.ts";

/** A domain event matched to a channel route (app.integration_route_events, migration 0630). */
export interface RoutedEvent {
  readonly eventId: string;
  readonly channelId: string;
  readonly eventType: string;
  readonly projectName: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ChatMember {
  readonly personId: string;
  readonly userId: string;
  readonly orgId: string;
}

export interface CommunicationSource {
  routedEvents(
    connectionId: string,
    afterEventId: string | null,
    limit: number,
  ): Promise<readonly RoutedEvent[]>;
  findConnection(provider: ProviderCode, externalAccountId: string): Promise<string | null>;
  resolveMember(connectionId: string, externalUserId: string): Promise<ChatMember | null>;
}

export interface ChatProvider {
  readonly provider: ProviderCode;
  readonly label: string;
  post(context: SyncContext, channelId: string, text: string): Promise<void>;
}

function token(context: SyncContext): string {
  if (context.credential === null) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  return context.credential.token;
}

const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value.length > 0 ? value : fallback;

/** The message for one routed event, in the org's locale. Unknown event types get the generic line. */
export function notificationText(event: RoutedEvent, t: Translate): string {
  const project = event.projectName ?? "";
  switch (event.eventType) {
    case "record.created":
      return t("chat.event.recordCreated", {
        kind: text(event.data["record_kind"], "record"),
        project,
        title: text(event.data["title"], ""),
      });
    case "record.state_changed":
      return t("chat.event.recordStateChanged", {
        project,
        from: text(event.data["from_state"], ""),
        to: text(event.data["to_state"], ""),
      });
    case "project.created":
      return t("chat.event.projectCreated", { name: text(event.data["name"], project) });
    case "invoice.issued":
      return t("chat.event.invoiceIssued", { project });
    case "incident.reported":
      return t("chat.event.incidentReported", { project });
    default:
      return event.projectName === null
        ? t("chat.event.withoutProject", { event: event.eventType })
        : t("chat.event.withProject", { event: event.eventType, project });
  }
}

// Slack -------------------------------------------------------------------------------------------------------------------

const SLACK_CONNECTION_ERRORS = new Set([
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_authed",
  "missing_scope",
]);
const SLACK_ITEM_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "msg_too_long",
]);

/** Slack answers 200 with ok:false; this turns its error codes into the framework's failures. */
export function slackFailure(error: string): IntegrationError {
  if (SLACK_CONNECTION_ERRORS.has(error))
    return new IntegrationError("credential_refused", `Slack refused the token: ${error}.`, {
      connectionError: true,
    });
  if (error === "ratelimited")
    return new IntegrationError("provider_rate_limited", "Slack rate limited the request.", {
      retryable: true,
    });
  if (SLACK_ITEM_ERRORS.has(error))
    return new IntegrationError(`slack_${error}`, `Slack could not post: ${error}.`);
  return new IntegrationError("provider_rejected", `Slack returned ${error}.`);
}

export const slackProvider: ChatProvider = {
  provider: "slack",
  label: "Slack",
  async post(context, channelId, message) {
    const response = await callJson<{ ok: boolean; error?: string }>(context.http, "Slack", {
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      token: token(context),
      json: { channel: channelId, text: message, unfurl_links: false, unfurl_media: false },
    });
    if (!response.ok) throw slackFailure(response.error ?? "unknown_error");
  },
};

// Microsoft Teams -----------------------------------------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const teamsProvider: ChatProvider = {
  provider: "microsoft_teams",
  label: "Microsoft Teams",
  async post(context, channelId, message) {
    const [team, channel] = channelId.split("/");
    if (!team || !channel)
      throw new IntegrationError(
        "teams_channel_malformed",
        `${channelId} is not a <team>/<channel> id.`,
      );
    await callJson(context.http, "Microsoft Teams", {
      method: "POST",
      url: `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(team)}/channels/${encodeURIComponent(channel)}/messages`,
      token: token(context),
      json: { body: { contentType: "html", content: escapeHtml(message) } },
    });
  },
};

// Notification delivery ------------------------------------------------------------------------------------------------------

const BATCH = 200;

/** Posts routed domain events after the cursor, once each, and moves the cursor past every event handled. */
export function chatConnector(
  provider: ChatProvider,
  source: CommunicationSource,
  translate: Translate,
): Connector {
  return {
    provider: provider.provider,
    scopes: ["Notification Delivery"],
    async sync(context) {
      const tally = new ItemTally(context);
      const events = await source.routedEvents(context.connection.id, context.cursor, BATCH);
      let cursor = context.cursor;
      for (const event of events) {
        tally.read += 1;
        try {
          await provider.post(context, event.channelId, notificationText(event, translate));
          tally.written += 1;
        } catch (error) {
          if (!(error instanceof IntegrationError) || error.retryable || error.connectionError)
            throw error;
          // A missing or archived channel fails this message only; the rest still go out.
          await tally.fail(error.code, error.message, { externalId: event.channelId });
        }
        cursor = event.eventId;
      }
      return { counts: tally.counts(), cursorAfter: cursor };
    },
  };
}

export function chatConnectors(source: CommunicationSource, translate: Translate): Connector[] {
  return [slackProvider, teamsProvider].map((p) => chatConnector(p, source, translate));
}

// Inbound requests: signatures ---------------------------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Verifies Slack's v0 request signature and refuses requests older than five minutes (replay protection). */
export function verifySlackRequest(
  signingSecret: string,
  timestamp: string,
  signature: string,
  body: string,
  now: Date,
): boolean {
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(now.getTime() / 1000 - seconds) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return safeEqual(expected, signature);
}

/** Verifies a Teams outgoing webhook: `Authorization: HMAC <base64 HMAC-SHA256 of the body under the base64 secret>`. */
export function verifyTeamsRequest(
  secretBase64: string,
  authorization: string,
  body: string,
): boolean {
  const match = /^HMAC (.+)$/.exec(authorization);
  if (match?.[1] === undefined) return false;
  const expected = createHmac("sha256", Buffer.from(secretBase64, "base64"))
    .update(body)
    .digest("base64");
  return safeEqual(expected, match[1]);
}

// Inbound requests: slash commands and unfurls --------------------------------------------------------------------------------

export interface RecordCard {
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly state: string;
}

/** Looks a record up by display key as the signed-in chat user: row level security decides what they see. */
export async function findRecordAs(db: DbClient, key: string): Promise<RecordCard | null> {
  const match = /^([A-Z0-9]{2,10})-(\d{1,9})$/.exec(key.trim().toUpperCase());
  if (match === null) return null;
  const project = await unwrap<{ id: string } | null>(
    db.from("projects").select("id").eq("project_key", match[1]).maybeSingle(),
  );
  if (project === null) return null;
  const record = await unwrap<{ title: string; record_kind: string; record_state: string } | null>(
    db
      .from("records")
      .select("title, record_kind, record_state")
      .eq("project_id", project.id)
      .eq("record_number", Number(match[2]))
      .is("deleted_at", null)
      .maybeSingle(),
  );
  return record === null
    ? null
    : {
        key: `${match[1]}-${match[2]}`,
        title: record.title,
        kind: record.record_kind,
        state: record.record_state,
      };
}

export interface ChatRequestDeps {
  readonly source: CommunicationSource;
  /** A database client acting as the given auth user under RLS (a short-lived token, never the service role). */
  readonly clientFor: (userId: string) => Promise<DbClient>;
  readonly translate: Translate;
}

export interface SlashCommand {
  readonly provider: ProviderCode;
  readonly externalAccountId: string;
  readonly externalUserId: string;
  readonly text: string;
}

/** Answers a slash command as the person linked to the chat user. Every reply is finished copy. */
export async function handleSlashCommand(
  command: SlashCommand,
  deps: ChatRequestDeps,
): Promise<string> {
  const t = deps.translate;
  const [verb = "help", ...rest] = command.text
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (verb === "help") return t("chat.slash.help");
  if (verb !== "record") return t("chat.slash.unknown");
  const key = rest[0];
  if (key === undefined) return t("chat.slash.keyMissing");
  const connectionId = await deps.source.findConnection(
    command.provider,
    command.externalAccountId,
  );
  const member =
    connectionId === null
      ? null
      : await deps.source.resolveMember(connectionId, command.externalUserId);
  if (member === null) return t("chat.slash.unlinked");
  const card = await findRecordAs(await deps.clientFor(member.userId), key);
  if (card === null) return t("chat.slash.notFound", { key: key.toUpperCase() });
  return t("chat.slash.record", {
    key: card.key,
    title: card.title,
    kind: card.kind,
    state: card.state,
  });
}

/** Record keys named by Atlas links in a message (`?peek=NWL-12`), for unfurls. */
export function recordKeysIn(urls: readonly string[], atlasOrigin: string): string[] {
  const keys: string[] = [];
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue; // Not a URL at all: nothing to unfurl.
    }
    const peek = url.searchParams.get("peek");
    if (url.origin === atlasOrigin && peek !== null && !keys.includes(peek)) keys.push(peek);
  }
  return keys;
}

/** Builds unfurl text for each Atlas record link, as the person linked to the chat user; unseen records are left alone. */
export async function unfurlLinks(
  request: {
    readonly provider: ProviderCode;
    readonly externalAccountId: string;
    readonly externalUserId: string;
    readonly urls: readonly string[];
  },
  atlasOrigin: string,
  deps: ChatRequestDeps,
): Promise<Readonly<Record<string, string>>> {
  const keys = recordKeysIn(request.urls, atlasOrigin);
  if (keys.length === 0) return {};
  const connectionId = await deps.source.findConnection(
    request.provider,
    request.externalAccountId,
  );
  const member =
    connectionId === null
      ? null
      : await deps.source.resolveMember(connectionId, request.externalUserId);
  if (member === null) return {};
  const db = await deps.clientFor(member.userId);
  const unfurls: Record<string, string> = {};
  for (const url of request.urls) {
    const key = recordKeysIn([url], atlasOrigin)[0];
    if (key === undefined) continue;
    const card = await findRecordAs(db, key);
    if (card !== null)
      unfurls[url] = deps.translate("chat.slash.record", {
        key: card.key,
        title: card.title,
        kind: card.kind,
        state: card.state,
      });
  }
  return unfurls;
}

// Source -----------------------------------------------------------------------------------------------------------------------

interface EventRow {
  domain_event_id: string;
  external_channel_id: string;
  event_type: string;
  project_name: string | null;
  data: Record<string, unknown> | null;
}

export function supabaseCommunicationSource(db: DbClient): CommunicationSource {
  return {
    async routedEvents(connectionId, afterEventId, limit) {
      let query = db
        .from("integration_route_events")
        .select("domain_event_id, external_channel_id, event_type, project_name, data")
        .eq("integration_connection_id", connectionId);
      if (afterEventId !== null) query = query.gt("domain_event_id", afterEventId);
      const rows = await unwrap<EventRow[]>(query.order("domain_event_id").limit(limit));
      return rows.map((r) => ({
        eventId: r.domain_event_id,
        channelId: r.external_channel_id,
        eventType: r.event_type,
        projectName: r.project_name,
        data: r.data ?? {},
      }));
    },
    async findConnection(provider, externalAccountId) {
      return unwrap<string | null>(
        db.rpc("find_chat_connection", {
          p_provider_code: provider,
          p_external_account_id: externalAccountId,
        }),
      );
    },
    async resolveMember(connectionId, externalUserId) {
      const rows = await unwrap<{ person_id: string; user_id: string; org_id: string }[]>(
        db.rpc("resolve_chat_member", {
          p_connection_id: connectionId,
          p_external_user_id: externalUserId,
        }),
      );
      const row = rows[0];
      return row === undefined
        ? null
        : { personId: row.person_id, userId: row.user_id, orgId: row.org_id };
    },
  };
}
