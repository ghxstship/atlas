"use client";

import { useTranslations } from "next-intl";
import { useAiFeature } from "@/components/aurora/ai-features";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";

const dialog = onDemand(() => import("./summary-dialog"));

export type SummaryKind = "record_activity" | "project_week" | "gate_readiness";

export interface SummaryItem {
  readonly collection: string;
  readonly id: string;
  readonly label: string;
}

export interface SummaryEntryProps {
  /** The record or project summarized. */
  readonly subject: SummaryItem;
  /** What may be summarized, first the default. */
  readonly kinds: readonly SummaryKind[];
  /** Items known when the page rendered, per kind (a record's history and comments). */
  readonly items?: Partial<Record<SummaryKind, readonly SummaryItem[]>>;
  /** For a project, where the panel reads the week's activity when it opens. */
  readonly project?: { readonly org: string; readonly key: string };
}

/**
 * "Summarize" on a record and on the project Overview (A95, finding A65-020). Shown only while
 * summaries are on for the org; the panel loads on first use. A summary writes nothing.
 */
/** SummaryEntry on its own line, for a column of panels; nothing at all while summaries are off. */
export function SummaryEntryRow(props: SummaryEntryProps) {
  const on = useAiFeature("summaries");
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <SummaryEntry {...props} />
    </div>
  );
}

export function SummaryEntry(props: SummaryEntryProps) {
  const t = useTranslations("aurora.entry.summary");
  const on = useAiFeature("summaries");
  const panel = useEntryPanel(dialog);
  if (!on) return null;
  return (
    <>
      <AiButton
        feature="summaries"
        label={t("button")}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.SummaryDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </>
  );
}
