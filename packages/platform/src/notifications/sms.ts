import { formatMessage } from "@xos/email";
import { z } from "zod";
import { clip, localeOf, notificationText } from "./copy.ts";
import type { DeliveryOutcome, Recipient } from "./dispatch.ts";

/**
 * SMS through Twilio (Section 5, Section 14.5 TCPA and 10DLC, finding A65-012), behind the SmsProvider
 * port so tests and local runs never reach the network. The database decides who may be texted:
 * app.claim_notification_deliveries hands over only numbers that are verified, have recorded consent in the
 * org, are not suppressed, and are outside quiet hours in the recipient's time zone. Twilio is called over
 * its REST API with fetch, which runs unchanged in Node and the Deno Edge runtime: the `twilio` package
 * would add a Node-only dependency tree for one POST and one HMAC.
 *
 * The inbound webhook (sms-webhook) verifies Twilio's signature, records STOP, START and HELP through
 * app.record_sms_keyword (the existing STOP suppression reason), answers with the catalog's reply, and
 * records status callbacks through app.record_sms_status.
 */

export const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** An SMS delivery claimed from app.claim_notification_deliveries. */
export interface ClaimedSms {
  readonly deliveryId: string;
  readonly orgId: string;
  readonly recipientPersonId: string;
  /** Verified number in E.164. */
  readonly address: string;
  readonly kind: string;
  readonly messageArgs: Readonly<Record<string, unknown>>;
}

export interface OutgoingSms {
  readonly to: string;
  readonly body: string;
  readonly deliveryId: string;
}

export interface SmsSendResult {
  readonly providerMessageId: string;
  /** Segments the provider billed the text as, when it said; the sender otherwise counts them (smsSegments). */
  readonly segments?: number;
}

/** The GSM 03.38 default alphabet: one septet each. */
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** Its extension table: two septets each (escape plus the character). */
const GSM7_EXTENDED = new Set("^{}\\[~]|€\f");
/** Characters Twilio's Smart Encoding sends as their GSM look-alikes, so they never force UCS-2. */
const SMART_ENCODING: Readonly<Record<string, string>> = {
  "…": "...",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  " ": " ",
  " ": " ",
  " ": " ",
};

/**
 * The segments a text is billed as (the sms_segments meter): GSM-7 fits 160 septets in one segment and 153 in
 * each part of a longer text; any other character makes the text UCS-2, 70 code units in one segment and 67 per
 * part, as the Spanish "más" does.
 */
export function smsSegments(body: string): number {
  const text = [...body].map((c) => SMART_ENCODING[c] ?? c).join("");
  let septets = 0;
  for (const c of text) {
    if (GSM7_BASIC.has(c)) septets += 1;
    else if (GSM7_EXTENDED.has(c)) septets += 2;
    else return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

/** Segments to meter for a sent text: the provider's count when it gave one, else counted from the body. */
function billedSegments(result: SmsSendResult, body: string): number {
  return result.segments !== undefined && result.segments >= 1
    ? result.segments
    : smsSegments(body);
}

/** The port every SMS goes through. */
export interface SmsProvider {
  readonly name: string;
  send(message: OutgoingSms): Promise<SmsSendResult>;
}

/** The provider refused or failed the send. `permanent` errors are not retried. */
export class SmsSendError extends Error {
  readonly code: string;
  readonly permanent: boolean;
  constructor(message: string, code: string, permanent: boolean) {
    super(message);
    this.name = "SmsSendError";
    this.code = code;
    this.permanent = permanent;
  }
}

/** The number is outside the SMS allow-list (Section 19.8: no real recipients outside production). */
export class SmsRecipientRefusedError extends Error {
  constructor(recipient: string) {
    super(`Recipient ${recipient.slice(0, 4)}… is outside the SMS allow-list`);
    this.name = "SmsRecipientRefusedError";
  }
}

/** Records texts instead of sending them: tests, local development and staging by default. */
export class RecordingSmsProvider implements SmsProvider {
  readonly name = "record";
  readonly sent: OutgoingSms[] = [];
  async send(message: OutgoingSms): Promise<SmsSendResult> {
    this.sent.push(message);
    return { providerMessageId: `recorded-sms-${this.sent.length}` };
  }
}

/** Refuses numbers outside the allow-list before anything reaches the provider. */
export class GuardedSmsProvider implements SmsProvider {
  readonly name: string;
  readonly #inner: SmsProvider;
  readonly #allowed: readonly string[];
  readonly #deliverToAny: boolean;
  constructor(inner: SmsProvider, policy: { allowed: readonly string[]; deliverToAny: boolean }) {
    this.name = inner.name;
    this.#inner = inner;
    this.#allowed = policy.allowed;
    this.#deliverToAny = policy.deliverToAny;
  }
  async send(message: OutgoingSms): Promise<SmsSendResult> {
    if (!this.#deliverToAny && !this.#allowed.includes(message.to))
      throw new SmsRecipientRefusedError(message.to);
    return this.#inner.send(message);
  }
}

/** Twilio error codes a retry cannot fix: invalid or unreachable numbers, opted-out recipients. */
const PERMANENT_TWILIO = new Set([
  "21211",
  "21408",
  "21610",
  "21612",
  "21614",
  "30003",
  "30005",
  "30006",
]);

export interface TwilioOptions {
  readonly accountSid: string;
  readonly authToken: string;
  readonly messagingServiceSid: string;
  /** URL Twilio posts delivery status to (the sms-webhook function). */
  readonly statusCallbackUrl?: string | null;
  readonly fetch?: typeof fetch;
}

function basicAuth(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

/** Twilio's Messages API over fetch, sending from the 10DLC Messaging Service. */
export function twilioSmsProvider(options: TwilioOptions): SmsProvider {
  const doFetch = options.fetch ?? fetch;
  return {
    name: "twilio",
    async send(message) {
      const form = new URLSearchParams({
        To: message.to,
        MessagingServiceSid: options.messagingServiceSid,
        Body: message.body,
      });
      if (options.statusCallbackUrl) form.set("StatusCallback", options.statusCallbackUrl);
      let response: Response;
      try {
        response = await doFetch(`${TWILIO_API}/Accounts/${options.accountSid}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: basicAuth(options.accountSid, options.authToken),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: form.toString(),
        });
      } catch (error) {
        throw new SmsSendError(
          `Twilio unreachable: ${error instanceof Error ? error.message : String(error)}`,
          "network",
          false,
        );
      }
      const reply = (await response.json().catch(() => ({}))) as {
        sid?: unknown;
        code?: unknown;
        message?: unknown;
        num_segments?: unknown;
      };
      if (response.ok && typeof reply.sid === "string") {
        // A Messaging Service may answer before it has split the text ("0"); the sender then counts it.
        const segments = Number.parseInt(String(reply.num_segments ?? ""), 10);
        return Number.isInteger(segments) && segments >= 1
          ? { providerMessageId: reply.sid, segments }
          : { providerMessageId: reply.sid };
      }
      const code = reply.code === undefined ? String(response.status) : String(reply.code);
      const text = typeof reply.message === "string" ? reply.message : `HTTP ${response.status}`;
      throw new SmsSendError(
        `Twilio refused the message (${code}): ${text}`,
        code,
        PERMANENT_TWILIO.has(code),
      );
    },
  };
}

const sid = (prefix: string) => new RegExp(`^${prefix}[0-9a-f]{32}$`);

export const smsEnvSchema = z
  .object({
    XOS_SMS_TRANSPORT: z.enum(["record", "twilio"]).default("record"),
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(sid("AC"), "TWILIO_ACCOUNT_SID is AC followed by 32 hex digits")
      .optional(),
    TWILIO_AUTH_TOKEN: z
      .string()
      .regex(/^[0-9a-f]{32}$/, "TWILIO_AUTH_TOKEN is 32 hex digits")
      .optional(),
    TWILIO_MESSAGING_SERVICE_SID: z
      .string()
      .regex(sid("MG"), "TWILIO_MESSAGING_SERVICE_SID is MG followed by 32 hex digits")
      .optional(),
    XOS_SMS_ALLOWLIST: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((e) => e.trim())
          .filter((e) => e.length > 0),
      ),
    XOS_SMS_DELIVER_TO_ANY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Where HELP replies send people: a support mailbox or page (an owner input, Section 14.5). */
    XOS_SMS_HELP_CONTACT: z.string().trim().min(3).max(80).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.XOS_SMS_TRANSPORT !== "twilio") return;
    for (const name of [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_MESSAGING_SERVICE_SID",
      "XOS_SMS_HELP_CONTACT",
    ] as const) {
      if (env[name] === undefined)
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required for the twilio transport`,
        });
    }
  });
export type SmsEnv = z.output<typeof smsEnvSchema>;

/** Parses the SMS environment, naming each bad variable without echoing its value. */
export function readSmsEnv(source: Readonly<Record<string, string | undefined>>): SmsEnv {
  const parsed = smsEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid SMS environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** The provider the environment asks for: Twilio behind the allow-list, or recording. */
export function createSmsProvider(
  env: SmsEnv,
  options: { statusCallbackUrl?: string | null; fetch?: typeof fetch } = {},
): SmsProvider {
  if (
    env.XOS_SMS_TRANSPORT !== "twilio" ||
    !env.TWILIO_ACCOUNT_SID ||
    !env.TWILIO_AUTH_TOKEN ||
    !env.TWILIO_MESSAGING_SERVICE_SID
  )
    return new RecordingSmsProvider();
  return new GuardedSmsProvider(
    twilioSmsProvider({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      statusCallbackUrl: options.statusCallbackUrl ?? null,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    { allowed: env.XOS_SMS_ALLOWLIST, deliverToAny: env.XOS_SMS_DELIVER_TO_ANY },
  );
}

// Dispatch -------------------------------------------------------------------------------------------

/** What the SMS sender needs from the database. */
export interface SmsStore {
  claimSms(limit: number): Promise<readonly ClaimedSms[]>;
  /** The recipient as an org writes to them: their name, its language for them and their time zone. */
  recipient(personId: string, orgId: string): Promise<Recipient>;
  orgName(orgId: string): Promise<string>;
  /** Link that opens the notification, kept short for the text. */
  linkFor(claim: ClaimedSms): Promise<string>;
  /** Records the outcome; a sent text counts its billed segments toward usage (1393). */
  record(
    deliveryId: string,
    outcome: DeliveryOutcome,
    providerMessageId: string | null,
    error: string | null,
    segments?: number,
  ): Promise<void>;
}

/** The text of one SMS: the org, the kind's body, the link and the opt-out line (10DLC). */
export async function smsBody(claim: ClaimedSms, store: SmsStore): Promise<string> {
  const recipient = await store.recipient(claim.recipientPersonId, claim.orgId);
  const locale = localeOf(recipient.locale);
  const text = notificationText(claim.kind, claim.messageArgs, locale, recipient.timeZone);
  return formatMessage(locale, "sms.message", {
    orgName: clip(await store.orgName(claim.orgId), 40),
    body: clip(text.body, 300),
    url: await store.linkFor(claim),
  });
}

export interface SmsDispatchSummary {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
  readonly bounced: number;
}

/**
 * Sends claimed SMS deliveries and records each outcome: Sent with Twilio's message SID and the segments the
 * text is billed as, Bounced for an error a retry cannot fix (an invalid or opted-out number), Failed
 * otherwise, which retries with backoff.
 */
export async function dispatchSms(
  store: SmsStore,
  provider: SmsProvider,
  limit = 50,
): Promise<SmsDispatchSummary> {
  const claims = await store.claimSms(limit);
  let sent = 0;
  let failed = 0;
  let bounced = 0;
  for (const claim of claims) {
    try {
      const body = await smsBody(claim, store);
      const result = await provider.send({ to: claim.address, body, deliveryId: claim.deliveryId });
      await store.record(
        claim.deliveryId,
        "Sent",
        result.providerMessageId,
        null,
        billedSegments(result, body),
      );
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof SmsSendError && error.permanent;
      await store.record(claim.deliveryId, permanent ? "Bounced" : "Failed", null, message);
      if (permanent) bounced += 1;
      else failed += 1;
    }
  }
  return { attempted: claims.length, sent, failed, bounced };
}

// Summaries of texts held by quiet hours (ADR 0033 decision 35) -----------------------------------------------

/** The held texts of one member in one org, claimed from app.claim_sms_summaries. */
export interface ClaimedSmsSummary {
  readonly orgId: string;
  readonly recipientPersonId: string;
  readonly address: string;
  /** Every held delivery the summary settles. */
  readonly deliveryIds: readonly string[];
  readonly heldCount: number;
  /** The most important held text: an urgent category first, then the latest. */
  readonly kind: string;
  readonly messageArgs: Readonly<Record<string, unknown>>;
}

/** What the summary sender needs from the database. */
export interface SmsSummaryStore {
  claimSummaries(limit: number): Promise<readonly ClaimedSmsSummary[]>;
  /** The recipient as an org writes to them: their name, its language for them and their time zone. */
  recipient(personId: string, orgId: string): Promise<Recipient>;
  orgName(orgId: string): Promise<string>;
  /** The org's Inbox, where every held notification waits. */
  inboxLink(orgId: string): Promise<string>;
  /** Records the outcome for every held delivery; a sent summary counts its billed segments (1393). */
  recordSummary(
    deliveryIds: readonly string[],
    outcome: DeliveryOutcome,
    providerMessageId: string | null,
    error: string | null,
    segments?: number,
  ): Promise<void>;
}

/**
 * The text of a summary: one held text reads like any notification; several read as the count and the most
 * important one, with the Inbox link and the opt-out line (catalog `email.sms.summary`). When the most
 * important text cannot render, several held texts still go out as the count alone (`email.sms.summaryCount`),
 * so one bad text never sinks the texts held with it.
 */
export async function smsSummaryBody(
  summary: ClaimedSmsSummary,
  store: SmsSummaryStore,
): Promise<string> {
  const recipient = await store.recipient(summary.recipientPersonId, summary.orgId);
  const locale = localeOf(recipient.locale);
  const args = {
    orgName: clip(await store.orgName(summary.orgId), 40),
    url: await store.inboxLink(summary.orgId),
  };
  if (summary.heldCount <= 1) {
    const text = notificationText(summary.kind, summary.messageArgs, locale, recipient.timeZone);
    return formatMessage(locale, "sms.message", { ...args, body: clip(text.body, 300) });
  }
  let body: string;
  try {
    body = notificationText(summary.kind, summary.messageArgs, locale, recipient.timeZone).body;
  } catch {
    return formatMessage(locale, "sms.summaryCount", { ...args, count: summary.heldCount });
  }
  return formatMessage(locale, "sms.summary", {
    ...args,
    count: summary.heldCount,
    body: clip(body, 200),
  });
}

/**
 * Sends one text per member and org whose quiet hours ended, settling every held delivery with its outcome:
 * Sent, Bounced for an error a retry cannot fix, Failed otherwise (the summary retries with backoff).
 */
export async function dispatchSmsSummaries(
  store: SmsSummaryStore,
  provider: SmsProvider,
  limit = 50,
): Promise<SmsDispatchSummary> {
  const summaries = await store.claimSummaries(limit);
  let sent = 0;
  let failed = 0;
  let bounced = 0;
  for (const summary of summaries) {
    try {
      const body = await smsSummaryBody(summary, store);
      const result = await provider.send({
        to: summary.address,
        body,
        deliveryId: summary.deliveryIds[0] ?? "",
      });
      await store.recordSummary(
        summary.deliveryIds,
        "Sent",
        result.providerMessageId,
        null,
        billedSegments(result, body),
      );
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof SmsSendError && error.permanent;
      await store.recordSummary(
        summary.deliveryIds,
        permanent ? "Bounced" : "Failed",
        null,
        message,
      );
      if (permanent) bounced += 1;
      else failed += 1;
    }
  }
  return { attempted: summaries.length, sent, failed, bounced };
}

// Inbound: keywords, signatures and status callbacks ------------------------------------------------------

export type SmsKeywordAction = "Opt Out" | "Opt In" | "Help";

/** Twilio's standard opt-out, opt-in and help keywords (10DLC), matched on the whole trimmed message. */
const KEYWORDS: Readonly<Record<string, SmsKeywordAction>> = {
  STOP: "Opt Out",
  STOPALL: "Opt Out",
  UNSUBSCRIBE: "Opt Out",
  CANCEL: "Opt Out",
  END: "Opt Out",
  QUIT: "Opt Out",
  REVOKE: "Opt Out",
  OPTOUT: "Opt Out",
  START: "Opt In",
  YES: "Opt In",
  UNSTOP: "Opt In",
  HELP: "Help",
  INFO: "Help",
};

/** The keyword an inbound message carries, or null for any other text. */
export function smsKeyword(body: string): { action: SmsKeywordAction; keyword: string } | null {
  const word = body
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  const action = KEYWORDS[word];
  return action === undefined ? null : { action, keyword: word };
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Twilio's request signature: base64 HMAC-SHA1, keyed with the auth token, of the full webhook URL
 * followed by every POST parameter name and value, sorted by name.
 */
export async function twilioSignature(
  url: string,
  params: Readonly<Record<string, string>>,
  authToken: string,
): Promise<string> {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ""), url);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return toBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the X-Twilio-Signature header matches the request. */
export async function verifyTwilioSignature(
  url: string,
  params: Readonly<Record<string, string>>,
  signature: string | null,
  authToken: string,
): Promise<boolean> {
  if (!signature) return false;
  return constantTimeEqual(await twilioSignature(url, params, authToken), signature);
}

/** What the webhook writes. */
export interface SmsInboundStore {
  recordKeyword(phoneE164: string, action: SmsKeywordAction, keyword: string): Promise<number>;
  recordStatus(providerMessageId: string, status: string, error: string | null): Promise<boolean>;
}

export interface TwilioWebhookRequest {
  /** The public URL Twilio posted to, exactly as configured in Twilio. */
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
  readonly signature: string | null;
}

export interface WebhookResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function twiml(reply: string | null): WebhookResponse {
  const inner = reply === null ? "" : `<Message>${escapeXml(reply)}</Message>`;
  return {
    status: 200,
    contentType: "text/xml",
    body: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
  };
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Handles one Twilio webhook: refuses a bad signature (403); records a status callback (MessageStatus);
 * records STOP, START and HELP from an inbound message and answers with the catalog's reply (TwiML).
 * Any other inbound text gets no reply: notifications take no SMS replies.
 */
export async function handleTwilioWebhook(
  request: TwilioWebhookRequest,
  store: SmsInboundStore,
  options: { readonly authToken: string; readonly helpContact: string },
): Promise<WebhookResponse> {
  if (
    !(await verifyTwilioSignature(
      request.url,
      request.params,
      request.signature,
      options.authToken,
    ))
  ) {
    return { status: 403, contentType: "text/plain", body: "Forbidden" };
  }
  const p = request.params;
  const status = p["MessageStatus"];
  if (status !== undefined && p["MessageSid"] !== undefined && p["Body"] === undefined) {
    const error = p["ErrorCode"] ? `${p["ErrorCode"]} ${p["ErrorMessage"] ?? ""}`.trim() : null;
    await store.recordStatus(p["MessageSid"], status, error);
    return { status: 204, contentType: "text/plain", body: "" };
  }
  const from = p["From"] ?? "";
  const keyword = smsKeyword(p["Body"] ?? "");
  if (keyword === null || !E164.test(from)) return twiml(null);
  await store.recordKeyword(from, keyword.action, keyword.keyword);
  const key =
    keyword.action === "Opt Out"
      ? "sms.stop"
      : keyword.action === "Opt In"
        ? "sms.start"
        : "sms.help";
  return twiml(formatMessage("en-US", key, { helpContact: options.helpContact }));
}
