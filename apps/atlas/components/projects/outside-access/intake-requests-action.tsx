"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { ProjectKeyRef } from "@/lib/outside-access/actions";

/** The panel and its reads load on the first click (ADR 0027); the board is shared, so nothing eager goes with it. */
const panel = onDemand(() => import("./intake-requests-dialog"));

/** Intake requests on the project's Engagements tab (B2, ADR 0141): a static, secondary control. */
export function IntakeRequestsAction({ refs }: { refs: ProjectKeyRef }) {
  const t = useTranslations("projects.outsideAccess.requests");
  const [open, setOpen] = useState(false);
  const dialog = useOnDemand(panel, open);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onMouseEnter={() => void panel.load()}
        onFocus={() => void panel.load()}
        onClick={() => setOpen(true)}
      >
        {t("action")}
      </Button>
      {open && dialog ? <dialog.IntakeRequestsDialog refs={refs} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
