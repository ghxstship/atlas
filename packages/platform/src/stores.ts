import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailBrand } from "@xos/email";
import type { InboundStore } from "./inbound/parse.ts";
import { actionLinks } from "./notifications/action-links.ts";
import type { ClaimedEmail, NotificationStore, Recipient } from "./notifications/dispatch.ts";
import type { ClaimedWebhook, WebhookStore } from "./webhooks/dispatch.ts";

/** The URL without trailing slashes: a loop, which stays linear where `/\/+$/` backtracks over a run of slashes. */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

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

/** What PostgREST says about a failed call, beyond its message. */
export interface PlatformDbErrorDetails {
  /** The SQLSTATE or PostgREST code, such as XR001 for a refusal. */
  readonly code?: string | null;
  /** The hint, which names the rule of an XR001 refusal. */
  readonly hint?: string | null;
}

/** A database call failed; carries the PostgREST message (refusals keep their rule code). */
export class PlatformDbError extends Error {
  /** The database's own message, without the operation in front. */
  readonly databaseMessage: string;
  readonly code: string | null;
  readonly hint: string | null;

  constructor(operation: string, message: string, details: PlatformDbErrorDetails = {}) {
    super(`${operation}: ${message}`);
    this.name = "PlatformDbError";
    this.databaseMessage = message;
    this.code = details.code ?? null;
    this.hint = details.hint ?? null;
  }
}

/** PlatformDb over a service-role Supabase client. */
export function supabaseDb(client: SupabaseClient): PlatformDb {
  const app = client.schema("app");
  return {
    async rpc(fn, args) {
      const { data, error } = await app.rpc(fn, { ...args });
      if (error !== null) throw new PlatformDbError(fn, error.message, error);
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

export interface RestDbOptions {
  /** The project URL (SUPABASE_URL). */
  readonly url: string;
  /** The service role key, sent as the apikey and the bearer token, as supabase-js sends it. */
  readonly serviceKey: string;
  /** The schema the calls run in (the Content-Profile and Accept-Profile headers); app when left out. */
  readonly schema?: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * PlatformDb over PostgREST with plain fetch: the same requests supabaseDb makes through supabase-js
 * (POST /rpc/<fn> and a one-row GET, in the app schema) and the same errors, without loading
 * supabase-js. The Edge Functions use it, so a cold start parses only what the function calls (A85).
 */
export function restDb(options: RestDbOptions): PlatformDb {
  const base = `${withoutTrailingSlashes(options.url)}/rest/v1`;
  const send = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const auth = { apikey: options.serviceKey, Authorization: `Bearer ${options.serviceKey}` };
  const schema = options.schema ?? "app";

  async function call(operation: string, url: string, init: RequestInit): Promise<unknown> {
    const response = await send(url, init);
    const body = await response.text();
    if (!response.ok) {
      let problem: { message?: unknown; code?: unknown; hint?: unknown } = {};
      try {
        problem = JSON.parse(body) as typeof problem;
      } catch {
        // Not a PostgREST error body (a gateway error page): the text itself is the message.
      }
      const message =
        typeof problem.message === "string" ? problem.message : body || response.statusText;
      throw new PlatformDbError(operation, message, {
        code: typeof problem.code === "string" ? problem.code : null,
        hint: typeof problem.hint === "string" ? problem.hint : null,
      });
    }
    return body === "" ? null : (JSON.parse(body) as unknown);
  }

  return {
    rpc(fn, args) {
      return call(fn, `${base}/rpc/${encodeURIComponent(fn)}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Content-Profile": schema },
        body: JSON.stringify(args),
      });
    },
    async selectOne(table, columns, match) {
      const query = new URLSearchParams({ select: columns.replace(/\s+/g, "") });
      for (const [column, value] of Object.entries(match)) query.append(column, `eq.${value}`);
      query.set("limit", "1");
      const data = await call(table, `${base}/${encodeURIComponent(table)}?${query.toString()}`, {
        method: "GET",
        headers: { ...auth, "Accept-Profile": schema },
      });
      return rows(data)[0] ?? null;
    },
  };
}

export function rows(data: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(data) ? (data as Readonly<Record<string, unknown>>[]) : [];
}

export function text(row: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string")
    throw new PlatformDbError(key, "expected text in the database response");
  return value;
}

export function optionalText(
  row: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
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
  /**
   * Public base URL of the org-brand bucket (`<SUPABASE_URL>/storage/v1/object/public/org-brand`),
   * for the logo of a white-label org's email (A138). Without it the email carries no logo.
   */
  readonly brandAssetUrl?: string | null;
}

/**
 * Kinds sent as the platform rather than the org (A138, Section 12): a person's sign-in security
 * notices (account.*, which 2050 sends in whichever org they chose last), the org's XOS billing, trial
 * and white label plan notices, XOS deleting or recovering the org, and XOS's moderation and rating
 * dispute decisions. Their email keeps the
 * platform brand, sender and no org reply-to while white label is in force.
 */
const PLATFORM_KIND_PREFIXES = [
  "account.",
  "billing.",
  "organization.white_label_",
  "organization.deletion_",
  // XOS's marketplace moderation and rating disputes: the notice names the platform, never the operator who decided
  // and never the org (1590, ADR 0158), so it is not sent under the affected org's brand either.
  "listing.moderated",
  "listing_report.",
  "moderation_appeal.",
  "rating_dispute.",
] as const;

export function isPlatformEmailKind(kind: string): boolean {
  return PLATFORM_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix));
}

/**
 * A From header: the display name without control characters, quoted when it holds a character
 * RFC 5322 reserves (an org's sender name may hold a comma or a parenthesis).
 */
export function mailbox(name: string, address: string): string {
  const clean = Array.from(name, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : c;
  })
    .join("")
    .trim();
  const display = /[()<>[\]:;@\\,."]/.test(clean) ? `"${clean.replace(/["\\]/g, "\\$&")}"` : clean;
  return `${display} <${address}>`;
}

/**
 * An org's email brand while white label is in force (app.email_brand_for_org, 3310 and 904090003), or null when it
 * is not: the email then wears the platform brand with the org's own name.
 */
export interface OrgEmailBrand {
  readonly brandName: string | null;
  readonly senderName: string | null;
  readonly replyTo: string | null;
  readonly logoPath: string | null;
  readonly accentHex: string | null;
  readonly suppressPoweredBy: boolean;
}

/** Reads the email brand row of app.email_brand_for_org, or null for no row. */
export function orgEmailBrandFromRow(
  row: Readonly<Record<string, unknown>> | undefined,
): OrgEmailBrand | null {
  if (row === undefined) return null;
  return {
    brandName: optionalText(row, "brand_name"),
    senderName: optionalText(row, "sender_name"),
    replyTo: optionalText(row, "reply_to"),
    logoPath: optionalText(row, "logo_path"),
    accentHex: optionalText(row, "accent_hex"),
    suppressPoweredBy: row["suppress_powered_by"] === true,
  };
}

/** An org's email brand while white label is in force, or null. */
export async function readOrgEmailBrand(
  db: PlatformDb,
  orgId: string,
): Promise<OrgEmailBrand | null> {
  return orgEmailBrandFromRow(rows(await db.rpc("email_brand_for_org", { p_org_id: orgId }))[0]);
}

/** The public URL of a file in the org-brand bucket, each path segment encoded, or null without a base or path. */
export function brandAssetUrl(
  base: string | null | undefined,
  path: string | null | undefined,
): string | null {
  const root = base ? withoutTrailingSlashes(base) : "";
  if (!root || !path) return null;
  return `${root}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The bare address of a mailbox ("XOS <notifications@example.com>" or "notifications@example.com"), found with
 * indexOf so it stays linear on any input (a pattern such as /<([^>]+)>/ backtracks on a run of "<").
 */
export function mailboxAddress(mailbox: string): string {
  const open = mailbox.lastIndexOf("<");
  const close = open === -1 ? -1 : mailbox.indexOf(">", open + 1);
  return open !== -1 && close > open + 1 ? mailbox.slice(open + 1, close).trim() : mailbox.trim();
}

/** What an email's Sender takes from the brand: the name it signs with, From, reply-to, and logo and accent. */
export interface BrandedSenderParts {
  readonly orgName: string;
  readonly from: string;
  readonly replyTo?: string;
  readonly brand?: EmailBrand;
}

/**
 * The brand half of an org's email Sender (A138, Section 12), the one rule every org-sent email follows: while white
 * label is in force, the brand name, the From name (email_sender_name, else the brand name), the support address
 * replies go to, the logo and the accent; otherwise the org's own name on the platform's From address. `fromAddress`
 * is the verified sending address, bare or as a mailbox ("XOS <notifications@example.com>").
 */
export function brandedSender(
  orgName: string,
  brand: OrgEmailBrand | null,
  options: { readonly fromAddress: string; readonly brandAssetUrl?: string | null },
): BrandedSenderParts {
  const address = mailboxAddress(options.fromAddress);
  const name = brand?.brandName ?? orgName;
  if (brand === null) return { orgName: name, from: mailbox(name, address) };
  const logoUrl = brandAssetUrl(options.brandAssetUrl, brand.logoPath);
  return {
    orgName: name,
    from: mailbox(brand.senderName ?? name, address),
    ...(brand.replyTo === null ? {} : { replyTo: brand.replyTo }),
    brand: {
      ...(logoUrl === null ? {} : { logoUrl }),
      ...(brand.accentHex === null ? {} : { accentHex: brand.accentHex }),
      ...(brand.suppressPoweredBy ? { suppressPoweredBy: true } : {}),
    },
  };
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
 * A person's name, language and time zone for rendering any channel, through app.recipient_setting (1393). In an
 * org: the language the org gives them (its locked value, their own, its own, en-US) and the zone it reaches them
 * in. Without an org: their own `locale.language` and `locale.time_zone` for every org, else en-US and UTC.
 */
export async function recipientProfile(
  db: PlatformDb,
  personId: string,
  orgId?: string,
): Promise<Recipient> {
  const person = await db.selectOne("people", "full_name", { id: personId });
  // Live values only, one kept for this org over the one for every org; the org's language and zone (1393).
  const setting = async (key: string) =>
    optionalText(
      {
        value_text: await db.rpc("recipient_setting", {
          p_person_id: personId,
          p_org_id: orgId ?? null,
          p_setting_key: key,
        }),
      },
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
        ...(typeof row["notification_id"] === "string"
          ? { notificationId: row["notification_id"] }
          : {}),
      }));
    },
    async senderFor(orgId, personId, kind) {
      const org = (await db.selectOne("organizations", "slug, name", { id: orgId })) ?? undefined;
      const slug = text(org, "slug");
      // While white label is in force (3310), the org's brand name, sender name, support address,
      // logo and accent; platform notices keep the platform brand.
      const brand =
        kind !== undefined && isPlatformEmailKind(kind) ? null : await readOrgEmailBrand(db, orgId);
      const parts = brandedSender(text(org, "name"), brand, {
        fromAddress: options.fromAddress,
        brandAssetUrl: options.brandAssetUrl ?? null,
      });
      return {
        ...parts,
        postalAddress: options.postalAddress,
        preferencesUrl: `${options.appUrl}/${slug}/me/notifications`,
        unsubscribeUrl: await options.unsubscribeUrl(orgId, personId, "notification"),
      };
    },
    recipient: (personId, orgId) => recipientProfile(db, personId, orgId),
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
    async actionLinksFor(claim) {
      const minted = rows(
        await db.rpc("mint_notification_action_tokens", { p_delivery_id: claim.deliveryId }),
      ).map((r) => ({
        action: optionalText(r, "action") ?? "",
        token: optionalText(r, "token") ?? "",
        audience: optionalText(r, "audience") ?? "",
      }));
      return actionLinks(minted, { atlasUrl: options.appUrl, gatewayUrl: options.gatewayUrl });
    },
    async mintApprovalLinkCodeFor(claim) {
      const code = await db.rpc("mint_approval_link_code", { p_delivery_id: claim.deliveryId });
      return typeof code === "string" ? code : null;
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
// eslint-disable-next-line xos/no-restated-enums -- below @xos/data; test/database-enums.test.ts holds it equal
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
