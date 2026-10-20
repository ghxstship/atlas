import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingStore } from "./billing/webhook.ts";
import type { InboundStore } from "./inbound/parse.ts";
import type { ClaimedEmail, NotificationStore, Recipient } from "./notifications/dispatch.ts";
import type { ClaimedWebhook, WebhookStore } from "./webhooks/dispatch.ts";

/**
 * The database operations the platform services use: app schema RPCs and single-row reads, run with
 * the service role. Every store below is built on this seam, so tests pass a fake and production
 * passes supabaseDb(client).
 */
export interface PlatformDb {
  rpc(fn: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  selectOne(
    table: string,
    columns: string,
    match: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, unknown>> | null>;
}

/** A database call failed; carries the PostgREST message (refusals keep their rule code). */
export class PlatformDbError extends Error {
  constructor(operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = "PlatformDbError";
  }
}

/** PlatformDb over a service-role Supabase client. */
export function supabaseDb(client: SupabaseClient): PlatformDb {
  const app = client.schema("app");
  return {
    async rpc(fn, args) {
      const { data, error } = await app.rpc(fn, { ...args });
      if (error !== null) throw new PlatformDbError(fn, error.message);
      return data;
    },
    async selectOne(table, columns, match) {
      const { data, error } = await app
        .from(table)
        .select(columns)
        .match({ ...match })
        .limit(1)
        .maybeSingle();
      if (error !== null) throw new PlatformDbError(table, error.message);
      return (data as Readonly<Record<string, unknown>> | null) ?? null;
    },
  };
}

function rows(data: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(data) ? (data as Readonly<Record<string, unknown>>[]) : [];
}

function text(row: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string")
    throw new PlatformDbError(key, "expected text in the database response");
  return value;
}

function optionalText(
  row: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

/** BillingStore over the 0560 RPCs. */
export function billingStore(db: PlatformDb): BillingStore {
  return {
    async recordStripeEvent(event) {
      const row = rows(
        await db.rpc("record_stripe_event", {
          p_stripe_event_id: event.id,
          p_event_type: event.type,
          p_livemode: event.livemode,
          p_stripe_created_at: event.createdAt.toISOString(),
          p_payload: event.payload,
          p_org_id: event.orgId,
        }),
      )[0];
      const rowId = text(row, "stripe_event_row_id");
      const stored = await db.selectOne("stripe_events", "processed_at", { id: rowId });
      return {
        rowId,
        isNew: row?.["is_new"] === true,
        processed: optionalText(stored ?? undefined, "processed_at") !== null,
      };
    },
    async finishStripeEvent(rowId, error) {
      await db.rpc("finish_stripe_event", { p_stripe_event_row_id: rowId, p_error: error });
    },
    async orgForCustomer(customerId) {
      const link = await db.selectOne("stripe_subscription_links", "org_id", {
        stripe_customer_id: customerId,
      });
      return optionalText(link ?? undefined, "org_id");
    },
    async syncSubscription(input) {
      const state = await db.rpc("sync_subscription_from_stripe", {
        p_org_id: input.orgId,
        p_stripe_customer_id: input.customerId,
        p_stripe_subscription_id: input.subscriptionId,
        p_plan_code: input.planCode,
        p_billing_interval: input.interval,
        p_stripe_status: input.status,
        p_current_period_end: input.currentPeriodEnd?.toISOString() ?? null,
        p_livemode: input.livemode,
        p_extra_seats: input.extraSeats,
      });
      return String(state);
    },
    async recordAddonPurchase(input) {
      const id = await db.rpc("record_addon_purchase_from_stripe", {
        p_org_id: input.orgId,
        p_addon_code: input.addonCode,
        p_quantity: input.quantity,
        p_stripe_checkout_session_id: input.checkoutSessionId,
        p_currency_code: input.currency,
        p_amount_total_minor: input.amountTotalMinor,
        p_livemode: input.livemode,
        p_paid_at: input.paidAt.toISOString(),
      });
      return String(id);
    },
  };
}

/** WebhookStore over the 0510 dispatcher RPCs. */
export function webhookStore(db: PlatformDb): WebhookStore {
  return {
    async claim(limit) {
      return rows(await db.rpc("claim_webhook_deliveries", { p_limit: limit })).map(
        (row): ClaimedWebhook => ({
          deliveryId: text(row, "delivery_id"),
          url: text(row, "url"),
          eventType: text(row, "event_type"),
          body: text(row, "body"),
          signature: text(row, "signature"),
        }),
      );
    },
    async record(deliveryId, responseStatus, error) {
      return String(
        await db.rpc("record_webhook_attempt", {
          p_delivery_id: deliveryId,
          p_response_status: responseStatus,
          p_error: error,
        }),
      );
    },
  };
}

export interface NotificationStoreOptions {
  /** Base URL of Atlas, for links in email. */
  readonly appUrl: string;
  /** From address on the verified sending domain, for example "notifications@mail.example.com". */
  readonly fromAddress: string;
  /** Physical postal address printed in every email (CAN-SPAM), until orgs record their own. */
  readonly postalAddress: string;
  /** Builds the one-click unsubscribe URL for a recipient and category. */
  readonly unsubscribeUrl: (orgId: string, personId: string, kind: string) => Promise<string>;
  /** Inbound domain reply addresses live on, or null to send without reply by email. */
  readonly inboundDomain: string | null;
  /**
   * Base URL of Gateway. A notification for an external party carries a `gatewayPath` argument
   * (1131), and its email links there instead of Atlas.
   */
  readonly gatewayUrl?: string | null;
}

/** The Gateway link of a notification for an external party, or null. */
export function gatewayLink(
  claim: Pick<ClaimedEmail, "messageArgs">,
  gatewayUrl: string | null | undefined,
): string | null {
  const path = claim.messageArgs["gatewayPath"];
  if (!gatewayUrl || typeof path !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(path)) return null;
  return `${gatewayUrl.replace(/\/$/, "")}${path}`;
}

/**
 * A person's name, language and time zone for rendering any channel: their own `locale.language` and
 * `locale.time_zone` personal settings, else en-US and UTC.
 */
export async function recipientProfile(db: PlatformDb, personId: string): Promise<Recipient> {
  const person = await db.selectOne("people", "full_name", { id: personId });
  const setting = async (key: string) =>
    optionalText(
      (await db.selectOne("personal_setting_values", "value_text", {
        person_id: personId,
        setting_key: key,
      })) ?? undefined,
      "value_text",
    );
  return {
    name: optionalText(person ?? undefined, "full_name") ?? "",
    locale: (await setting("locale.language")) ?? "en-US",
    timeZone: (await setting("locale.time_zone")) ?? "UTC",
  };
}

/** NotificationStore over the 0520 RPCs and identity reads. */
export function notificationStore(
  db: PlatformDb,
  options: NotificationStoreOptions,
): NotificationStore {
  const orgSlug = async (orgId: string) =>
    text((await db.selectOne("organizations", "slug, name", { id: orgId })) ?? undefined, "slug");
  return {
    async claimEmail(limit) {
      return rows(
        await db.rpc("claim_notification_deliveries", { p_channel: "Email", p_limit: limit }),
      ).map((row): ClaimedEmail => ({
        deliveryId: text(row, "delivery_id"),
        orgId: text(row, "org_id"),
        recipientPersonId: text(row, "recipient_person_id"),
        address: text(row, "address"),
        kind: text(row, "kind"),
        emailTemplateCode: text(row, "email_template_code"),
        messageArgs: (row["message_args"] as Readonly<Record<string, unknown>> | null) ?? {},
        subjectTable: optionalText(row, "subject_table"),
        subjectId: optionalText(row, "subject_id"),
      }));
    },
    async senderFor(orgId, personId) {
      const org = (await db.selectOne("organizations", "slug, name", { id: orgId })) ?? undefined;
      const slug = text(org, "slug");
      const name = text(org, "name");
      return {
        orgName: name,
        postalAddress: options.postalAddress,
        preferencesUrl: `${options.appUrl}/${slug}/me/notifications`,
        unsubscribeUrl: await options.unsubscribeUrl(orgId, personId, "notification"),
        from: `${name} <${options.fromAddress}>`,
      };
    },
    recipient: (personId) => recipientProfile(db, personId),
    async linkFor(claim) {
      const gateway = gatewayLink(claim, options.gatewayUrl);
      if (gateway !== null) return gateway;
      return `${options.appUrl}/${await orgSlug(claim.orgId)}/inbox`;
    },
    async replyAddressFor(claim) {
      if (options.inboundDomain === null || claim.subjectId === null) return null;
      const local = await db.rpc("reply_address_local_part", {
        p_person_id: claim.recipientPersonId,
        p_subject_id: claim.subjectId,
      });
      return typeof local === "string" ? `${local}@${options.inboundDomain}` : null;
    },
    async record(deliveryId, outcome, providerMessageId, error) {
      await db.rpc("record_notification_delivery", {
        p_delivery_id: deliveryId,
        p_status: outcome,
        p_provider_message_id: providerMessageId,
        p_error: error,
      });
    },
  };
}

/** InboundStore over app.receive_inbound_email. */
export function inboundStore(db: PlatformDb): InboundStore {
  return {
    async receive(input) {
      const id = await db.rpc("receive_inbound_email", {
        p_local_part: input.localPart,
        p_from_address: input.from,
        p_subject_line: input.subject,
        p_message_id_header: input.messageId,
        p_dkim_verified: input.dkimVerified,
        p_body_text: input.bodyText,
        p_raw_object_path: input.rawObjectPath,
      });
      return typeof id === "string" ? id : null;
    },
  };
}

/** Punch kinds of app.punch_kind (A03F, migration 0365). */
export const PUNCH_KINDS = ["In", "Break Start", "Break End", "Out"] as const;
export type PunchKind = (typeof PUNCH_KINDS)[number];

export interface KioskPunchInput {
  readonly deviceKey: string;
  readonly membershipId: string;
  readonly pin: string;
  /** Client punch id (UUID v7): replaying it returns the stored punch. */
  readonly punchId: string;
  readonly punchKind: PunchKind;
  /** Device wall-clock time the punch was made at. */
  readonly deviceAt: Date;
  /** For punches queued offline: milliseconds the device's monotonic clock counted since the punch. */
  readonly monotonicOffsetMs?: number;
  /** Photo taken at the punch, as a storage:// or https:// URI. */
  readonly photoUri?: string;
  readonly projectId?: string;
}

export interface KioskPunchResult {
  readonly punchId: string | null;
  readonly timeEntryId: string | null;
  readonly punchKind: PunchKind | null;
  /** Time the punch counts at, after skew correction. */
  readonly effectiveAt: string | null;
  /** True when the device time was not trusted and the entry needs review. */
  readonly skewFlagged: boolean | null;
  /** Refusal code (PIN, rate limit, project, photo or a record_punch rule), or null on success. */
  readonly refusal: string | null;
}

function isPunchKind(value: string | null): value is PunchKind {
  return value !== null && (PUNCH_KINDS as readonly string[]).includes(value);
}

/** The kiosk PIN service for A17 Compass: one punch through app.kiosk_punch, which calls app.record_punch. */
export async function kioskPunch(
  db: PlatformDb,
  input: KioskPunchInput,
): Promise<KioskPunchResult> {
  const row = rows(
    await db.rpc("kiosk_punch", {
      p_device_key: input.deviceKey,
      p_membership_id: input.membershipId,
      p_pin: input.pin,
      p_punch_id: input.punchId,
      p_punch_kind: input.punchKind,
      p_device_time: input.deviceAt.toISOString(),
      p_monotonic_offset_ms: input.monotonicOffsetMs ?? null,
      p_photo_uri: input.photoUri ?? null,
      p_project_id: input.projectId ?? null,
    }),
  )[0];
  const kind = optionalText(row, "punch_kind");
  const skew = row?.["skew_flagged"];
  return {
    punchId: optionalText(row, "punch_id"),
    timeEntryId: optionalText(row, "time_entry_id"),
    punchKind: isPunchKind(kind) ? kind : null,
    effectiveAt: optionalText(row, "effective_at"),
    skewFlagged: typeof skew === "boolean" ? skew : null,
    refusal: optionalText(row, "refusal"),
  };
}
