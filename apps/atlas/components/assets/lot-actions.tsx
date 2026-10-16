"use client";

import { Button } from "@xos/ui";
import { useState } from "react";
import { useAssetsCopy } from "./copy";
import { CustodyMoveDialog, type CustodyPickers } from "./custody";
import { CountLotForm } from "./forms";

/** A lot's actions: check a quantity out or in through the scan RPC, and recount. */
export function LotActions({
  org,
  lotId,
  code,
  label,
  onHand,
  pickers,
  canCount,
  canMove,
}: {
  org: string;
  lotId: string;
  code: string;
  label: string;
  onHand: number;
  pickers: CustodyPickers;
  canCount: boolean;
  canMove: boolean;
}) {
  const t = useAssetsCopy();
  const [moving, setMoving] = useState<"check-out" | "check-in" | null>(null);
  const [counting, setCounting] = useState(false);
  if (!canCount && !canMove) return null;
  return (
    <div className="flex flex-wrap gap-8">
      {canMove ? (
        <>
          <Button size="sm" variant="primary" onClick={() => setMoving("check-out")}>
            {t("actions.checkOut")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setMoving("check-in")}>
            {t("actions.checkIn")}
          </Button>
        </>
      ) : null}
      {canCount ? (
        <Button size="sm" variant="secondary" icon="ListChecks" onClick={() => setCounting(true)}>
          {t("lots.count.open")}
        </Button>
      ) : null}
      {moving ? (
        <CustodyMoveDialog
          org={org}
          code={code}
          label={label}
          action={moving}
          lot
          pickers={pickers}
          open
          setOpen={(next) => {
            if (!next) setMoving(null);
          }}
        />
      ) : null}
      {counting ? (
        <CountLotForm org={org} lotId={lotId} onHand={onHand} open setOpen={setCounting} />
      ) : null}
    </div>
  );
}
