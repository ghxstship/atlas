"use client";

import { Button } from "@xos/ui";
import { useFormatter } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useCopy } from "@/components/work/action-ui";

// The anchor dialog renders nothing until opened, so it loads then (ADR 0027).
const AnchorDialog = dynamic(() => import("./anchor-dialog").then((m) => m.AnchorDialog));

/**
 * The project Schedule tab's anchor line (B4, G-44): "Anchor: {date}" with Move anchor, or Set anchor while none is
 * set. Setting the first anchor is a plain update that moves nothing; moving it previews and moves the plan.
 */
export function AnchorBar({
  org,
  project,
  anchorOn,
  canSet,
  canMove,
}: {
  org: string;
  project: { id: string; key: string };
  anchorOn: string | null;
  canSet: boolean;
  canMove: boolean;
}) {
  const t = useCopy("schedule");
  const format = useFormatter();
  const [open, setOpen] = useState<"set" | "move" | null>(null);
  const date = anchorOn
    ? format.dateTime(new Date(`${anchorOn}T12:00:00Z`), {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;
  return (
    <div className="flex flex-wrap items-center gap-8" data-testid="anchor-bar">
      <p className="m-0 text-text-13">{date ? t("anchor.current", { date }) : t("anchor.none")}</p>
      {anchorOn && canMove ? (
        <Button size="sm" icon="CalendarClock" onClick={() => setOpen("move")}>
          {t("anchor.move")}
        </Button>
      ) : null}
      {!anchorOn && canSet ? (
        <Button size="sm" icon="Pin" onClick={() => setOpen("set")}>
          {t("anchor.set")}
        </Button>
      ) : null}
      {open ? (
        <AnchorDialog
          org={org}
          project={project}
          anchorOn={anchorOn}
          mode={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
