"use client";

import { useTranslations } from "next-intl";
import { useAiFeature } from "@/components/aurora/ai-features";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";

/**
 * The B15 extraction entry points (RRR-239): itineraries into a Travel fulfillment (G-59), booking
 * contracts and riders into the project's Artist engagements (G-177), and the lines of a Proposed
 * payable invoice (G-225). Each renders only while extraction is on for the org; the page ships
 * only the button, and the panel loads on first use.
 */

const itineraries = onDemand(() => import("./itinerary-intake-dialog"));
const contracts = onDemand(() => import("./contract-intake-dialog"));
const invoiceLines = onDemand(() => import("./invoice-lines-dialog"));

/** A verified project inbox message a person may pick as a source. */
export interface InboxSourceProp {
  readonly id: string;
  readonly subject: string | null;
  readonly fromAddress: string;
  readonly receivedAt: string;
}

export interface ItineraryIntakeEntryProps {
  readonly projectId: string;
  readonly fulfillmentId: string;
  /** The project's people, as the Travel form offers them. */
  readonly people: readonly {
    readonly personId: string;
    readonly label: string;
    readonly engagementId: string | null;
  }[];
  readonly inbox: readonly InboxSourceProp[];
}

/** "Import itineraries with Aurora" on a Travel fulfillment. */
export function ItineraryIntakeEntry(props: ItineraryIntakeEntryProps) {
  const t = useTranslations("aurora.entry.intake");
  const on = useAiFeature("extraction");
  const panel = useEntryPanel(itineraries);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="extraction"
        label={t("itineraries.button")}
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
  readonly projectId: string;
  /**
   * Canon rate card rows with a non-employee classification, as the batch defaults offer them: each
   * value is role_code|worker_classification|pay_basis|arrangement.
   */
  readonly terms: readonly { readonly value: string; readonly label: string }[];
  /** Whether the viewer reads pay rates on the project, as the database answers it. */
  readonly readsPayroll: boolean;
}

/** "Import contracts and riders" on the project's Engagements tab. */
export function ContractIntakeEntry(props: ContractIntakeEntryProps) {
  const t = useTranslations("aurora.entry.intake");
  const on = useAiFeature("extraction");
  const panel = useEntryPanel(contracts);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="extraction"
        label={t("contracts.button")}
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
  /** The highest line number on the invoice now; read lines are numbered after it. */
  readonly lastLineNumber: number;
  readonly budgetLines: readonly { readonly value: string; readonly label: string }[];
  readonly taxRates: readonly { readonly value: string; readonly label: string }[];
}

/** "Read lines from a document" on a Proposed payable invoice. */
export function InvoiceLinesEntry(props: InvoiceLinesEntryProps) {
  const t = useTranslations("aurora.entry.intake");
  const on = useAiFeature("extraction");
  const panel = useEntryPanel(invoiceLines);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="extraction"
        label={t("invoiceLines.button")}
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
