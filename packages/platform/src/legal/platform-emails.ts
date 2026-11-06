import { sendEmail, type EmailTransport, type MessageArgs, type Sender } from "@xos/email";
import { isLocale, type Locale } from "@xos/i18n/locales";
import type { PlatformDb } from "../stores.ts";

/**
 * Emails the platform sends in its own name (Section 14.4, migration 1382): the double opt-in
 * confirmation for Subprocessor List change notices and the notices themselves, and invitations to an
 * external account or onto a crew roster (R4, migrations 2630 and 2636), which link to Gateway sign-in, the legal
 * queue's alerts (ADR 0167, migration 6167) and moderation outcomes the notification queue cannot reach (6168). The
 * subprocessor-notices Edge Function claims them from private.platform_emails, renders them through
 * @xos/email in the recipient's language, sends them through the configured transport (recording by
 * default, Resend in production) and records each outcome; the database then forgets any token.
 */

export type PlatformEmailTemplate =
  | "subprocessor_confirm"
  | "subprocessor_notice"
  | "party_invitation"
  | "legal_clock_alert"
  | "moderation_notice";

export interface ClaimedPlatformEmail {
  readonly id: string;
  readonly template: PlatformEmailTemplate;
  readonly to: string;
  readonly locale: Locale;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface PlatformEmailStore {
  claim(limit: number): Promise<readonly ClaimedPlatformEmail[]>;
  finish(
    id: string,
    sent: boolean,
    providerMessageId: string | null,
    error: string | null,
  ): Promise<string>;
}

export interface PlatformEmailOptions {
  /** Atlas origin: the Subprocessor List and its confirmation and unsubscribe pages live there. */
  readonly appUrl: string;
  /** Gateway origin: invitations link to its sign-in. The invited address never goes into the link. */
  readonly gatewayUrl?: string;
  /** Console origin: a legal queue alert links an operator to the queue. Without it the alert has no link. */
  readonly consoleUrl?: string;
  /** From address, for example notices@ghxstship.tech. */
  readonly from: string;
  /** The platform's postal address (CAN-SPAM, CASL). */
  readonly postalAddress: string;
  /** Sender name shown in the footer. */
  readonly senderName: string;
}

export interface PlatformEmailSummary {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${what}`);
  return value;
}

/** The Subprocessor List page, and its confirmation and unsubscribe links. */
export function subprocessorLinks(appUrl: string) {
  const list = new URL("/legal/subprocessors", appUrl);
  return {
    list: list.toString(),
    confirm: (token: string) => `${list.toString()}?confirm=${encodeURIComponent(token)}`,
    unsubscribe: (token: string) => `${list.toString()}?unsubscribe=${encodeURIComponent(token)}`,
  };
}

/** Gateway sign-in, where an invitee signs in with the invited address and accepts on Home. */
export function gatewaySignInUrl(gatewayUrl: string): string {
  return new URL("/auth/sign-in", gatewayUrl).toString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One line of a legal queue digest, as the sweep wrote it. */
function legalClockItem(value: unknown) {
  const line = (value ?? {}) as Readonly<Record<string, unknown>>;
  const matter = line["matter"];
  return {
    reference: str(line["reference"], "reference"),
    ...(typeof matter === "string" ? { matter } : {}),
    clock: line["clock"] === "First Response" ? ("First Response" as const) : ("Due" as const),
    at: new Date(str(line["clock_at"], "clock_at")),
    overdue: line["overdue"] === true,
  };
}

function legalAudience(value: unknown): "operator" | "backup" | "reviewer" {
  return value === "backup" || value === "reviewer" ? value : "operator";
}

/** Claims due platform emails, sends each and records the outcome. A failure is recorded, never dropped. */
export async function dispatchPlatformEmails(
  store: PlatformEmailStore,
  transport: EmailTransport,
  options: PlatformEmailOptions,
  limit = 25,
): Promise<PlatformEmailSummary> {
  const claims = await store.claim(limit);
  const links = subprocessorLinks(options.appUrl);
  let sent = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      const unsubscribeToken =
        typeof claim.args["unsubscribe_token"] === "string"
          ? claim.args["unsubscribe_token"]
          : null;
      const sender: Sender = {
        orgName: options.senderName,
        postalAddress: options.postalAddress,
        // Members manage the notice in Settings, Notifications; subscribers unsubscribe by link.
        preferencesUrl: options.appUrl,
        ...(unsubscribeToken ? { unsubscribeUrl: links.unsubscribe(unsubscribeToken) } : {}),
      };
      const common = {
        transport,
        locale: claim.locale,
        timeZone: "UTC",
        sender,
        recipientName: claim.to,
        from: options.from,
        to: claim.to,
        deliveryId: claim.id,
      };
      const result =
        claim.template === "legal_clock_alert"
          ? await sendEmail({
              ...common,
              // Clocks end at the end of a local day, so the alert states them in the clock's own time zone.
              timeZone: str(claim.args["time_zone"], "time_zone"),
              template: "legal_clock_alert",
              props: {
                audience: legalAudience(claim.args["audience"]),
                overdue: Number(claim.args["overdue"] ?? 0),
                dueSoon: Number(claim.args["due_soon"] ?? 0),
                items: (Array.isArray(claim.args["items"]) ? claim.args["items"] : []).map(
                  legalClockItem,
                ),
                ...(options.consoleUrl
                  ? { queueUrl: new URL("/legal-queue", options.consoleUrl).toString() }
                  : {}),
              },
            })
          : claim.template === "moderation_notice"
            ? await sendEmail({
                ...common,
                template: "moderation_notice",
                props: {
                  kind:
                    claim.args["kind"] === "listing_report.decided" ||
                    claim.args["kind"] === "listing.moderated"
                      ? claim.args["kind"]
                      : "moderation_appeal.decided",
                  args: (claim.args["values"] ?? {}) as MessageArgs,
                },
              })
            : claim.template === "party_invitation"
              ? await sendEmail({
                  ...common,
                  template: "party_invitation",
                  props: {
                    kind: claim.args["kind"] === "roster" ? "roster" : "account",
                    inviterName: text(claim.args["inviter_name"]),
                    accountName: text(claim.args["account_name"]),
                    projectName: text(claim.args["project_name"]),
                    partyName: text(claim.args["party_name"]),
                    expiresAt: new Date(str(claim.args["expires_at"], "expires_at")),
                    signInUrl: gatewaySignInUrl(options.gatewayUrl ?? options.appUrl),
                  },
                })
              : claim.template === "subprocessor_confirm"
                ? await sendEmail({
                    ...common,
                    template: "subprocessor_confirm",
                    props: {
                      confirmUrl: links.confirm(str(claim.args["confirm_token"], "confirm_token")),
                    },
                  })
                : await sendEmail({
                    ...common,
                    template: "subprocessor_notice",
                    props: {
                      listVersion: str(claim.args["list_version"], "list_version"),
                      summary: str(claim.args["summary"], "summary"),
                      effectiveOn: new Date(
                        `${str(claim.args["effective_on"], "effective_on")}T12:00:00Z`,
                      ),
                      listUrl: links.list,
                    },
                  });
      await store.finish(claim.id, true, result.providerMessageId, null);
      sent += 1;
    } catch (error) {
      failed += 1;
      await store.finish(
        claim.id,
        false,
        null,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { attempted: claims.length, sent, failed };
}

/** PlatformEmailStore over the service-role database seam (app.claim_platform_emails, 1382). */
export function platformEmailStore(db: PlatformDb): PlatformEmailStore {
  return {
    async claim(limit) {
      const rows = ((await db.rpc("claim_platform_emails", { p_limit: limit })) ?? []) as Record<
        string,
        unknown
      >[];
      return rows.map((r) => ({
        id: str(r["id"], "id"),
        template: str(r["template"], "template") as PlatformEmailTemplate,
        to: str(r["to_email"], "to_email"),
        locale: typeof r["locale"] === "string" && isLocale(r["locale"]) ? r["locale"] : "en-US",
        args: (r["args"] ?? {}) as Record<string, unknown>,
      }));
    },
    async finish(id, sent, providerMessageId, error) {
      return String(
        await db.rpc("finish_platform_email", {
          p_id: id,
          p_sent: sent,
          p_provider_message_id: providerMessageId,
          p_error: error,
        }),
      );
    },
  };
}
