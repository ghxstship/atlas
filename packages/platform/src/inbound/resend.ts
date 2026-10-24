/**
 * Resend's inbound mail (ADR 0033, decision 60; ADR 0040): a Svix-signed `email.received` event with metadata only.
 * The message is read from the Receiving API (full-access key), its DKIM verdict is Resend's own, its raw file goes to
 * the inbound-mail bucket (Resend keeps mail 30 days), and it is filed through receiveInbound like any parsed message.
 */
import { z } from "zod";
import type { PlatformDb } from "../stores.ts";
import type { FetchLike } from "../webhooks/dispatch.ts";
import { localPartFor, receiveInbound, type InboundStore } from "./parse.ts";

export const RESEND_API_URL = "https://api.resend.com";
/** The bucket raw messages are kept in (migration 1651); its file size limit is the same 50 MiB. */
export const INBOUND_MAIL_BUCKET = "inbound-mail";
export const MAX_RAW_MESSAGE_BYTES = 52_428_800;
/** Svix's own default: a signature older or newer than five minutes is refused, so a captured request cannot replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface ResendSignatureHeaders {
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when svix-signature holds a `v1,<base64 HMAC-SHA256>` entry, keyed with the secret's base64 bytes after `whsec_`,
 * over `<svix-id>.<svix-timestamp>.<raw body>`, and the timestamp is within the tolerance of now.
 */
export async function verifyResendSignature(
  headers: ResendSignatureHeaders,
  body: string,
  secret: string,
  options: { readonly now?: number; readonly toleranceSeconds?: number } = {},
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS))
    return false;
  const keyBytes = base64Bytes(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
  );
  if (keyBytes === null || keyBytes.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = toBase64(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return signature
    .split(" ")
    .some((entry) => entry.startsWith("v1,") && constantTimeEqual(entry.slice(3), expected));
}

const addresses = z
  .array(z.string())
  .nullish()
  .transform((list) => list ?? []);

/** The `email.received` event: metadata only, with no body, headers or attachment content. */
const receivedEvent = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z.object({
    email_id: z.string().min(1),
    from: z.string().nullish(),
    to: addresses,
    cc: addresses,
    bcc: addresses,
    received_for: addresses,
    message_id: z.string().nullish(),
    subject: z.string().nullish(),
  }),
});

export type ResendReceivedEvent = z.infer<typeof receivedEvent>;

/** A received email from `GET /emails/receiving/{id}`, with only the fields the inbox reads. */
const receivedEmail = z.object({
  id: z.string(),
  from: z.string().min(1),
  to: addresses,
  cc: addresses,
  bcc: addresses,
  received_for: addresses,
  subject: z.string().nullish(),
  text: z.string().nullish(),
  html: z.string().nullish(),
  message_id: z.string().nullish(),
  authentication: z
    .object({ spf: z.string().nullish(), dkim: z.string().nullish(), dmarc: z.string().nullish() })
    .nullish(),
  raw: z.object({ download_url: z.string().min(1), expires_at: z.string().nullish() }).nullish(),
});

export type ResendReceivedEmail = z.infer<typeof receivedEmail>;

/** The event in a verified webhook body, or null when the body is not one. */
export function parseResendEvent(body: string): ResendReceivedEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = receivedEvent.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Text from an HTML-only body: no scripts, styles or quoted blockquotes, block ends as line breaks, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X"))
        return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface RawMailStore {
  put(objectName: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

/** The inbound-mail bucket through the Storage API, replacing an existing object (a redelivery stores the same file). */
export function storageRawMailStore(options: {
  readonly url: string;
  readonly serviceKey: string;
  readonly fetch?: FetchLike;
}): RawMailStore {
  const send = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const base = `${options.url.replace(/\/+$/, "")}/storage/v1/object/${INBOUND_MAIL_BUCKET}`;
  return {
    async put(objectName, bytes) {
      const path = objectName.split("/").map(encodeURIComponent).join("/");
      const response = await send(`${base}/${path}`, {
        method: "POST",
        headers: {
          apikey: options.serviceKey,
          Authorization: `Bearer ${options.serviceKey}`,
          "Content-Type": "message/rfc822",
          "x-upsert": "true",
        },
        body: bytes,
      });
      if (!response.ok) {
        throw new Error(
          `Storing ${objectName} failed: ${response.status} ${await response.text()}`,
        );
      }
    },
  };
}

/** Whether a message already records a raw object: a redelivery of mail the database took. */
export interface InboundRawReferences {
  referenced(objectName: string): Promise<boolean>;
}

export function inboundRawReferences(db: PlatformDb): InboundRawReferences {
  return {
    async referenced(objectName) {
      return (
        (await db.selectOne("inbound_messages", "id", { raw_object_path: objectName })) !== null
      );
    },
  };
}

export interface ResendInboundDeps {
  readonly store: InboundStore;
  readonly rawMail: RawMailStore;
  readonly references: InboundRawReferences;
  /** A full-access Resend API key. */
  readonly apiKey: string;
  readonly inboundDomain: string;
  readonly fetch?: FetchLike;
}

export type ResendInboundOutcome =
  | { readonly status: "ignored"; readonly reason: "event-type" | "not-for-inbound-domain" }
  | {
      readonly status: "received";
      readonly inboundMessageId: string | null;
      readonly rawObjectPath: string;
    };

/** The received email from the Receiving API; a failure throws, so the webhook answers 500 and Resend retries. */
export async function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
  send: FetchLike,
): Promise<ResendReceivedEmail> {
  const response = await send(`${RESEND_API_URL}/emails/receiving/${encodeURIComponent(emailId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Resend answered ${response.status} for received email ${emailId}`);
  }
  return receivedEmail.parse(await response.json());
}

/** The raw message from its https URL, or null when it is over the bucket's 50 MiB limit. */
async function downloadRaw(url: string, send: FetchLike): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!url.startsWith("https://")) throw new Error("Resend's raw message URL is not https");
  const response = await send(url, { method: "GET" });
  if (!response.ok) throw new Error(`The raw message download answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RAW_MESSAGE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > MAX_RAW_MESSAGE_BYTES ? null : bytes;
}

/**
 * Files one `email.received` event; mail for no address on the inbound domain is ignored before any call to Resend.
 * Recipients come from To, Cc, Bcc and forwarded-for; DKIM passes only on Resend's `pass`. The raw file, recorded as
 * `resend/<id>.eml` (`resend:<id>` over 50 MiB), is stored only for mail the database took, now or on an earlier
 * delivery, so spam to an address with no inbox leaves nothing in storage.
 */
export async function receiveResendEmail(
  event: ResendReceivedEvent,
  deps: ResendInboundDeps,
): Promise<ResendInboundOutcome> {
  if (event.type !== "email.received") return { status: "ignored", reason: "event-type" };
  const send = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const listed = [
    ...event.data.to,
    ...event.data.cc,
    ...event.data.bcc,
    ...event.data.received_for,
  ];
  if (localPartFor(listed, deps.inboundDomain) === null) {
    return { status: "ignored", reason: "not-for-inbound-domain" };
  }

  const email = await fetchReceivedEmail(event.data.email_id, deps.apiKey, send);
  const raw = email.raw ? await downloadRaw(email.raw.download_url, send) : null;
  const rawObjectPath = raw === null ? `resend:${email.id}` : `resend/${email.id}.eml`;

  const recipients = [
    ...new Set([...email.to, ...email.cc, ...email.bcc, ...email.received_for, ...listed]),
  ];
  const messageId = email.message_id || event.data.message_id || `<${email.id}@resend>`;
  const inboundMessageId = await receiveInbound(
    deps.store,
    {
      to: recipients,
      from: email.from,
      subject: email.subject || event.data.subject || "",
      messageId,
      dkimPass: email.authentication?.dkim === "pass",
      text: email.text || (email.html ? htmlToText(email.html) : ""),
      rawObjectPath,
    },
    deps.inboundDomain,
  );
  if (
    raw !== null &&
    (inboundMessageId !== null || (await deps.references.referenced(rawObjectPath)))
  ) {
    await deps.rawMail.put(rawObjectPath, raw);
  }
  return { status: "received", inboundMessageId, rawObjectPath };
}
