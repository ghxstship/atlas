"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";

/**
 * Project details on a crew row (R5). The drawer's code, with the wizard it can open, loads only when it first opens,
 * and it reads the facts then, so each open is one logged read and the list itself reads nothing.
 */
const RosterFactsDrawer = dynamic(() =>
  import("./roster-facts-drawer").then((m) => m.RosterFactsDrawer),
);

export function RosterFactsButton({
  rosterEntryId,
  name,
  companyName,
  projectName,
}: {
  rosterEntryId: string;
  name: string;
  companyName: string;
  projectName: string;
}) {
  const t = useTranslations("workDetails.projectFacts");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("drawerOpen")}
      </Button>
      {open ? (
        <RosterFactsDrawer
          rosterEntryId={rosterEntryId}
          name={name}
          companyName={companyName}
          projectName={projectName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
