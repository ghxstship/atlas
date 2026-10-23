"use client";

import { useTranslations } from "next-intl";
import { useCallback, useRef } from "react";
import { useAiFeature } from "@/components/aurora/ai-features";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";

const dialog = onDemand(() => import("./draft-dialog"));

export interface DraftEntryProps {
  /** What to draft, as aurora.draft names it. */
  readonly kind: "sop" | "advance_packet" | "change_order_description";
  /** The editor's form; by default the form the button sits in. */
  readonly formId?: string;
  /** Names of the form fields the draft fills: its title (optional) and body. */
  readonly fields: { readonly title?: string; readonly body: string };
  /** Records the draft is written from, read with the person's permissions. */
  readonly context: readonly {
    readonly collection: string;
    readonly id: string;
    readonly label: string;
  }[];
  /** A form field whose current text starts the instructions, such as the title. */
  readonly instructionsFrom?: string;
  /** The most characters the body field takes. */
  readonly maxBody?: number;
}

/**
 * "Draft with Aurora" in an editor (A95, finding A65-020): the SOP, advance packet section and
 * change order editors. Shown only while drafting is on for the org; the panel loads on first use.
 */
export function DraftEntry(props: DraftEntryProps) {
  const t = useTranslations("aurora.entry.draft");
  const on = useAiFeature("drafting");
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useEntryPanel(dialog);
  const { formId } = props;
  const form = useCallback((): HTMLFormElement | null => {
    if (formId) {
      const found = document.getElementById(formId);
      return found instanceof HTMLFormElement ? found : (found?.querySelector("form") ?? null);
    }
    return anchor.current?.closest("form") ?? null;
  }, [formId]);
  if (!on) return null;
  return (
    <div ref={anchor} className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="drafting"
        label={t("button")}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.DraftDialog
          key={panel.session}
          {...props}
          form={form}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}
