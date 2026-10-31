"use client";

import { useTranslations } from "next-intl";
import { useAiFeature } from "@/components/aurora/ai-features";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";

const dialog = onDemand(() => import("./list-draft-dialog"));

export interface ListDraftEntryProps {
  /** What to draft, as aurora.draft names it. */
  readonly kind: "run_of_show" | "risk_assessment";
  /** The empty list the draft fills: a running order (run-of-show) or a project (projects). */
  readonly target: { readonly collection: string; readonly id: string; readonly label: string };
  /** More records the draft is written from, read with the person's permissions. */
  readonly context: readonly {
    readonly collection: string;
    readonly id: string;
    readonly label: string;
  }[];
  /** For a run of show: the running order's zone, for its cue times. */
  readonly timeZone?: string;
  /** For a run of show: its show day, YYYY-MM-DD. */
  readonly showDate?: string;
}

/**
 * "Draft run of show with Aurora" and "Draft risk assessment with Aurora" (P6, parity gap G-83): an
 * empty running order or project risk list offers a draft. Shown only while drafting is on for the
 * org; the page ships only the button, and the panel loads on first use. The database decides
 * whether the list is still empty, on the draft and again when the lines are added.
 */
export function ListDraftEntry(props: ListDraftEntryProps) {
  const t = useTranslations("aurora.entry.listDraft");
  const on = useAiFeature("drafting");
  const panel = useEntryPanel(dialog);
  if (!on) return null;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="drafting"
        label={t(`button.${props.kind}`)}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.ListDraftDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}
