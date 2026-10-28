"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useCopy } from "./forms";

/**
 * View profile on a roster row (R4). The dialog's code loads only when it first opens, and it reads
 * the person's work details then, so each open is one logged read and the list itself reads nothing.
 */
const RosterProfileDialog = dynamic(() =>
  import("./roster-profile-dialog").then((m) => m.RosterProfileDialog),
);

export function RosterProfileButton({ rosterEntryId, name }: { rosterEntryId: string; name: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={t("roster.viewProfileOf", { name })}
        onClick={() => setOpen(true)}
      >
        {t("roster.viewProfile")}
      </Button>
      {open ? (
        <RosterProfileDialog rosterEntryId={rosterEntryId} name={name} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
