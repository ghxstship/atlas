"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";

/**
 * Project details on a crew row (R5). The drawer's code, with the wizard it can open, loads only when it first opens,
 * and it reads the facts then, so each open is one logged read and the list itself reads nothing. `self` is the
 * person's own button (Gateway Home's roster row and updates): the drawer is titled Project details, not by a name.
 */
const RosterFactsDrawer = dynamic(() =>
  import("./roster-facts-drawer").then((m) => m.RosterFactsDrawer),
);

export function RosterFactsButton({
  rosterEntryId,
  name,
  companyName,
  projectName,
  self = false,
}: {
  rosterEntryId: string;
  name: string;
  companyName: string;
  projectName: string;
  self?: boolean;
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
          self={self}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
