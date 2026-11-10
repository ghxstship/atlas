"use client";

import { Button } from "@xos/ui";
import { useState } from "react";
import { useCopy } from "@/components/collection-kit/use-copy";
import { MoreActions } from "@/components/shell/more-actions";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { MaterialTarget } from "@/lib/quick-add/material-actions";

const panel = onDemand(() => import("./material-quick-add"));

/**
 * Paste list (B11, G-107) on the Needs page and a Proposed order. The parser and the preview load on the click, so
 * nothing lands in the page's JavaScript. A control that renders on arrival is a plain button; only what it opens is on
 * demand, so no first click is lost. Across events, `projects` lets the person choose where the needs go. With
 * `importLink` (the Needs page), Paste list and Import share one More menu, so the header keeps to five actions (gate 27).
 */
export function MaterialQuickAddButton({
  org,
  target,
  projects,
  importLink,
}: {
  org: string;
  target: MaterialTarget;
  projects?: readonly { value: string; label: string }[];
  importLink?: { readonly label: string; readonly href: string };
}) {
  const t = useCopy("procurement.needs");
  const [open, setOpen] = useState(false);
  const loaded = useOnDemand(panel, open);
  return (
    <>
      {importLink ? (
        <MoreActions
          label={t("paste.more")}
          items={[
            { label: t("paste.open"), onSelect: () => setOpen(true) },
            { label: importLink.label, href: importLink.href },
          ]}
        />
      ) : (
        <Button
          variant="secondary"
          onMouseEnter={() => void panel.load()}
          onClick={() => setOpen(true)}
        >
          {t("paste.open")}
        </Button>
      )}
      {open && loaded ? (
        <loaded.MaterialQuickAdd
          org={org}
          target={target}
          {...(projects ? { projects } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
