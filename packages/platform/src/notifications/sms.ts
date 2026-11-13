import { z } from "zod";
import { clip, loadNotificationCopy, localeOf, notificationText } from "./copy.ts";
import type { DeliveryOutcome, Recipient } from "./dispatch.ts";

/**
 * SMS, text and WhatsApp through sent.dm (owner decision 2026-11-11; Section 5, Section 14.5 TCPA and 10DLC, finding
 * A65-012), behind the SmsProvider port so tests and local runs never reach the network. The database decides who
 * may be texted: app.claim_notification_deliveries hands over only numbers that are verified, have recorded consent
 * in the org, are not suppressed, and are outside quiet hours in the recipient's time zone. sent.dm is called over
 * its REST API with fetch, which runs unchanged in Node and the Deno Edge runtime: its SDK would add a dependency
 * tree for one POST and one HMAC.
 *
 * The inbound webhook (sms-webhook) verifies sent.dm's Standard Webhooks signature, records STOP, START and HELP
 * from message.received through app.record_sms_keyword (the existing STOP suppression reason), and records
 * delivery events through app.record_sms_status. sent.dm answers the keywords itself with the auto-replies the
 * owner sets from smsAutoReplies, so the webhook sends no reply.
 */

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
/** Typographic characters sent as their GSM look-alikes (smartEncode), so they never force UCS-2. */
const SMART_ENCODING: Readonly<Record<string, string>> = {
  "\u2026": "...", // ellipsis
  "\u2018": "'", // curly single quotes
  "\u2019": "'",
  "\u201c": '"', // curly double quotes
  "\u201d": '"',
  "\u2013": "-", // en dash
  // The em dash, built from its code point because the finish guard keeps the literal out of the source and bundle.
  [String.fromCharCode(0x2014)]: "-",
  "\u00a0": " ", // no-break space
  "\u2009": " ", // thin space
  "\u202f": " ", // narrow no-break space
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

/** sent.dm's v3 API (https://docs.sent.dm/start/guides/sending-messages). */
export const SENTDM_API = "https://api.sent.dm/v3";

/**
 * sent.dm error codes a retry cannot fix (https://docs.sent.dm/reference/api/error-catalog): an opted-out or
 * suppressed recipient, and CONFLICT_005, a reused idempotency key whose first request succeeded (only 2xx answers
 * are cached), so the text already went out and a retry must not send it again. Every VALIDATION_ code is permanent
 * too: the same request is refused the same way.
 */
const PERMANENT_SENTDM = new Set(["BUSINESS_004", "CONFLICT_005"]);

function permanentSentdm(code: string, httpStatus: number): boolean {
  return PERMANENT_SENTDM.has(code) || code.startsWith("VALIDATION_") || httpStatus === 422;
}

/** The channel a text goes out on: SMS by default; WhatsApp needs approved WhatsApp templates; auto lets sent.dm pick. */
export type SentdmChannel = "sms" | "whatsapp" | "auto";

/**
 * The opt-out sentence every rendered text ends with, per language (packages/i18n/messages/<locale>/email.json,
 * `sms.message`, `sms.summary` and `sms.summaryCount`; a test holds the catalogs to these). Hardcoded rather than
 * read from the catalog so the sender stays free of i18n at run time.
 */
export const SMS_STOP_EN = "Reply STOP to opt out.";
export const SMS_STOP_ES = "Responde STOP para cancelar.";

/**
 * What the default templates put before the variable: `[XOS] {{message}} <STOP sentence>`. Used only to count the
 * segments of the text as delivered.
 */
export const SENTDM_TEMPLATE_PREFIX = "[XOS] ";

export interface SentdmOptions {
  readonly apiKey: string;
  /**
   * The approved English sent.dm template business-initiated texts go out on (by name, or by id when it is a UUID).
   * sent.dm blocks free-form text to a contact who has never replied (CONVERSATION_TEMPLATE_REQUIRED), and most XOS
   * texts start a conversation, so every text uses a template. sent.dm refuses a template whose variable is at the
   * very start or end of its body, so the template carries the opt-out line itself:
   * `[XOS] {{message}} Reply STOP to opt out.` The variable carries the rendered body without that line.
   */
  readonly template: string;
  /**
   * The approved Spanish template (name or UUID), `[XOS] {{message}} Responde STOP para cancelar.`: a body that
   * ends with SMS_STOP_ES goes out on it, without that sentence.
   */
  readonly templateEs: string;
  /** The variable that holds the body, the same in both templates. */
  readonly templateVariable: string;
  readonly channel: SentdmChannel;
  /** Validate and simulate only (sent.dm sandbox mode): staging and tests. */
  readonly sandbox?: boolean;
  readonly fetch?: typeof fetch;
}

/** Smart typography swapped for its GSM look-alikes, so a text stays GSM-7 (sent.dm sends characters as given). */
export function smartEncode(body: string): string {
  return [...body].map((c) => SMART_ENCODING[c] ?? c).join("");
}

/**
 * A template variable value as sent.dm takes it (VALIDATION_008): no line breaks or tabs and no run of more than
 * four spaces.
 */
export function templateValue(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {5,}/g, "    ")
    .trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The template a cleaned body goes out on and the value of its variable: a body ending with the Spanish opt-out
 * sentence goes on the Spanish template and one ending with the English sentence on the English template, each
 * without that sentence, because the template adds it. Any other body goes on the English template unchanged, so
 * the template's opt-out line is the only one.
 */
function sentdmTemplate(
  body: string,
  options: Pick<SentdmOptions, "template" | "templateEs">,
): { readonly template: string; readonly value: string; readonly stop: string } {
  for (const [stop, template] of [
    [SMS_STOP_ES, options.templateEs],
    [SMS_STOP_EN, options.template],
  ] as const) {
    if (body.endsWith(stop) && body.length > stop.length) {
      return { template, value: body.slice(0, -stop.length).trimEnd(), stop };
    }
  }
  return { template: options.template, value: body, stop: SMS_STOP_EN };
}

/**
 * sent.dm's Messages API over fetch (POST /v3/messages, x-api-key). Each delivery sends with the Idempotency-Key
 * `xos-sms-<delivery id>`: a retry after a timeout replays the first answer instead of texting twice, and an error
 * is not cached, so a retry after one sends again.
 */
export function sentdmSmsProvider(options: SentdmOptions): SmsProvider {
  const doFetch = options.fetch ?? fetch;
  return {
    name: "sentdm",
    async send(message) {
      const {
        template: chosen,
        value,
        stop,
      } = sentdmTemplate(templateValue(smartEncode(message.body)), options);
      const parameters = { [options.templateVariable]: value };
      const template = UUID.test(chosen)
        ? { id: chosen, parameters }
        : { name: chosen, parameters };
      const request = {
        to: [message.to],
        template,
        ...(options.channel === "auto" ? {} : { channel: [options.channel] }),
        ...(options.sandbox ? { sandbox: true } : {}),
      };
      let response: Response;
      try {
        response = await doFetch(`${SENTDM_API}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": options.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": `xos-sms-${message.deliveryId}`.replace(/[^A-Za-z0-9_-]/g, "-"),
          },
          body: JSON.stringify(request),
        });
      } catch (error) {
        throw new SmsSendError(
          `sent.dm unreachable: ${error instanceof Error ? error.message : String(error)}`,
          "network",
          false,
        );
      }
      const reply = (await response.json().catch(() => ({}))) as {
        success?: unknown;
        data?: { recipients?: readonly { message_id?: unknown }[] } | null;
        error?: { code?: unknown; message?: unknown } | null;
      };
      const messageId = reply.data?.recipients?.[0]?.message_id;
      if (response.ok && reply.success !== false && typeof messageId === "string") {
        // Billed as delivered: the template's prefix and opt-out line around the value.
        return {
          providerMessageId: messageId,
          segments: smsSegments(`${SENTDM_TEMPLATE_PREFIX}${value} ${stop}`),
        };
      }
      const code =
        typeof reply.error?.code === "string" ? reply.error.code : String(response.status);
      const text =
        typeof reply.error?.message === "string" ? reply.error.message : `HTTP ${response.status}`;
      throw new SmsSendError(
        `sent.dm refused the message (${code}): ${text}`,
        code,
        permanentSentdm(code, response.status),
      );
    },
  };
}

/** A sent.dm webhook signing secret: whsec_ and the base64 key (https://docs.sent.dm/build/signature-verification). */
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

export const smsEnvSchema = z
  .object({
    XOS_SMS_TRANSPORT: z.enum(["record", "sentdm"]).default("record"),
    SENT_DM_API_KEY: z.string().trim().min(16, "SENT_DM_API_KEY looks too short").optional(),
    SENT_DM_WEBHOOK_SECRET: z
      .string()
      .regex(WEBHOOK_SECRET, "SENT_DM_WEBHOOK_SECRET is whsec_ followed by the base64 key")
      .optional(),
    /**
     * The approved English and Spanish templates texts go out on (name or id), and the variable both use; see
     * SentdmOptions.template and SentdmOptions.templateEs.
     */
    XOS_SENTDM_TEMPLATE: z.string().trim().min(1).max(128).default("xos_notification"),
    XOS_SENTDM_TEMPLATE_ES: z.string().trim().min(1).max(128).default("xos_notification_es"),
    XOS_SENTDM_TEMPLATE_VARIABLE: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "XOS_SENTDM_TEMPLATE_VARIABLE is a variable name")
      .default("message"),
    XOS_SENTDM_CHANNEL: z.enum(["sms", "whatsapp", "auto"]).default("sms"),
    XOS_SENTDM_SANDBOX: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
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
    /**
     * Where HELP sends people: a support mailbox or page (an owner input, Section 14.5). sent.dm answers HELP, STOP
     * and START itself; the owner pastes smsAutoReplies' texts into its auto-replies.
     */
    XOS_SMS_HELP_CONTACT: z.string().trim().min(3).max(80).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.XOS_SMS_TRANSPORT !== "sentdm") return;
    for (const name of ["SENT_DM_API_KEY", "XOS_SMS_HELP_CONTACT"] as const) {
      if (env[name] === undefined)
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required for the sentdm transport`,
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

/** The provider the environment asks for: sent.dm behind the allow-list, or recording. */
export function createSmsProvider(
  env: SmsEnv,
  options: { fetch?: typeof fetch } = {},
): SmsProvider {
  if (env.XOS_SMS_TRANSPORT !== "sentdm" || !env.SENT_DM_API_KEY) return new RecordingSmsProvider();
  return new GuardedSmsProvider(
    sentdmSmsProvider({
      apiKey: env.SENT_DM_API_KEY,
      template: env.XOS_SENTDM_TEMPLATE,
      templateEs: env.XOS_SENTDM_TEMPLATE_ES,
      templateVariable: env.XOS_SENTDM_TEMPLATE_VARIABLE,
      channel: env.XOS_SENTDM_CHANNEL,
      sandbox: env.XOS_SENTDM_SANDBOX,
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
  /**
   * Who a text names as its sender (A138): XOS for the platform's own notices, else the org's brand name while white
   * label is in force, else its name.
   */
  senderName(orgId: string, kind: string): Promise<string>;
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
  const formatMessage = await loadNotificationCopy();
  const recipient = await store.recipient(claim.recipientPersonId, claim.orgId);
  const locale = localeOf(recipient.locale);
  const text = notificationText(claim.kind, claim.messageArgs, locale, recipient.timeZone);
  return formatMessage(locale, "sms.message", {
    orgName: clip(await store.senderName(claim.orgId, claim.kind), 40),
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
 * Sends claimed SMS deliveries and records each outcome: Sent with sent.dm's message id and the segments the
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
  /** Who the summary names as its sender, after its most important text's kind (SmsStore.senderName). */
  senderName(orgId: string, kind: string): Promise<string>;
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
  const formatMessage = await loadNotificationCopy();
  const recipient = await store.recipient(summary.recipientPersonId, summary.orgId);
  const locale = localeOf(recipient.locale);
  const args = {
    orgName: clip(await store.senderName(summary.orgId, summary.kind), 40),
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

// eslint-disable-next-line xos/no-restated-enums -- below @xos/data; test/database-enums.test.ts holds it equal
export type SmsKeywordAction = "Opt Out" | "Opt In" | "Help";

/**
 * The standard opt-out, opt-in and help keywords (10DLC), matched as sent.dm matches them: the whole trimmed message,
 * case-insensitively (https://docs.sent.dm/start/guides/opt-out-and-consent).
 */
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
  SUBSCRIBE: "Opt In",
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

/**
 * The texts the owner sets as sent.dm's HELP, STOP and START auto-replies (Compliance in the sent.dm dashboard), in
 * each language XOS writes: sent.dm answers the keywords, so XOS no longer replies itself.
 */
export async function smsAutoReplies(
  helpContact: string,
): Promise<Readonly<Record<"en-US" | "es-US", { help: string; stop: string; start: string }>>> {
  const formatMessage = await loadNotificationCopy();
  const replies = (locale: "en-US" | "es-US") => ({
    help: formatMessage(locale, "sms.help", { helpContact }),
    stop: formatMessage(locale, "sms.stop", {}),
    start: formatMessage(locale, "sms.start", {}),
  });
  return { "en-US": replies("en-US"), "es-US": replies("es-US") };
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * sent.dm's webhook signature (Standard Webhooks; https://docs.sent.dm/build/signature-verification): `v1,` and the
 * base64 HMAC-SHA256 of `<webhook id>.<timestamp>.<raw body>`, keyed with the secret's base64 key after `whsec_`.
 */
export async function sentdmSignature(
  webhookId: string,
  timestamp: string,
  rawBody: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${webhookId}.${timestamp}.${rawBody}`),
  );
  return `v1,${toBase64(mac)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** sent.dm signs each attempt when it sends it, and asks receivers to refuse anything older than five minutes. */
export const SENTDM_REPLAY_WINDOW_SECONDS = 300;

/**
 * True when a signature in the header (space separated; any one may match) is sent.dm's for this request, and its
 * timestamp is within the replay window of now.
 */
export async function verifySentdmSignature(
  headers: SentdmWebhookHeaders,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SENTDM_REPLAY_WINDOW_SECONDS) return false;
  let expected: string;
  try {
    expected = await sentdmSignature(id, timestamp, rawBody, secret);
  } catch {
    return false;
  }
  let match = false;
  for (const candidate of signature.split(" ")) {
    if (constantTimeEqual(candidate.trim(), expected)) match = true;
  }
  return match;
}

/** What the webhook writes. */
export interface SmsInboundStore {
  recordKeyword(phoneE164: string, action: SmsKeywordAction, keyword: string): Promise<number>;
  recordStatus(providerMessageId: string, status: string, error: string | null): Promise<boolean>;
}

/**
 * The signing headers: version 2 webhooks send webhook-id, webhook-timestamp and webhook-signature; version 1 sends
 * x-webhook-id, x-webhook-timestamp and x-webhook-signature.
 */
export interface SentdmWebhookHeaders {
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
}

/** Reads the signing headers of either webhook version. */
export function sentdmHeaders(get: (name: string) => string | null): SentdmWebhookHeaders {
  return {
    id: get("webhook-id") ?? get("x-webhook-id"),
    timestamp: get("webhook-timestamp") ?? get("x-webhook-timestamp"),
    signature: get("webhook-signature") ?? get("x-webhook-signature"),
  };
}

export interface SentdmWebhookRequest {
  readonly headers: SentdmWebhookHeaders;
  /** The body exactly as received: the signature covers its bytes. */
  readonly rawBody: string;
}

export interface WebhookResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * The delivery status app.record_sms_status takes for a sent.dm status: delivered (also read, WhatsApp and RCS), or
 * failed for a message that will not arrive (failed, filtered, blocked, cancelled). Statuses on the way (queued,
 * routed, sent, scheduled) change nothing.
 */
export function smsDeliveryStatus(messageStatus: string): "delivered" | "failed" | null {
  switch (messageStatus.toUpperCase()) {
    case "DELIVERED":
    case "READ":
      return "delivered";
    case "FAILED":
    case "FILTERED":
    case "BLOCKED":
    case "CANCELLED":
      return "failed";
    default:
      return null;
  }
}

interface SentdmEvent {
  readonly event?: unknown;
  readonly payload?: {
    readonly message_id?: unknown;
    readonly message_status?: unknown;
    readonly reason_code?: unknown;
    readonly reason?: unknown;
    readonly inbound_number?: unknown;
    readonly text?: unknown;
    readonly from?: unknown;
    readonly source?: unknown;
  } | null;
}

const NO_CONTENT: WebhookResponse = { status: 204, contentType: "text/plain", body: "" };

/**
 * Handles one sent.dm webhook: refuses a bad or stale signature (401). Records a delivery event (message.*) by its
 * message id; records STOP, START and HELP from an inbound message (message.received) on the sender's number; and
 * records an opt-out or opt-in the network reported (contact.opt_out and contact.opt_in with source PROVIDER_SIGNAL;
 * a keyword's own event is message.received, so it is not counted twice). sent.dm sends the replies. Every other
 * event is acknowledged and ignored. Retries of one event share its webhook id; both writes are idempotent for a
 * repeated event (a status only moves forward, and a keyword sets the same suppression).
 */
export async function handleSentdmWebhook(
  request: SentdmWebhookRequest,
  store: SmsInboundStore,
  options: { readonly webhookSecret: string; readonly nowSeconds?: number },
): Promise<WebhookResponse> {
  if (
    !(await verifySentdmSignature(
      request.headers,
      request.rawBody,
      options.webhookSecret,
      options.nowSeconds,
    ))
  ) {
    return { status: 401, contentType: "text/plain", body: "Unauthorized" };
  }
  let event: SentdmEvent;
  try {
    event = JSON.parse(request.rawBody) as SentdmEvent;
  } catch {
    return { status: 400, contentType: "text/plain", body: "Bad Request" };
  }
  const name = typeof event.event === "string" ? event.event : "";
  const p = event.payload ?? {};
  if (name === "message.received") {
    const from = typeof p.inbound_number === "string" ? p.inbound_number : "";
    const keyword = smsKeyword(typeof p.text === "string" ? p.text : "");
    if (keyword !== null && E164.test(from))
      await store.recordKeyword(from, keyword.action, keyword.keyword);
    return NO_CONTENT;
  }
  if (name === "contact.opt_out" || name === "contact.opt_in") {
    const from = typeof p.from === "string" ? p.from : "";
    if (p.source === "PROVIDER_SIGNAL" && E164.test(from))
      await store.recordKeyword(
        from,
        name === "contact.opt_out" ? "Opt Out" : "Opt In",
        "PROVIDER_SIGNAL",
      );
    return NO_CONTENT;
  }
  if (name.startsWith("message.") && typeof p.message_id === "string") {
    const status = smsDeliveryStatus(typeof p.message_status === "string" ? p.message_status : "");
    if (status !== null) {
      const code = typeof p.reason_code === "string" ? p.reason_code : "";
      const reason = typeof p.reason === "string" ? p.reason : "";
      const error = status === "failed" ? `${code} ${reason}`.trim() || null : null;
      await store.recordStatus(p.message_id, status, error);
    }
    return NO_CONTENT;
  }
  return NO_CONTENT;
}
