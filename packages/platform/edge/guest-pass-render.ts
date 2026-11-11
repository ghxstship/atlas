/**
 * The guest pass PDF for the guest-email Edge Function (B8, ADR 0147 decision 6): the guest-pass document of the
 * shared pipeline (ADR 0031), built from the claim's own facts and rendered on A6. Loaded only when a Pass email is
 * sent, so pdfkit, its fonts and the documents copy never load at boot. The brand is the sending org's document brand
 * (app.document_brand_for_org), the one Atlas prints on a pass it downloads: its name, legal entity, accent and a PNG
 * or JPEG logo, and the pass carries only the row's org. The document is dated when the guest was
 * approved, so its CreationDate, and with it pdfkit's file ID, are the same on every attempt: a retried send carries
 * a byte-identical attachment under the same idempotency key.
 */
import { buildDocumentModel } from "../../data/src/documents/build.ts";
import { isEmbeddableImage, renderDocumentPdf } from "../../data/src/documents/render.ts";
import { defaultLocale, isLaunchLocale } from "@xos/i18n/locales";
import enDocuments from "@xos/i18n/messages/en-US/documents.json" with { type: "json" };
import esDocuments from "@xos/i18n/messages/es-US/documents.json" with { type: "json" };
import type {
  ClaimedGuestEmail,
  GuestPassBrand,
  GuestPassFacts,
} from "../src/notifications/guest-emails.ts";

export async function renderGuestPassPdf(
  claim: ClaimedGuestEmail,
  pass: GuestPassFacts,
  options: {
    readonly gatewayUrl: string;
    readonly now?: Date;
    /** The org's document brand; without it the pass carries the org's name alone. */
    readonly brand?: GuestPassBrand;
    /** The logo's bytes, kept only when they are a PNG or a JPEG. */
    readonly logo?: Uint8Array | null;
  },
): Promise<Uint8Array> {
  const locale = isLaunchLocale(claim.locale) ? claim.locale : defaultLocale;
  const messages = locale === "es-US" ? esDocuments : enDocuments;
  const name = options.brand?.name ?? claim.orgName;
  const logoAlt = messages.facts.logoAlt.replace("{name}", name);
  const model = buildDocumentModel(
    "guest-pass",
    {
      project: {
        id: pass.projectId,
        key: pass.projectKey,
        name: claim.projectName,
        timeZone: pass.timeZone,
      },
      guest: {
        id: claim.guestListEntryId,
        projectId: pass.projectId,
        guestName: claim.guestName,
        plusOnes: claim.plusOnes,
        state: "Approved",
        passCode: pass.passCode,
        passCategoryCode: pass.passCategoryCode,
        passCategoryName: pass.passCategoryName,
        tableLabel: pass.tableLabel,
        showName: pass.showName,
        showDay: pass.showDay,
        decidedAt: pass.decidedAt,
      },
    },
    {
      locale,
      messages,
      brand: {
        name,
        legalEntity: options.brand?.legalEntity ?? null,
        accentHex: options.brand?.accentHex ?? null,
        logo:
          options.logo && isEmbeddableImage(options.logo)
            ? { bytes: options.logo, alt: logoAlt }
            : null,
      },
      // A card draws no record link (render-card.ts), and a guest has no record to open: the facts name Gateway.
      recordUrl: options.gatewayUrl,
      paper: "a6",
      ...(pass.decidedAt
        ? { now: new Date(pass.decidedAt) }
        : options.now
          ? { now: options.now }
          : {}),
    },
  );
  return renderDocumentPdf(model, { paper: "a6" });
}
