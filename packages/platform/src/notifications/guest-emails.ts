import { sendEmail, type EmailAttachment, type EmailTransport, type Sender } from "@xos/email";
import { isLocale, type Locale } from "@xos/i18n/locales";
import {
  brandedSender,
  orgEmailBrandFromRow,
  rows,
  type OrgEmailBrand,
  type PlatformDb,
} from "../stores.ts";

/**
 * Guest list emails (B8, gap G-71, migration 6255, ADR 0147 decision 7). The guest-email Edge Function claims Queued
 * rows (app.claim_guest_emails, which checks each row again and skips or suppresses what may no longer go), renders
 * each in the send's language as the org's guest_message email, attaches the guest's A6 pass to a Pass email only,
 * sends it through the configured transport (recording by default) and records the outcome (app.finish_guest_email).
 * Every guest email is non-transactional: it carries the one-click unsubscribe link of its row, the org as sender and
 * XOS_POSTAL_ADDRESS (decision 41), and is tagged with the org so a bounce webhook can find it.
 */

export interface ClaimedGuestEmail {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly projectName: string;
  readonly guestListEntryId: string;
  /** app.guest_email_kind: Invitation, Pass or Message. */
  readonly kind: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly locale: Locale;
  readonly to: string;
  readonly guestName: string;
  readonly plusOnes: number;
  readonly unsubscribeToken: string;
  /** What the guest-pass document prints for a Pass email (the claim reads them; null when the guest has none). */
  readonly pass: GuestPassFacts | null;
}

/** The facts a guest pass prints, as app.claim_guest_emails returns them (6255). */
export interface GuestPassFacts {
  readonly projectId: string;
  readonly projectKey: string;
  readonly timeZone: string;
  readonly passCode: string;
  readonly passCategoryCode: string | null;
  readonly passCategoryName: string | null;
  readonly tableLabel: string | null;
  readonly showName: string | null;
  readonly showDay: string | null;
  readonly decidedAt: string;
}

/**
 * The brand of an org's document (app.document_brand_for_org, 904090003): what Atlas prints on a guest pass it
 * downloads, whatever the org's plan.
 */
export interface GuestPassBrand {
  readonly name: string;
  readonly legalEntity: string | null;
  readonly accentHex: string | null;
  readonly logoPath: string | null;
}

/** What a guest email of an org wears: its email brand while white label is in force, and its document brand. */
export interface GuestEmailBrand {
  readonly email: OrgEmailBrand | null;
  readonly document: GuestPassBrand;
}

export interface GuestEmailStore {
  claim(limit: number): Promise<readonly ClaimedGuestEmail[]>;
  /** The org's brands, read once per org in a pass. */
  brandFor(orgId: string, orgName: string): Promise<GuestEmailBrand>;
  finish(id: string, providerMessageId: string | null, error: string | null): Promise<void>;
}

export interface GuestEmailOptions {
  /** The email-unsubscribe function's URL; the guest's token goes in ?guest=. */
  readonly unsubscribeUrl: string;
  /** Gateway origin: the unsubscribe page that asks first is at /unsubscribe/{token}. */
  readonly gatewayUrl: string;
  /** The address the org's guest emails come from; the display name is the org's. */
  readonly fromAddress: string;
  /** The postal address every email carries (decision 41). */
  readonly postalAddress: string;
  /**
   * Public base URL of the org-brand bucket (`<SUPABASE_URL>/storage/v1/object/public/org-brand`), for the logo of a
   * white-label org's email. Without it the email carries no logo.
   */
  readonly brandAssetUrl?: string | null;
}

/** Renders a guest's pass as an A6 PDF from the claim's own facts and its org's document brand, so it carries only the row's org. */
export type RenderGuestPass = (
  claim: ClaimedGuestEmail,
  pass: GuestPassFacts,
  brand: GuestPassBrand,
) => Promise<Uint8Array>;

export interface GuestEmailSummary {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
}

/** The one-click link (RFC 8058) the List-Unsubscribe header and the footer carry. */
export function guestUnsubscribeUrl(unsubscribeUrl: string, token: string): string {
  const url = new URL(unsubscribeUrl);
  url.searchParams.set("guest", token);
  return url.toString();
}

/** Claims due guest emails, sends each and records the outcome. A failure is recorded, never dropped. */
export async function dispatchGuestEmails(
  store: GuestEmailStore,
  transport: EmailTransport,
  renderPass: RenderGuestPass,
  options: GuestEmailOptions,
  limit = 50,
): Promise<GuestEmailSummary> {
  const claims = await store.claim(limit);
  const brands = new Map<string, Promise<GuestEmailBrand>>();
  let sent = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      const unsubscribeUrl = guestUnsubscribeUrl(options.unsubscribeUrl, claim.unsubscribeToken);
      let pending = brands.get(claim.orgId);
      if (pending === undefined) {
        pending = store.brandFor(claim.orgId, claim.orgName);
        brands.set(claim.orgId, pending);
      }
      const brand = await pending.catch((error: unknown) => {
        brands.delete(claim.orgId);
        throw error;
      });
      // The org's brand while white label is in force (A138): name, From, reply-to, logo and accent.
      const parts = brandedSender(claim.orgName, brand.email, {
        fromAddress: options.fromAddress,
        brandAssetUrl: options.brandAssetUrl ?? null,
      });
      const sender: Sender = {
        orgName: parts.orgName,
        ...(parts.brand === undefined ? {} : { brand: parts.brand }),
        postalAddress: options.postalAddress,
        preferencesUrl: new URL(
          `/unsubscribe/${encodeURIComponent(claim.unsubscribeToken)}`,
          options.gatewayUrl,
        ).toString(),
        unsubscribeUrl,
      };
      if (claim.kind === "Pass" && claim.pass === null) {
        // The claim checks the guest is approved with a code; a row without them is never sent without its pass.
        throw new Error("A Pass email needs the guest's pass code");
      }
      const attachments: EmailAttachment[] =
        claim.kind === "Pass" && claim.pass !== null
          ? [
              {
                filename: `guest-pass-${claim.pass.passCode}.pdf`,
                content: await renderPass(claim, claim.pass, brand.document),
                contentType: "application/pdf",
              },
            ]
          : [];
      const result = await sendEmail({
        transport,
        template: "guest_message",
        props: {
          kind: claim.kind,
          guestName: claim.guestName,
          projectName: claim.projectName,
          plusOnes: claim.plusOnes,
          ...(claim.subject === null ? {} : { subject: claim.subject }),
          ...(claim.body === null ? {} : { body: claim.body }),
        },
        locale: claim.locale,
        sender,
        recipientName: claim.guestName,
        from: parts.from,
        ...(parts.replyTo === undefined ? {} : { replyTo: parts.replyTo }),
        to: claim.to,
        attachments,
        tags: [
          { name: "org_id", value: claim.orgId },
          { name: "guest_email_id", value: claim.id },
        ],
        idempotencyKey: `guest-email-${claim.id}`,
      });
      await store.finish(claim.id, result.providerMessageId, null);
      sent += 1;
    } catch (error) {
      failed += 1;
      await store.finish(claim.id, null, error instanceof Error ? error.message : String(error));
    }
  }
  return { attempted: claims.length, sent, failed };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${what}`);
  return value;
}

/** GuestEmailStore over the service-role database seam (app.claim_guest_emails and app.finish_guest_email, 6255). */
export function guestEmailStore(db: PlatformDb): GuestEmailStore {
  return {
    async claim(limit) {
      const rows = ((await db.rpc("claim_guest_emails", { p_limit: limit })) ?? []) as Record<
        string,
        unknown
      >[];
      return rows.map((r) => ({
        id: str(r["guest_email_id"], "guest_email_id"),
        orgId: str(r["org_id"], "org_id"),
        orgName: str(r["org_name"], "org_name"),
        projectName: str(r["project_name"], "project_name"),
        guestListEntryId: str(r["guest_list_entry_id"], "guest_list_entry_id"),
        kind: str(r["email_kind"], "email_kind"),
        subject: typeof r["subject"] === "string" ? r["subject"] : null,
        body: typeof r["body"] === "string" ? r["body"] : null,
        locale: typeof r["locale"] === "string" && isLocale(r["locale"]) ? r["locale"] : "en-US",
        to: str(r["to_email"], "to_email"),
        guestName: str(r["guest_name"], "guest_name"),
        plusOnes: typeof r["plus_ones"] === "number" ? r["plus_ones"] : 0,
        unsubscribeToken: str(r["unsubscribe_token"], "unsubscribe_token"),
        pass:
          typeof r["pass_code"] === "string" && typeof r["decided_at"] === "string"
            ? {
                projectId: str(r["project_id"], "project_id"),
                projectKey: typeof r["project_key"] === "string" ? r["project_key"] : "",
                timeZone: typeof r["time_zone"] === "string" ? r["time_zone"] : "UTC",
                passCode: r["pass_code"],
                passCategoryCode: nullableText(r["pass_category_code"]),
                passCategoryName: nullableText(r["pass_category_name"]),
                tableLabel: nullableText(r["table_label"]),
                showName: nullableText(r["show_name"]),
                showDay: nullableText(r["show_day"]),
                decidedAt: r["decided_at"],
              }
            : null,
      }));
    },
    async brandFor(orgId, orgName) {
      const [email, document] = await Promise.all([
        db.rpc("email_brand_for_org", { p_org_id: orgId }),
        db.rpc("document_brand_for_org", { p_org_id: orgId }),
      ]);
      const doc = rows(document)[0];
      return {
        email: orgEmailBrandFromRow(rows(email)[0]),
        document: {
          name: nullableText(doc?.["name"]) ?? orgName,
          legalEntity: nullableText(doc?.["legal_entity"]),
          accentHex: nullableText(doc?.["accent_hex"]),
          logoPath: nullableText(doc?.["logo_path"]),
        },
      };
    },
    async finish(id, providerMessageId, error) {
      await db.rpc("finish_guest_email", {
        p_id: id,
        p_provider_message_id: providerMessageId,
        p_error: error,
      });
    },
  };
}
