"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

/** The dialog and its writes load the first time someone opens it (ADR 0027). */
const showcallerLinkDialog = onDemand(() => import("./showcaller-link-dialog"));

/**
 * The Showcaller links action of the run-of-show peek (B3, ADR 0142), beside P1's Display screens, shown to
 * people who edit the running order and call its cues. The database still checks both capabilities and that the
 * org is not read-only.
 */
export function ShowcallerLinksAction({
  org,
  run,
}: {
  org: string;
  run: { readonly id: string; readonly name: string; readonly showDate: string };
}) {
  const t = useTranslations("show.showcallerLinks");
  const [open, setOpen] = useState(false);
  const dialog = useOnDemand(showcallerLinkDialog, open);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        icon="Megaphone"
        onMouseEnter={() => void showcallerLinkDialog.load()}
        onFocus={() => void showcallerLinkDialog.load()}
        onClick={() => setOpen(true)}
      >
        {t("action")}
      </Button>
      {open && dialog ? (
        <dialog.ShowcallerLinkDialog org={org} run={run} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
