/**
 * The guest pass PDF for the guest-email Edge Function (B8, ADR 0147 decision 6): the guest-pass document of the
 * shared pipeline (ADR 0031), built from the claim's own facts and rendered on A6. Loaded only when a Pass email is
 * sent, so pdfkit, its fonts and the documents copy never load at boot. The brand is the sending org's name: the
 * worker holds no org's logo, and the pass carries only the row's org.
 */
import { buildDocumentModel } from "../../data/src/documents/build.ts";
import { renderDocumentPdf } from "../../data/src/documents/render.ts";
import { defaultLocale, isLaunchLocale } from "@xos/i18n/locales";
import enDocuments from "@xos/i18n/messages/en-US/documents.json" with { type: "json" };
import esDocuments from "@xos/i18n/messages/es-US/documents.json" with { type: "json" };
import type { ClaimedGuestEmail, GuestPassFacts } from "../src/notifications/guest-emails.ts";

export async function renderGuestPassPdf(
  claim: ClaimedGuestEmail,
  pass: GuestPassFacts,
  options: { readonly gatewayUrl: string; readonly now?: Date },
): Promise<Uint8Array> {
  const locale = isLaunchLocale(claim.locale) ? claim.locale : defaultLocale;
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
      messages: locale === "es-US" ? esDocuments : enDocuments,
      brand: { name: claim.orgName, legalEntity: null, accentHex: null, logo: null },
      // A card draws no record link (render-card.ts), and a guest has no record to open: the facts name Gateway.
      recordUrl: options.gatewayUrl,
      paper: "a6",
      ...(options.now ? { now: options.now } : {}),
    },
  );
  return renderDocumentPdf(model, { paper: "a6" });
}
