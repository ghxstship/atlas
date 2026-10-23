"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAiFeature } from "@/components/aurora/ai-features";
import { SUGGESTION_FIELD } from "@/lib/aurora/suggestion-field";
import { AiButton, onDemand, useEntryPanel } from "./ai-button";

const dialog = onDemand(() => import("./extract-dialog"));

/** How an extracted field is written into the form. */
export interface ExtractField {
  /** The form field's name. */
  readonly name: string;
  /** `money` writes minor units as the major-unit amount the form takes. */
  readonly as?: "money";
}

export interface ExtractEntryProps {
  /** What the document is, as aurora.extract names it. */
  readonly kind: "invoice" | "receipt" | "quote";
  /** The form field each extracted field path fills; a path not listed is shown, not written. */
  readonly fields: Readonly<Record<string, ExtractField>>;
  /** For quotes: the repeated fields of a quoted line, in row order. */
  readonly lines?: {
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
  };
  /** Shows at least this many line rows before they are filled. */
  readonly ensureRows?: (rows: number) => void;
}

/**
 * "Fill from a document" on the invoice, expense and RFQ response forms (A95, finding A65-020).
 * Aurora reads the file the person picks into proposed fields; they review and correct them, and
 * "Fill the form" writes them into this form only. The form's own save is the confirmation: the
 * suggestions travel with it as hidden fields and close with the record written. Shown only while
 * document extraction is on; the panel loads on first use.
 */
export function ExtractEntry(props: ExtractEntryProps) {
  const t = useTranslations("aurora.entry.extract");
  const on = useAiFeature("extraction");
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useEntryPanel(dialog);
  const [ids, setIds] = useState<readonly string[]>([]);
  const form = useCallback(() => anchor.current?.closest("form") ?? null, []);
  // A form cleared after a save starts the next entry without the last document's suggestions.
  useEffect(() => {
    const target = form();
    if (!target) return;
    const clear = () => setIds([]);
    target.addEventListener("reset", clear);
    return () => target.removeEventListener("reset", clear);
  }, [form, on]);
  if (!on) return null;
  return (
    <div ref={anchor} className="flex flex-wrap items-center gap-8">
      <AiButton
        feature="extraction"
        label={t(`button.${props.kind}`)}
        onOpen={panel.show}
        onPreload={panel.preload}
      />
      {ids.length > 0 ? (
        <span className="text-text-12 text-text-secondary">{t("filledNote")}</span>
      ) : null}
      {ids.map((id) => (
        <input key={id} type="hidden" name={SUGGESTION_FIELD} value={id} />
      ))}
      {panel.loaded ? (
        <panel.loaded.ExtractDialog
          key={panel.session}
          {...props}
          form={form}
          filled={ids}
          onFilled={setIds}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </div>
  );
}
