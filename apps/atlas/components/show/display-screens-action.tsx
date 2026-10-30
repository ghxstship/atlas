"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";

/** The dialog and its writes load the first time someone opens it (ADR 0027). */
const displayLinkDialog = onDemand(() => import("./display-link-dialog"));

/**
 * The Display screens action of the run-of-show peek (P1, ADR 0130), shown to people who edit the
 * running order. The database still checks show.run_of_show.write on the project.
 */
export function DisplayScreensAction({
  org,
  run,
}: {
  org: string;
  run: { readonly id: string; readonly name: string };
}) {
  const t = useTranslations("show.display");
  const [open, setOpen] = useState(false);
  const dialog = useOnDemand(displayLinkDialog, open);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        icon="Radio"
        onMouseEnter={() => void displayLinkDialog.load()}
        onFocus={() => void displayLinkDialog.load()}
        onClick={() => setOpen(true)}
      >
        {t("action")}
      </Button>
      {open && dialog ? (
        <dialog.DisplayLinkDialog org={org} run={run} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
