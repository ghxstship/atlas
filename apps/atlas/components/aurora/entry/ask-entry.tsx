"use client";

import { Button, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useAiFeature } from "@/components/aurora/ai-features";
import type { AskCatalog } from "@/lib/aurora/ask";
import { onDemand, useEntryPanel } from "./ai-button";
import { ASK_FILTER_EVENT } from "./ask-event";

const dialog = onDemand(() => import("./ask-dialog"));

/**
 * The plain-language filter field in a collection's filter bar (Section 4.7, A95, finding
 * A65-020): "overdue invoices from Acme" becomes the page's own filters, shown and editable before
 * they apply. Shown only while Ask in plain language is on for the org; the panel loads when the
 * field is first used. Its own form, never inside the filter bar's form.
 */
export function AskFilterEntry({ catalog }: { catalog: AskCatalog }) {
  const t = useTranslations("aurora.entry.ask");
  const on = useAiFeature("plain_language");
  const id = useId();
  const [sentence, setSentence] = useState("");
  const [asked, setAsked] = useState("");
  const panel = useEntryPanel(dialog);

  useEffect(() => {
    const focus = () => document.getElementById(`${id}-sentence`)?.focus();
    window.addEventListener(ASK_FILTER_EVENT, focus);
    return () => window.removeEventListener(ASK_FILTER_EVENT, focus);
  }, [id]);

  if (!on) return null;
  return (
    <form
      role="search"
      aria-label={t("label")}
      className="flex flex-wrap items-end gap-8"
      data-ai-entry="plain_language"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = sentence.trim();
        if (trimmed === "") return;
        setAsked(trimmed);
        panel.show();
      }}
    >
      <Input
        id={`${id}-sentence`}
        type="search"
        label={t("label")}
        help={t("help", { collection: catalog.label })}
        placeholder={t("example")}
        maxLength={500}
        width={360}
        value={sentence}
        onChange={(e) => setSentence(e.target.value)}
        onFocus={panel.preload}
      />
      <Button type="submit" variant="secondary" icon="Sparkles" onPointerEnter={panel.preload}>
        {t("button")}
      </Button>
      {panel.loaded ? (
        <panel.loaded.AskDialog
          key={panel.session}
          catalog={catalog}
          sentence={asked}
          open={panel.open}
          onOpenChange={panel.setOpen}
        />
      ) : null}
    </form>
  );
}
