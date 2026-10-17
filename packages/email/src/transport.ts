import type { CreateEmailOptions, CreateEmailRequestOptions, CreateEmailResponse } from "resend";

/** A rendered email ready for a provider. */
export interface OutgoingEmail {
  readonly from: string;
  readonly to: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly tags?: readonly { readonly name: string; readonly value: string }[];
  /** Provider idempotency key, so a retried send never delivers twice. */
  readonly idempotencyKey?: string;
}

export interface SendResult {
  /** Message id from the provider, stored on the notification delivery. */
  readonly providerMessageId: string;
}

/** The one interface every send path goes through. */
export interface EmailTransport {
  readonly name: string;
  send(message: OutgoingEmail): Promise<SendResult>;
}

/** The provider refused or failed the send. */
export class EmailSendError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "EmailSendError";
    this.code = code;
  }
}

/** The recipient is outside the allow-list (Section 19.8: never send to real recipients outside it). */
export class RecipientRefusedError extends Error {
  readonly recipient: string;
  constructor(recipient: string) {
    super(`Recipient ${recipient} is outside the email allow-list`);
    this.name = "RecipientRefusedError";
    this.recipient = recipient;
  }
}

/**
 * Records messages instead of sending them: the transport for tests, local development and every
 * environment without an explicit Resend configuration.
 */
export class RecordingTransport implements EmailTransport {
  readonly name = "record";
  readonly sent: OutgoingEmail[] = [];

  async send(message: OutgoingEmail): Promise<SendResult> {
    this.sent.push(message);
    return { providerMessageId: `recorded-${this.sent.length}` };
  }
}

/** The part of the Resend client the transport uses. */
export interface ResendClient {
  readonly emails: {
    send(
      payload: CreateEmailOptions,
      options?: CreateEmailRequestOptions,
    ): Promise<CreateEmailResponse>;
  };
}

/** Sends through Resend. The client and its API key belong to the owner's Resend account. */
export class ResendTransport implements EmailTransport {
  readonly name = "resend";
  readonly #client: ResendClient;

  constructor(client: ResendClient) {
    this.#client = client;
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    const payload: CreateEmailOptions = {
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
      ...(message.tags === undefined ? {} : { tags: message.tags.map((tag) => ({ ...tag })) }),
    };
    const response = await this.#client.emails.send(
      payload,
      message.idempotencyKey === undefined ? undefined : { idempotencyKey: message.idempotencyKey },
    );
    if (response.error !== null) {
      throw new EmailSendError(response.error.message, String(response.error.name));
    }
    return { providerMessageId: response.data.id };
  }
}

export interface RecipientPolicy {
  /** Lowercased domains (or full addresses) that may receive email outside production. */
  readonly allowed: readonly string[];
  /** True only in production, where every recipient may receive email. */
  readonly deliverToAny: boolean;
}

/** True when the policy lets the address receive email. */
export function recipientAllowed(address: string, policy: RecipientPolicy): boolean {
  if (policy.deliverToAny) return true;
  const normalized = address.trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  return policy.allowed.some((entry) => entry === normalized || entry === domain);
}

/** Wraps a transport and refuses recipients outside the allow-list before anything reaches it. */
export class GuardedTransport implements EmailTransport {
  readonly name: string;
  readonly #inner: EmailTransport;
  readonly #policy: RecipientPolicy;

  constructor(inner: EmailTransport, policy: RecipientPolicy) {
    this.#inner = inner;
    this.#policy = policy;
    this.name = `guarded:${inner.name}`;
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    if (!recipientAllowed(message.to, this.#policy)) throw new RecipientRefusedError(message.to);
    return this.#inner.send(message);
  }
}

/** Hosts a Mailpit inbox may run on: this machine, or the local Supabase stack's inbucket container. */
const LOCAL_INBOX_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|supabase_inbucket_[a-z0-9_-]+|[a-z0-9-]+\.localhost)$/i;

/** Splits "Name <address>" into Mailpit's address shape. */
function mailpitAddress(value: string): { Email: string; Name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { Email: value.trim() };
  const name = (match[1] ?? "").replace(/^"|"$/g, "");
  return name === "" ? { Email: match[2] as string } : { Email: match[2] as string, Name: name };
}

/**
 * Delivers into a local Mailpit inbox (the Supabase stack's inbucket) through its send API, for
 * development and end-to-end tests. It refuses any host that is not local, so it can never reach
 * a real recipient (Section 19.8).
 */
export class MailpitTransport implements EmailTransport {
  readonly name = "mailpit";
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (!LOCAL_INBOX_HOST.test(url.hostname)) {
      throw new Error(`The Mailpit transport delivers only to a local inbox, not ${url.hostname}.`);
    }
    this.#endpoint = new URL("/api/v1/send", url).toString();
    this.#fetch = fetchImpl;
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        From: mailpitAddress(message.from),
        To: [{ Email: message.to }],
        ...(message.replyTo === undefined ? {} : { ReplyTo: [mailpitAddress(message.replyTo)] }),
        Subject: message.subject,
        HTML: message.html,
        Text: message.text,
        ...(message.headers === undefined ? {} : { Headers: { ...message.headers } }),
        ...(message.tags === undefined ? {} : { Tags: message.tags.map((t) => t.value) }),
      }),
    });
    if (!response.ok) {
      throw new EmailSendError(
        `Mailpit refused the message with status ${response.status}.`,
        `mailpit_${response.status}`,
      );
    }
    const body = (await response.json()) as { ID?: unknown };
    if (typeof body.ID !== "string") {
      throw new EmailSendError("Mailpit returned no message id.", "mailpit_no_id");
    }
    return { providerMessageId: `mailpit-${body.ID}` };
  }
}
