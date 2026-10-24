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
    if (at > 0 && address.slice(at + 1) === domain) return address.slice(0, at);
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

/** The first `max` characters, counted as Postgres's char_length does, so no surrogate pair is split. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text).slice(0, max).join("");
}

/**
 * Files one inbound message. Returns the inbound message id, or null when it was not for XOS or was ignored. A sender
 * address no mailbox can have (under 3 or over 320 characters) is ignored, and a body over 100,000 characters is cut,
 * so the row always fits and a provider never retries a message the database would refuse.
 */
export async function receiveInbound(
  store: InboundStore,
  message: InboundMessage,
  inboundDomain: string,
): Promise<string | null> {
  const localPart = localPartFor(message.to, inboundDomain);
  if (localPart === null) return null;
  const from = (/<([^>]+)>/.exec(message.from)?.[1] ?? message.from).trim().toLowerCase();
  if (from.length < 3 || from.length > 320) return null;
  return store.receive({
    localPart,
    from,
    subject: message.subject,
    messageId: message.messageId,
    dkimVerified: message.dkimPass,
    bodyText: clip(stripQuotedText(message.text), MAX_INBOUND_BODY_CHARS),
    rawObjectPath: message.rawObjectPath,
  });
}
