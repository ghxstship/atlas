/**
 * Inbound mail (Section 4.6.5). The mail provider verifies DKIM and posts a parsed message (or, for Resend, the
 * inbound-email function reads it from Resend's API, ./resend.ts); this module strips quoted text and hands the
 * result to app.receive_inbound_email, which files project inbox mail and accepts replies only from signed addresses.
 */

const QUOTE_MARKERS: readonly RegExp[] = [
  /^On .{1,200} wrote:\s*$/i,
  /^El .{1,200} escribió:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Mensaje original\s*-{2,}\s*$/i,
  /^From:\s.+$/i,
  /^De:\s.+$/i,
  /^_{10,}\s*$/,
];

/** The reply above the first quote marker, without quoted lines or the trailing signature separator. */
export function stripQuotedText(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (QUOTE_MARKERS.some((marker) => marker.test(line.trim()))) break;
    if (line.trimStart().startsWith(">")) continue;
    if (line === "-- ") break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Lowercased local part of the first recipient on the inbound domain, or null. */
export function localPartFor(recipients: readonly string[], inboundDomain: string): string | null {
  const domain = inboundDomain.toLowerCase();
  for (const recipient of recipients) {
    const address = (/<([^>]+)>/.exec(recipient)?.[1] ?? recipient).trim().toLowerCase();
    const at = address.lastIndexOf("@");
    if (at > 0 && address.slice(at + 1) === domain) return postgresText(address.slice(0, at));
  }
  return null;
}

/** A parsed inbound message, as the mail provider delivers it after DKIM evaluation. */
export interface InboundMessage {
  readonly to: readonly string[];
  readonly from: string;
  readonly subject: string;
  readonly messageId: string;
  readonly dkimPass: boolean;
  readonly text: string;
  readonly rawObjectPath: string;
}

export interface InboundStore {
  receive(input: {
    readonly localPart: string;
    readonly from: string;
    readonly subject: string;
    readonly messageId: string;
    readonly dkimVerified: boolean;
    readonly bodyText: string;
    readonly rawObjectPath: string;
  }): Promise<string | null>;
}

/** The longest body app.inbound_messages keeps (inbound_messages_body_length). */
export const MAX_INBOUND_BODY_CHARS = 100_000;
/** The longest Message-ID kept as sent, in UTF-8 bytes: RFC 5322's line limit, well inside a btree index entry. */
export const MAX_MESSAGE_ID_BYTES = 998;

/** The first `max` characters, counted as Postgres's char_length does, so no surrogate pair is split. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text).slice(0, max).join("");
}

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Without NUL (text refuses it), and with U+FFFD for an unpaired surrogate (JSON refuses it). */
export function postgresText(text: string): string {
  return text.replaceAll("\u0000", "").replace(UNPAIRED_SURROGATE, "\uFFFD");
}

/** The Message-ID as sent, or past 998 bytes (more than the per-org index holds) a stand-in from its SHA-256. */
export async function inboundMessageId(messageId: string): Promise<string> {
  const id = postgresText(messageId);
  const bytes = new TextEncoder().encode(id);
  if (bytes.byteLength <= MAX_MESSAGE_ID_BYTES) return id;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `<${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}.sha256@message-id.invalid>`;
}

/**
 * Files one inbound message: its id, or null when it was not for XOS or was ignored. Each field is made to fit the row,
 * so a provider never retries a message the database would refuse.
 */
export async function receiveInbound(
  store: InboundStore,
  message: InboundMessage,
  inboundDomain: string,
): Promise<string | null> {
  const localPart = localPartFor(message.to, inboundDomain);
  if (localPart === null) return null;
  const sender = postgresText(message.from);
  const from = (/<([^>]+)>/.exec(sender)?.[1] ?? sender).trim().toLowerCase();
  const fromLength = Array.from(from).length;
  if (fromLength < 3 || fromLength > 320) return null;
  return store.receive({
    localPart,
    from,
    subject: postgresText(message.subject),
    messageId: await inboundMessageId(message.messageId),
    dkimVerified: message.dkimPass,
    bodyText: clip(stripQuotedText(postgresText(message.text)), MAX_INBOUND_BODY_CHARS),
    rawObjectPath: postgresText(message.rawObjectPath),
  });
}
