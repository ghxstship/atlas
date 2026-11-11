"use client";

import type { GuestEmailKind } from "@xos/data/advancing";
import { Button } from "@xos/ui";
import { useState } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import type { EmailableGuest } from "./guest-email-types";
import { useCopy } from "./use-copy";

const dialog = onDemand(() => import("./guest-email-dialog"));

const preload = () => {
  dialog.load().catch(() => undefined);
};

/**
 * Email guests on the guest list (B8, gap G-71): the button renders with the page and answers its first click; the
 * dialog's code loads when the button is hovered, focused or clicked, so the guest list carries none of it.
 */
export function GuestEmailTrigger(props: {
  org: string;
  projectId: string;
  projectName: string;
  guests: readonly EmailableGuest[];
  kinds: readonly GuestEmailKind[];
  locale: "en-US" | "es-US";
}) {
  const t = useCopy("advancing.guests.email");
  const [open, setOpen] = useState(false);
  // A dialog that has sent starts again when it closes: an Invitation is often followed by a Pass.
  const [round, setRound] = useState(0);
  const loaded = useOnDemand(dialog, open);
  return (
    <>
      <Button
        variant="secondary"
        icon="Mail"
        onMouseEnter={preload}
        onFocus={preload}
        onClick={() => setOpen(true)}
      >
        {t("action")}
      </Button>
      {loaded ? (
        <loaded.GuestEmailDialog
          key={round}
          {...props}
          open={open}
          onOpenChange={(next, sent) => {
            setOpen(next);
            if (!next && sent) setRound((r) => r + 1);
          }}
        />
      ) : null}
    </>
  );
}
