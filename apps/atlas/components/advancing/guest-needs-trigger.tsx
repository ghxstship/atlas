"use client";

import type { GuestNeedsState } from "@xos/data/sensitive-consent";
import { Button, Tag } from "@xos/ui";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";

// The step loads with its first open, so the guest list carries none of its code.
const GuestNeedsDialog = dynamic(() =>
  import("./guest-needs-dialog").then((m) => m.GuestNeedsDialog),
);

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * A guest's dietary and access needs (ADR 0164): optional, opened from the guest's row. Whoever keeps the list first
 * confirms they have the guest's authority and that the guest has had notice; the database records that and who gave it.
 */
export function GuestNeedsTrigger({
  hidden,
  guestId,
  guestName,
  state,
}: {
  hidden: Readonly<Record<string, string>>;
  guestId: string;
  guestName: string;
  state: GuestNeedsState | null;
}) {
  const t = useTranslations("workDetails.consent.guestNeeds") as unknown as Translate;
  const [open, setOpen] = useState(false);
  return (
    <>
      {state ? <Tag tone="neutral">{t("tag")}</Tag> : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        title={t("openNamed", { name: guestName })}
        aria-label={t("openNamed", { name: guestName })}
        onClick={() => setOpen(true)}
      >
        {t("open")}
      </Button>
      {open ? (
        <GuestNeedsDialog
          hidden={hidden}
          guestId={guestId}
          guestName={guestName}
          state={state}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
