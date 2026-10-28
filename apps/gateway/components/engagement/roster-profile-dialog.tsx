"use client";

import type { SharedWorkDetails } from "@xos/data/work-details";
import { Button, Dialog, InlineAlert, PropertyList, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { viewRosterProfileAction } from "@/lib/actions/roster";
import { useCopy } from "./forms";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The profile of a person on the roster (R4, owner decision 4), read once when the dialog opens
 * through app.roster_shared_work_details, which logs the read. A company reader reads every category;
 * allergies show as On file, never their text, and the passport number stays masked.
 */
export function RosterProfileDialog({
  rosterEntryId,
  name,
  onClose,
}: {
  rosterEntryId: string;
  name: string;
  onClose: () => void;
}) {
  const t = useCopy();
  const outcomes = useTranslations("gateway.outcomes") as unknown as Translate;
  const [details, setDetails] = useState<SharedWorkDetails | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void viewRosterProfileAction(rosterEntryId).then((r) => {
      if (!live) return;
      if (r.ok) setDetails(r.details);
      else setOutcome(r.outcome);
    });
    return () => {
      live = false;
    };
  }, [rosterEntryId]);
  const none = t("roster.profile.none");
  const items = details ? profileItems(details, t, none) : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("roster.profile.title", { name })}
      description={t("roster.profile.sentence")}
      actions={
        <Button type="button" onClick={onClose}>
          {t("roster.profile.close")}
        </Button>
      }
    >
      {outcome ? <InlineAlert tone="danger">{outcomes(outcome)}</InlineAlert> : null}
      {details === null && outcome === null ? <Skeleton width="100%" height={120} /> : null}
      {details && items.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">{t("roster.profile.nothing")}</p>
      ) : null}
      {items.length > 0 ? <PropertyList items={items} /> : null}
    </Dialog>
  );
}

function profileItems(d: SharedWorkDetails, t: Translate, none: string) {
  const items: { label: string; value: string }[] = [];
  if (d.uniform) {
    const u = d.uniform;
    items.push({
      label: t("roster.profile.uniform"),
      value: [u.shirtSize, u.jacketSize, u.pantsSize, u.shoeSize, u.gloveSize, u.hatSize].filter(Boolean).join(" · ") || none,
    });
  }
  if (d.dietary) {
    items.push({ label: t("roster.profile.dietary"), value: d.dietary.dietaryNeeds.join(", ") || none });
    items.push({
      label: t("roster.profile.allergies"),
      value: d.dietary.allergies ?? (d.dietary.allergiesOnFile ? t("roster.profile.onFile") : none),
    });
  }
  if (d.accessibility) {
    items.push({
      label: t("roster.profile.accessibility"),
      value: d.accessibility.accessibilityNeeds.join(", ") || none,
    });
  }
  if (d.emergencyContacts) {
    items.push({
      label: t("roster.profile.emergency"),
      value: d.emergencyContacts.map((c) => `${c.fullName} ${c.phoneE164}`).join(" · ") || none,
    });
  }
  if (d.travel) {
    items.push({
      label: t("roster.profile.travel"),
      value: [d.travel.seatPreference, d.travel.homeAirport].filter(Boolean).join(" · ") || none,
    });
  }
  if (d.passport) {
    items.push({
      label: t("roster.profile.passport"),
      value: d.passport.passportNumberLast4
        ? t("roster.profile.passportMasked", { last4: d.passport.passportNumberLast4 })
        : none,
    });
  }
  return items;
}
