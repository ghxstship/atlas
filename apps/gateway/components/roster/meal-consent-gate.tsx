"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useState } from "react";

// The step loads with its first open, so the wizard carries none of its code.
const MealConsentDialog = dynamic(() =>
  import("./meal-consent-dialog").then((m) => m.MealConsentDialog),
);

type Translate = (key: string) => string;

/** In place of the meal preference field until the person consents, or the company attests (ADR 0164). */
export function MealConsentGate({
  rosterEntryId,
  mode,
  onGranted,
}: {
  rosterEntryId: string;
  mode: "person" | "company";
  onGranted: () => void;
}) {
  const t = useTranslations("workDetails.consent.meal") as unknown as Translate;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-8">
      <p className="m-0 text-text-13 text-text-secondary">{t("locked")}</p>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {mode === "person" ? t("addOwn") : t("addForPerson")}
      </Button>
      {open ? (
        <MealConsentDialog
          rosterEntryId={rosterEntryId}
          mode={mode}
          onClose={() => setOpen(false)}
          onGranted={() => {
            setOpen(false);
            onGranted();
          }}
        />
      ) : null}
    </div>
  );
}
