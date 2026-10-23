"use client";

import { useTranslations } from "next-intl";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";

const dialog = onDemand(() => import("./binding-dialog"));

export interface BindingEntryProps {
  readonly org: string;
  /** The open scan intake row. */
  readonly scan: {
    readonly id: string;
    readonly code: string;
    readonly symbology: string;
    readonly projectKey: string | null;
  };
}

/**
 * "Suggest binding" on an unknown scanned code in the scan intake queue (A95, finding A65-020).
 * Shown only while mapping help is on for the org; the panel loads on first use.
 */
export function BindingEntry(props: BindingEntryProps) {
  const t = useTranslations("aurora.entry.binding");
  const panel = useEntryPanel(dialog);
  return (
    <>
      <AiButton
        feature="mapping"
        label={t("button")}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {panel.loaded ? (
        <panel.loaded.BindingDialog
          key={panel.session}
          {...props}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </>
  );
}
