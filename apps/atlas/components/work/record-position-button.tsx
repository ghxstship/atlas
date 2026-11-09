"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

const panel = onDemand(() => import("./record-position-panel"));

/**
 * "Assign a position" on a record (B9, ADR 0148). The page carries only this button: the panel, its reads and its form
 * load on the first click, preloading on hover or focus, so no list or key page grows.
 */
export function RecordPositionButton(props: { org: string; recordId: string; projectId: string }) {
  const t = useTranslations("crew.positions");
  const [open, setOpen] = useState(false);
  const loaded = useOnDemand(panel, open);
  const preload = () => void panel.load();
  return (
    <div className="flex flex-col items-start gap-8">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={preload}
        onFocus={preload}
      >
        {t("assignRecord")}
      </Button>
      {open && loaded ? <loaded.RecordPositionPanel {...props} /> : null}
    </div>
  );
}
