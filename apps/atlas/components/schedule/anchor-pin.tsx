"use client";

import { Switch } from "@xos/ui";
import { useState } from "react";
import { ActionErrorAlert, useAction, useCopy } from "@/components/work/action-ui";
import { setRecordAnchorPinnedAction } from "./depth-actions";

/**
 * A record's anchor pin (B4, G-44): while on, the record stays on its dates when the project's anchor moves, such as
 * a permit deadline the authority set. Loaded on demand on the record page for people who may change the timeline.
 */
export function AnchorPin({
  org,
  recordId,
  pinned,
}: {
  org: string;
  recordId: string;
  pinned: boolean;
}) {
  const t = useCopy("schedule");
  const { pending, error, run } = useAction();
  const [on, setOn] = useState(pinned);
  return (
    <div className="flex flex-col gap-4">
      <Switch
        id={`anchor-pin-${recordId}`}
        label={t("anchor.pin")}
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          run(
            () => setRecordAnchorPinnedAction(org, { recordId, pinned: next }),
            () => undefined,
          );
        }}
      />
      <ActionErrorAlert error={error} />
    </div>
  );
}
