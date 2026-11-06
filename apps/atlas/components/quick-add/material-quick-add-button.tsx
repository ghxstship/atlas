"use client";

import { Button } from "@xos/ui";
import { useState } from "react";
import { useCopy } from "@/components/collection-kit/use-copy";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { MaterialTarget } from "@/lib/quick-add/material-actions";

const panel = onDemand(() => import("./material-quick-add"));

/**
 * Paste list (B11, G-107) on the Needs page and a Proposed order. The parser and the preview load on the click, so
 * nothing lands in the page's JavaScript. A control that renders on arrival is a plain button; only what it opens is on
 * demand, so no first click is lost.
 */
export function MaterialQuickAddButton({ org, target }: { org: string; target: MaterialTarget }) {
  const t = useCopy("procurement.needs");
  const [open, setOpen] = useState(false);
  const loaded = useOnDemand(panel, open);
  return (
    <>
      <Button variant="secondary" onMouseEnter={() => void panel.load()} onClick={() => setOpen(true)}>
        {t("paste.open")}
      </Button>
      {open && loaded ? (
        <loaded.MaterialQuickAdd org={org} target={target} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
