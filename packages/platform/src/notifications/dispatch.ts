import { z } from "zod";
import {
  EmailSendError,
  RecipientRefusedError,
  isTemplateCode,
  sendEmail,
  type EmailTransport,
  type MessageArgs,
  type Sender,
  type TemplateCode,
  type TemplateProps,
} from "@xos/email";
import { isLocale, type Locale } from "@xos/i18n/locales";

/** An email delivery claimed from app.claim_notification_deliveries. */
export interface ClaimedEmail {
  readonly deliveryId: string;
  readonly orgId: string;
  readonly recipientPersonId: string;
  readonly address: string;
  readonly kind: string;
  readonly emailTemplateCode: string;
  readonly messageArgs: Readonly<Record<string, unknown>>;
  readonly subjectTable: string | null;
  readonly subjectId: string | null;
}

export interface Recipient {
  readonly name: string;
  readonly locale: string;
  readonly timeZone: string;
}

export type DeliveryOutcome = "Sent" | "Failed" | "Bounced";

/** What the email dispatcher needs from the database. */
export interface NotificationStore {
  claimEmail(limit: number): Promise<readonly ClaimedEmail[]>;
  /** Sender identity of an org: name, postal address, From address, preference and unsubscribe links. */
  senderFor(orgId: string, recipientPersonId: string): Promise<Sender & { readonly from: string }>;
  /** The recipient as an org writes to them: their name, its language for them and their time zone. */
  recipient(personId: string, orgId: string): Promise<Recipient>;
  /** Link that opens the notification's subject in the app. */
  linkFor(claim: ClaimedEmail): Promise<string>;
  /** Signed reply address for reply by email, or null when the email takes no replies. */
  replyAddressFor(claim: ClaimedEmail): Promise<string | null>;
  record(
    deliveryId: string,
    outcome: DeliveryOutcome,
    providerMessageId: string | null,
    error: string | null,
  ): Promise<void>;
}

const exportReady = z.object({ exportName: z.string(), expiresAt: z.coerce.date(), url: z.url() });
const importFinished = z.object({
  importName: z.string(),
  // 2051 (A104) says whether the import was validated or committed; a notice without it reads as committed.
  stage: z.enum(["validated", "committed"]).default("committed"),
  written: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  url: z.url(),
});
const reportDelivery = z.object({
  reportName: z.string(),
  periodLabel: z.string(),
  format: z.string(),
  url: z.url(),
});

function messageArgs(raw: Readonly<Record<string, unknown>>): MessageArgs {
  const args: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number") args[key] = value;
  }
  return args;
}

async function propsFor(
  claim: ClaimedEmail,
  store: NotificationStore,
): Promise<{ code: TemplateCode; props: TemplateProps[TemplateCode] }> {
  if (!isTemplateCode(claim.emailTemplateCode))
    throw new Error(`Unknown email template ${claim.emailTemplateCode}`);
  switch (claim.emailTemplateCode) {
    case "notification":
      return {
        code: "notification",
        props: {
          kind: claim.kind,
          args: messageArgs(claim.messageArgs),
          url: await store.linkFor(claim),
        },
      };
    case "export_ready":
      return { code: "export_ready", props: exportReady.parse(claim.messageArgs) };
    case "import_finished":
      return { code: "import_finished", props: importFinished.parse(claim.messageArgs) };
    case "report_delivery":
      return { code: "report_delivery", props: reportDelivery.parse(claim.messageArgs) };
    default:
      throw new Error(`The ${claim.emailTemplateCode} template is not sent for notifications`);
  }
}

export interface EmailDispatchSummary {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
}

/**
 * Sends claimed email deliveries through the transport (recording by default, Resend behind the
 * recipient guard in production) in the recipient's locale and time zone, and records each outcome.
 * A refused recipient or a provider error is recorded as a failure with its message, never dropped.
 */
export async function dispatchEmail(
  store: NotificationStore,
  transport: EmailTransport,
  limit = 50,
): Promise<EmailDispatchSummary> {
  const claims = await store.claimEmail(limit);
  let sent = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      const recipient = await store.recipient(claim.recipientPersonId, claim.orgId);
      const locale: Locale = isLocale(recipient.locale) ? recipient.locale : "en-US";
      const sender = await store.senderFor(claim.orgId, claim.recipientPersonId);
      const { code, props } = await propsFor(claim, store);
      const replyTo = await store.replyAddressFor(claim);
      const result = await sendEmail({
        transport,
        template: code,
        props,
        locale,
        timeZone: recipient.timeZone,
        sender,
        recipientName: recipient.name,
        from: sender.from,
        to: claim.address,
        deliveryId: claim.deliveryId,
        ...(replyTo === null ? {} : { replyTo }),
      });
      await store.record(claim.deliveryId, "Sent", result.providerMessageId, null);
      sent += 1;
    } catch (error) {
      const message =
        error instanceof RecipientRefusedError ||
        error instanceof EmailSendError ||
        error instanceof Error
          ? error.message
          : String(error);
      await store.record(claim.deliveryId, "Failed", null, message);
      failed += 1;
    }
  }
  return { attempted: claims.length, sent, failed };
}
