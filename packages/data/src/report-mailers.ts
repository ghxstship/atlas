/**
 * The mailers report deliveries and other workers send through. Their own module, so a function that sends a certificate
 * does not load the report sources (org-lifecycle's boot has a ceiling).
 */

export interface ReportEmail {
  readonly to: string;
  readonly toName: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** A report's file. A stakeholder pack email (B2, ADR 0141) has none: it carries a sign-in link. */
  readonly attachment?: {
    readonly filename: string;
    readonly contentType: string;
    readonly content: Uint8Array;
  };
  /** Extra message headers, such as List-Unsubscribe on a stakeholder pack email (RFC 8058). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The From name (the org's, A138), on the mailer's own address. */
  readonly fromName?: string;
  readonly replyTo?: string;
}

/** A From header, quoted as RFC 5322 needs, as the notification worker's mailbox (platform stores.ts). */
export function mailboxOf(name: string, address: string): string {
  const clean = Array.from(name, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : c;
  })
    .join("")
    .trim();
  if (clean === "") return address;
  const display = /[()<>[\]:;@\\,."]/.test(clean) ? `"${clean.replace(/["\\]/g, "\\$&")}"` : clean;
  return `${display} <${address}>`;
}

/** The bare address of a mailbox, found with indexOf so it stays linear on any input. */
export function addressOf(mailbox: string): string {
  const open = mailbox.lastIndexOf("<");
  const close = open === -1 ? -1 : mailbox.indexOf(">", open + 1);
  return open !== -1 && close > open + 1 ? mailbox.slice(open + 1, close).trim() : mailbox.trim();
}

export interface ReportMailer {
  readonly name: string;
  send(email: ReportEmail): Promise<{ readonly messageId: string }>;
}

/** Base64 of bytes without Node's Buffer, so the Edge runtime can use it too. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "host.docker.internal"]);

/**
 * Sends through Mailpit's HTTP API (`POST /api/v1/send`), the Inbucket of a local Supabase stack.
 * Only a local host is accepted (or a Docker service name of a supabase_inbucket container), so this
 * mailer can never reach a real recipient (Section 19.8).
 */
export function mailpitMailer(
  baseUrl: string,
  from: { readonly email: string; readonly name: string },
  fetchImpl: typeof fetch = fetch,
): ReportMailer {
  const url = new URL(baseUrl);
  if (!LOCAL_HOSTS.has(url.hostname) && !url.hostname.startsWith("supabase_inbucket_")) {
    throw new Error(`The Mailpit mailer only sends to a local inbox, not ${url.hostname}.`);
  }
  return {
    name: "mailpit",
    async send(email) {
      const response = await fetchImpl(new URL("/api/v1/send", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: { Email: from.email, Name: email.fromName ?? from.name },
          To: [{ Email: email.to, Name: email.toName ?? "" }],
          Subject: email.subject,
          Text: email.text,
          HTML: email.html,
          ...(email.headers ? { Headers: email.headers } : {}),
          ...(email.replyTo ? { ReplyTo: [{ Email: email.replyTo, Name: "" }] } : {}),
          ...(email.attachment
            ? {
                Attachments: [
                  {
                    Content: toBase64(email.attachment.content),
                    Filename: email.attachment.filename,
                    ContentType: email.attachment.contentType,
                  },
                ],
              }
            : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`Mailpit refused the message: ${response.status} ${await response.text()}`);
      }
      const json = (await response.json()) as { ID?: string };
      return { messageId: json.ID ?? "" };
    },
  };
}

/** The part of the Resend client a production mailer needs. */
export interface ResendLike {
  readonly emails: {
    send(payload: {
      from: string;
      to: string[];
      replyTo?: string;
      subject: string;
      text: string;
      html: string;
      attachments?: { filename: string; content: string; contentType?: string }[];
      headers?: Record<string, string>;
    }): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
  };
}

/**
 * Sends through the owner's Resend account, only to recipients `allowed` accepts (the email
 * environment's allow-list outside production, Section 19.8).
 */
export function resendMailer(
  client: ResendLike,
  from: string,
  allowed: (address: string) => boolean,
): ReportMailer {
  return {
    name: "resend",
    async send(email) {
      if (!allowed(email.to)) throw new Error(`${email.to} is outside the email allow-list.`);
      const { data, error } = await client.emails.send({
        from: email.fromName ? mailboxOf(email.fromName, addressOf(from)) : from,
        to: [email.to],
        ...(email.replyTo ? { replyTo: email.replyTo } : {}),
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.headers ? { headers: { ...email.headers } } : {}),
        ...(email.attachment
          ? {
              attachments: [
                {
                  filename: email.attachment.filename,
                  content: toBase64(email.attachment.content),
                  contentType: email.attachment.contentType,
                },
              ],
            }
          : {}),
      });
      if (error || !data) throw new Error(`Resend refused the message: ${error?.message ?? ""}`);
      return { messageId: data.id };
    },
  };
}

// Stores --------------------------------------------------------------------------------------------
