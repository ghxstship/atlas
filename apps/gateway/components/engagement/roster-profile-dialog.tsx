"use client";

import { workDetailLabelKey, type SharedWorkDetails } from "@xos/data/work-details";
import { Button, Dialog, InlineAlert, PropertyList, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { viewRosterProfileAction } from "@/lib/actions/roster";
import { useCopy } from "./forms";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The profile of a person on the roster (R4, owner decision 4), read once when the dialog opens
 * through app.roster_shared_work_details, which logs the read. A company reader reads every category,
 * and the dialog shows every field the read returns, enums in the reader's language; allergies show as
 * On file, never their text, and the passport number stays masked.
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
  const wd = useTranslations("workDetails") as unknown as Translate;
  const [details, setDetails] = useState<SharedWorkDetails | null>(null);
  const [phones, setPhones] = useState<Readonly<Record<string, string>>>({});
  const [outcome, setOutcome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void viewRosterProfileAction(rosterEntryId).then((r) => {
      if (!live) return;
      if (r.ok) {
        setPhones(r.phones);
        setDetails(r.details);
      } else setOutcome(r.outcome);
    });
    return () => {
      live = false;
    };
  }, [rosterEntryId]);
  const none = t("roster.profile.none");
  const items = details ? profileItems(details, phones, t, wd, none) : [];
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

const lines = (values: (string | null | undefined)[]) => values.filter((v): v is string => !!v);

/** Each category the reader may read, every field of it, enums in the reader's language. */
function profileItems(
  d: SharedWorkDetails,
  phones: Readonly<Record<string, string>>,
  t: Translate,
  wd: Translate,
  none: string,
) {
  const label = (group: string, value: string) => wd(`${group}.${workDetailLabelKey(value)}`);
  const note = (key: string, value: string | null) => (value ? `${wd(key)}: ${value}` : null);
  const phone = (e164: string) => phones[e164] ?? e164;
  const block = (values: string[]) =>
    values.length === 0 ? (
      none
    ) : (
      <span className="flex flex-col gap-2">
        {values.map((v) => (
          <span key={v}>{v}</span>
        ))}
      </span>
    );
  const items: { label: string; value: ReactNode }[] = [];
  if (d.uniform) {
    const u = d.uniform;
    const sizes: [string, string | null][] = [
      ["uniform.shirt", u.shirtSize],
      ["uniform.jacket", u.jacketSize],
      ["uniform.pants", u.pantsSize],
      ["uniform.shoe", u.shoeSize],
      ["uniform.gloves", u.gloveSize],
      ["uniform.hat", u.hatSize],
    ];
    items.push({
      label: t("roster.profile.uniform"),
      value: block(
        lines([
          sizes
            .filter(([, size]) => size)
            .map(([garment, size]) => wd("org.sizes", { garment: wd(garment), size: size ?? "" }))
            .join(" · "),
          note("uniform.notes", u.uniformNotes),
        ]),
      ),
    });
  }
  if (d.dietary) {
    items.push({
      label: t("roster.profile.dietary"),
      value: block(
        lines([
          d.dietary.dietaryNeeds.map((n) => label("dietaryNeeds", n)).join(", "),
          note("org.notes", d.dietary.dietaryNotes),
        ]),
      ),
    });
    items.push({
      label: t("roster.profile.allergies"),
      value: d.dietary.allergies ?? (d.dietary.allergiesOnFile ? t("roster.profile.onFile") : none),
    });
  }
  if (d.accessibility) {
    items.push({
      label: t("roster.profile.accessibility"),
      value: block(
        lines([
          d.accessibility.accessibilityNeeds.map((n) => label("accessibilityNeeds", n)).join(", "),
          note("org.notes", d.accessibility.accessibilityNotes),
        ]),
      ),
    });
  }
  if (d.emergencyContacts) {
    items.push({
      label: t("roster.profile.emergency"),
      value: block(
        d.emergencyContacts.map((c) =>
          lines([
            c.fullName,
            c.relationship,
            phone(c.phoneE164),
            c.alternatePhoneE164 ? phone(c.alternatePhoneE164) : null,
            c.email,
          ]).join(" · "),
        ),
      ),
    });
  }
  if (d.travel) {
    const tr = d.travel;
    items.push({
      label: t("roster.profile.travel"),
      value: block(
        lines([
          tr.seatPreference
            ? `${wd("org.seat")}: ${label("seatPreferences", tr.seatPreference)}`
            : null,
          note("org.meal", tr.mealPreference),
          note("org.airport", tr.homeAirport),
          ...tr.loyaltyPrograms.map((l) =>
            wd("loyalty.line", {
              kind: label("loyaltyKinds", l.programKind),
              program: l.programName,
              member: l.memberNumber,
            }),
          ),
        ]),
      ),
    });
  }
  if (d.passport) {
    const pp = d.passport;
    items.push({
      label: t("roster.profile.passport"),
      value: block(
        lines([
          note("org.passportName", pp.passportName),
          note("org.passportCountry", pp.passportIssuingCountry),
          note("org.passportExpires", pp.passportExpiresOn),
          pp.passportNumberLast4
            ? t("roster.profile.passportMasked", { last4: pp.passportNumberLast4 })
            : null,
        ]),
      ),
    });
  }
  return items;
}
