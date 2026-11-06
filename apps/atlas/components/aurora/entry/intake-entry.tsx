"use client";

import { useTranslations } from "next-intl";
import { useAiFeature } from "@/components/aurora/ai-features";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";

/**
 * The B15 entry points (RRR-239): itineraries into a Travel fulfillment (G-59), contracts and riders
 * into Artist bookings (G-177), the open lines of an invoice (G-225), and answers drafted from a
 * reply (G-173). Each renders only while its feature is on; the page ships only the button, and the
 * panel loads on first use.
 */

const itinerary = onDemand(() => import("./itinerary-intake-dialog"));
const contract = onDemand(() => import("./contract-intake-dialog"));
const invoiceLines = onDemand(() => import("./invoice-lines-dialog"));
const advanceDraft = onDemand(() => import("./advance-answers-dialog"));

export interface ItineraryEntryProps {
  readonly projectId: string;
  readonly fulfillmentId: string | null;
}

/** "Read Itineraries": takes only the project and fulfillment, so it can also mount on a travel page. */
export function ItineraryEntry(props: ItineraryEntryProps) {
  const t = useTranslations("aurora.entry.intake.itinerary");
  const on = useAiFeature("extraction");
  const panel = useEntryPanel(itinerary);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="extraction"
        label={t("button")}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.ItineraryIntakeDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}

export interface ContractIntakeEntryProps {
  /** The projects a booking may be on; one means no choice is shown. */
  readonly projects: readonly { readonly id: string; readonly label: string }[];
  /** Where a missing counterparty is imported, only when the person can see that page. */
  readonly importHref: string | null;
}

/** "Read Contracts and Riders" on the engagements list. */
export function ContractIntakeEntry(props: ContractIntakeEntryProps) {
  const t = useTranslations("aurora.entry.intake.contract");
  const on = useAiFeature("extraction");
  const panel = useEntryPanel(contract);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="extraction"
        label={t("button")}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.ContractIntakeDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}

export interface InvoiceLinesEntryProps {
  readonly invoiceId: string;
  readonly currencyCode: string;
  /** The total the document printed, or null. */
  readonly printedTotalMinor: number | null;
  /** Lines the invoice already has, so the tie-out equals what the invoice will show after saving. */
  readonly existingLines: readonly {
    readonly quantity: number;
    readonly unitPriceMinor: number | null;
  }[];
  readonly budgetLines: readonly { readonly value: string; readonly label: string }[];
}

/** "Review Lines from the Document": shown while a Proposed invoice has the asker's open lines. */
export function InvoiceLinesEntry(props: InvoiceLinesEntryProps) {
  const t = useTranslations("aurora.entry.intake.invoiceLines");
  const on = useAiFeature("extraction");
  const panel = useEntryPanel(invoiceLines);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="extraction"
        label={t("button")}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.InvoiceLinesDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}

export interface AdvanceDraftEntryProps {
  readonly recipientId: string;
  readonly recipientName: string;
  /** Verified mail of the project's inbox the person can read, newest first. */
  readonly inbox: readonly {
    readonly id: string;
    readonly subject: string | null;
    readonly fromAddress: string;
    readonly receivedAt: string;
  }[];
}

/** "Draft Answers from a Reply" on a recipient of a sent packet. */
export function AdvanceDraftEntry(props: AdvanceDraftEntryProps) {
  const t = useTranslations("aurora.entry.intake.advanceDraft");
  const on = useAiFeature("drafting");
  const panel = useEntryPanel(advanceDraft);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="drafting"
        label={t("button")}
        variant="ghost"
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.AdvanceAnswersDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}
