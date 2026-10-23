import { COMPASS_SCHEME, compassSchemeUrl, isRecordKey } from "@xos/ia/handoff";
import { PlatformDbError, recipientProfile, type PlatformDb } from "../stores.ts";
import type { ClaimedPush, PushDevice, PushStore, WebPushStore } from "./push.ts";
import type {
  ClaimedSms,
  ClaimedSmsSummary,
  SmsInboundStore,
  SmsStore,
  SmsSummaryStore,
} from "./sms.ts";
import type { TranslationStore } from "./translation.ts";
import type { WebPushDevice } from "./web-push.ts";

/**
 * Stores of the push and SMS senders, the SMS webhook and chat translation, over the 1361 and 1363 RPCs
 * and service-role reads (PlatformDb), so tests pass a fake and production passes supabaseDb(client).
 */

type Row = Readonly<Record<string, unknown>>;

function rows(data: unknown): readonly Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

function text(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string")
    throw new PlatformDbError(key, "expected text in the database response");
  return value;
}

function optionalText(row: Row | undefined | null, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

function devices(value: unknown): PushDevice[] {
  return rows(value).flatMap((d) => {
    const subscriptionId = optionalText(d, "subscriptionId");
    const token = optionalText(d, "token");
    return subscriptionId !== null && token !== null ? [{ subscriptionId, token }] : [];
  });
}

/** Browsers the claim lists: subscription ids with no Expo token (1533). */
function browsers(value: unknown): string[] {
  return rows(value).flatMap((d) => {
    const subscriptionId = optionalText(d, "subscriptionId");
    return subscriptionId !== null && d["token"] === null ? [subscriptionId] : [];
  });
}

/** The record key and org slug of a notification about a record, or null. */
async function recordTarget(
  db: PlatformDb,
  claim: Pick<ClaimedPush, "orgId" | "subjectTable" | "subjectId">,
): Promise<{ readonly slug: string | null; readonly recordKey: string | null }> {
  const org = await db.selectOne("organizations", "slug", { id: claim.orgId });
  const slug = optionalText(org, "slug");
  if (claim.subjectId === null || !["records", "app.records"].includes(claim.subjectTable ?? ""))
    return { slug, recordKey: null };
  const record = await db.selectOne("records", "project_id, record_number", {
    id: claim.subjectId,
  });
  const projectId = optionalText(record, "project_id");
  if (record === null || projectId === null) return { slug, recordKey: null };
  const project = await db.selectOne("projects", "project_key", { id: projectId });
  const recordKey = `${optionalText(project, "project_key") ?? ""}-${String(record["record_number"] ?? "")}`;
  return { slug, recordKey: isRecordKey(recordKey) ? recordKey : null };
}

/**
 * The path a browser push opens on the app it subscribed in: in Atlas the record a notification is about, else the
 * org's Inbox; in Gateway, Home. A path, never a full URL: the service worker resolves it on its own origin.
 */
export async function webPushLink(
  db: PlatformDb,
  claim: Pick<ClaimedPush, "orgId" | "subjectTable" | "subjectId">,
  app: WebPushDevice["app"],
): Promise<string> {
  if (app === "Gateway") return "/home";
  const target = await recordTarget(db, claim);
  if (target.slug === null) return "/";
  return target.recordKey === null
    ? `/${target.slug}/inbox`
    : `/${target.slug}/r/${target.recordKey}`;
}

/** The Compass deep link of a notification: the record screen for a record, else the Inbox. */
export async function compassLink(
  db: PlatformDb,
  claim: Pick<ClaimedPush, "orgId" | "subjectTable" | "subjectId">,
): Promise<string> {
  const inbox = `${COMPASS_SCHEME}://inbox`;
  if (claim.subjectId === null || !["records", "app.records"].includes(claim.subjectTable ?? ""))
    return inbox;
  const record = await db.selectOne("records", "project_id, record_number", {
    id: claim.subjectId,
  });
  const projectId = optionalText(record, "project_id");
  if (record === null || projectId === null) return inbox;
  const project = await db.selectOne("projects", "project_key", { id: projectId });
  const org = await db.selectOne("organizations", "slug", { id: claim.orgId });
  const recordKey = `${optionalText(project, "project_key") ?? ""}-${String(record["record_number"] ?? "")}`;
  const slug = optionalText(org, "slug");
  if (slug === null || !isRecordKey(recordKey)) return inbox;
  return compassSchemeUrl({ kind: "record", org: slug, recordKey });
}

/** PushStore over app.claim_notification_deliveries, app.record_push_tickets and the receipt RPCs. */
export function pushStore(db: PlatformDb): PushStore {
  return {
    async claimPush(limit) {
      return rows(
        await db.rpc("claim_notification_deliveries", { p_channel: "Push", p_limit: limit }),
      ).map((row): ClaimedPush => ({
        deliveryId: text(row, "delivery_id"),
        notificationId: text(row, "notification_id"),
        orgId: text(row, "org_id"),
        recipientPersonId: text(row, "recipient_person_id"),
        kind: text(row, "kind"),
        categoryCode: text(row, "category_code"),
        messageArgs: (row["message_args"] as Row | null) ?? {},
        subjectTable: optionalText(row, "subject_table"),
        subjectId: optionalText(row, "subject_id"),
        devices: devices(row["push_devices"]),
        browsers: browsers(row["push_devices"]),
      }));
    },
    recipient: (personId, orgId) => recipientProfile(db, personId, orgId),
    deepLink: (claim) => compassLink(db, claim),
    async recordTickets(deliveryId, tickets) {
      await db.rpc("record_push_tickets", { p_delivery_id: deliveryId, p_tickets: tickets });
    },
    async record(deliveryId, outcome, providerMessageId, error) {
      await db.rpc("record_notification_delivery", {
        p_delivery_id: deliveryId,
        p_status: outcome,
        p_provider_message_id: providerMessageId,
        p_error: error,
      });
    },
    async claimReceipts(limit) {
      return rows(await db.rpc("claim_push_receipts", { p_limit: limit })).map((r) =>
        text(r, "ticket_id"),
      );
    },
    async recordReceipts(receipts) {
      const pruned = await db.rpc("record_push_receipts", { p_receipts: receipts });
      return typeof pruned === "number" ? pruned : 0;
    },
  };
}

/** WebPushStore over app.web_push_devices and app.record_web_push_tickets (1533). */
export function webPushStore(db: PlatformDb): WebPushStore {
  return {
    async webDevices(deliveryId) {
      return rows(await db.rpc("web_push_devices", { p_delivery_id: deliveryId })).flatMap(
        (r): WebPushDevice[] => {
          const app = optionalText(r, "app");
          return app === "Atlas" || app === "Gateway"
            ? [
                {
                  subscriptionId: text(r, "subscription_id"),
                  endpoint: text(r, "endpoint"),
                  p256dh: text(r, "p256dh"),
                  auth: text(r, "auth"),
                  app,
                },
              ]
            : [];
        },
      );
    },
    async recordWebTickets(deliveryId, tickets) {
      await db.rpc("record_web_push_tickets", { p_delivery_id: deliveryId, p_tickets: tickets });
    },
    webLink: (claim, app) => webPushLink(db, claim, app),
  };
}

export interface SmsStoreOptions {
  /** Base URL of Atlas: SMS links open the Inbox, the shortest stable link. */
  readonly appUrl: string;
}

/**
 * SmsStore and SmsSummaryStore over app.claim_notification_deliveries, app.claim_sms_summaries and their
 * record RPCs (1361, 1367), which meter a sent text's billed segments (1393).
 */
export function smsStore(db: PlatformDb, options: SmsStoreOptions): SmsStore & SmsSummaryStore {
  const org = async (orgId: string) =>
    (await db.selectOne("organizations", "slug, name", { id: orgId })) ?? undefined;
  const inbox = async (orgId: string) =>
    `${options.appUrl.replace(/\/$/, "")}/${text(await org(orgId), "slug")}/inbox`;
  return {
    async claimSms(limit) {
      return rows(
        await db.rpc("claim_notification_deliveries", { p_channel: "SMS", p_limit: limit }),
      ).map((row): ClaimedSms => ({
        deliveryId: text(row, "delivery_id"),
        orgId: text(row, "org_id"),
        recipientPersonId: text(row, "recipient_person_id"),
        address: text(row, "address"),
        kind: text(row, "kind"),
        messageArgs: (row["message_args"] as Row | null) ?? {},
      }));
    },
    recipient: (personId, orgId) => recipientProfile(db, personId, orgId),
    async orgName(orgId) {
      return text(await org(orgId), "name");
    },
    linkFor: (claim) => inbox(claim.orgId),
    inboxLink: inbox,
    async record(deliveryId, outcome, providerMessageId, error, segments = 1) {
      await db.rpc("record_notification_delivery", {
        p_delivery_id: deliveryId,
        p_status: outcome,
        p_provider_message_id: providerMessageId,
        p_error: error,
        p_segments: segments,
      });
    },
    async claimSummaries(limit) {
      return rows(await db.rpc("claim_sms_summaries", { p_limit: limit })).map(
        (row): ClaimedSmsSummary => {
          const ids = row["delivery_ids"];
          const count = row["held_count"];
          return {
            orgId: text(row, "org_id"),
            recipientPersonId: text(row, "recipient_person_id"),
            address: text(row, "address"),
            deliveryIds: Array.isArray(ids)
              ? ids.filter((i): i is string => typeof i === "string")
              : [],
            heldCount: typeof count === "number" ? count : 0,
            kind: text(row, "kind"),
            messageArgs: (row["message_args"] as Row | null) ?? {},
          };
        },
      );
    },
    async recordSummary(deliveryIds, outcome, providerMessageId, error, segments = 1) {
      await db.rpc("record_sms_summary", {
        p_delivery_ids: [...deliveryIds],
        p_status: outcome,
        p_provider_message_id: providerMessageId,
        p_error: error,
        p_segments: segments,
      });
    },
  };
}

/** SmsInboundStore over app.record_sms_keyword and app.record_sms_status. */
export function smsInboundStore(db: PlatformDb): SmsInboundStore {
  return {
    async recordKeyword(phone, action, keyword) {
      const count = await db.rpc("record_sms_keyword", {
        p_phone_e164: phone,
        p_action: action,
        p_keyword: keyword,
      });
      return typeof count === "number" ? count : 0;
    },
    async recordStatus(sid, status, error) {
      return (
        (await db.rpc("record_sms_status", {
          p_provider_message_id: sid,
          p_status: status,
          p_error: error,
        })) === true
      );
    },
  };
}

/** TranslationStore over app.chat_messages, the org setting and app.record_chat_message_translation. */
export function translationStore(db: PlatformDb): TranslationStore {
  return {
    async message(messageId) {
      const row = await db.selectOne("chat_messages", "org_id, body, language, deleted_at", {
        id: messageId,
      });
      if (row === null || optionalText(row, "deleted_at") !== null) return null;
      return {
        orgId: text(row, "org_id"),
        body: optionalText(row, "body"),
        language: optionalText(row, "language"),
      };
    },
    async enabled(orgId) {
      return (await db.rpc("message_translation_enabled", { p_org_id: orgId })) === true;
    },
    async cached(messageId, targetLanguage) {
      return optionalText(
        await db.selectOne("chat_message_translations", "body", {
          chat_message_id: messageId,
          target_language: targetLanguage,
        }),
        "body",
      );
    },
    async save(messageId, targetLanguage, translated, sourceLanguage, provider) {
      await db.rpc("record_chat_message_translation", {
        p_chat_message_id: messageId,
        p_target_language: targetLanguage,
        p_body: translated,
        p_source_language: sourceLanguage,
        p_provider: provider,
      });
    },
  };
}
