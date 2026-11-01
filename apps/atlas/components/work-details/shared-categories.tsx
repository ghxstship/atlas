import {
  workDetailLabelKey,
  type SharedWorkDetails,
  type WorkDetailCategory,
} from "@xos/data/work-details";
import type { ReactNode } from "react";

/**
 * One shared work details category as the engaging org or a roster reviewer reads it (Section 4.5.6
 * item 10). Shared by the engagement's work details section (server) and the crew roster peek
 * (client, R4), so it holds no hooks and no phone metadata: the caller formats phone numbers. `t` is
 * scoped to the workDetails namespace. Since R6a allergies are Restricted: a reader without the
 * medical capability sees a locked notice, and a medical reader also gets the Medical block.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function workDetailLabel(t: Translate, group: string, value: string): string {
  return t(`${group}.${workDetailLabelKey(value)}`);
}

export function CategoryBlock({
  title,
  heading: Heading = "h3",
  children,
}: {
  title: string;
  heading?: "h3" | "h4";
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-13">
      <Heading className="m-0 text-label-13 font-semibold">{title}</Heading>
      {children}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <p className="m-0">
      <span className="text-text-secondary">{label}: </span>
      {value}
    </p>
  );
}

function Hidden({ t }: { t: Translate }) {
  return <p className="m-0 text-text-secondary">{t("org.hidden")}</p>;
}

function AllergiesLocked({ t }: { t: Translate }) {
  return (
    <p className="m-0 text-text-secondary">
      <span className="text-text-secondary">{t("org.allergies")}: </span>
      {t("org.allergiesMasked")}
    </p>
  );
}

/** The Restricted medical read (R6a): the allergies, for a holder of the medical capability. */
export function MedicalBlock({
  d,
  t,
  heading = "h3",
}: {
  d: SharedWorkDetails;
  t: Translate;
  heading?: "h3" | "h4";
}) {
  if (d.medical === null) return null;
  return (
    <CategoryBlock title={t("org.medical.title")} heading={heading}>
      <p className="m-0 text-text-secondary">{t("org.medical.description")}</p>
      <Line label={t("org.allergies")} value={d.medical.allergies} />
      {d.medical.allergies === null ? (
        <p className="m-0 text-text-secondary">{t("org.medical.none")}</p>
      ) : null}
    </CategoryBlock>
  );
}

export function categoryBody(
  c: WorkDetailCategory,
  d: SharedWorkDetails,
  t: Translate,
  phone: (e164: string) => string,
): ReactNode {
  switch (c) {
    case "Emergency Contacts":
      return d.emergencyContacts === null ? (
        <Hidden t={t} />
      ) : (
        <ol className="m-0 flex list-decimal flex-col gap-2 ps-16">
          {d.emergencyContacts.map((e, i) => (
            <li key={`${e.phoneE164}-${i}`}>
              {e.fullName}
              {e.relationship ? ` · ${e.relationship}` : ""} ·{" "}
              <a href={`tel:${e.phoneE164}`} className="underline">
                {phone(e.phoneE164)}
              </a>
              {e.alternatePhoneE164 ? ` · ${phone(e.alternatePhoneE164)}` : ""}
              {e.email ? ` · ${e.email}` : ""}
            </li>
          ))}
        </ol>
      );
    case "Contact":
      return d.contact === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line label={t("org.contactEmail")} value={d.contact.email} />
          <Line
            label={t("org.contactPhone")}
            value={d.contact.phone ? phone(d.contact.phone) : null}
          />
          {d.contact.email === null && d.contact.phone === null ? (
            <p className="m-0 text-text-secondary">{t("org.contactNone")}</p>
          ) : null}
        </>
      );
    // Retired in R6a (2664): no live share names it, and sizes are read per roster entry.
    case "Uniform Sizes":
      return null;
    case "Dietary Needs":
      return d.dietary === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line
            label={t("org.needs")}
            value={d.dietary.dietaryNeeds
              .map((n) => workDetailLabel(t, "dietaryNeeds", n))
              .join(", ")}
          />
          <Line label={t("org.allergies")} value={d.dietary.allergies} />
          {/* R6a: allergies are Restricted; a reader without the medical capability sees them locked. */}
          {d.dietary.allergiesMasked ? <AllergiesLocked t={t} /> : null}
          <Line label={t("org.notes")} value={d.dietary.dietaryNotes} />
        </>
      );
    case "Accessibility Needs":
      return d.accessibility === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line
            label={t("org.needs")}
            value={d.accessibility.accessibilityNeeds
              .map((n) => workDetailLabel(t, "accessibilityNeeds", n))
              .join(", ")}
          />
          <Line label={t("org.notes")} value={d.accessibility.accessibilityNotes} />
        </>
      );
    case "Travel Profile":
      return d.travel === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line
            label={t("org.loyalty")}
            value={d.travel.loyaltyPrograms
              .map((l) =>
                t("loyalty.line", {
                  kind: workDetailLabel(t, "loyaltyKinds", l.programKind),
                  program: l.programName,
                  member: l.memberNumber,
                }),
              )
              .join("; ")}
          />
        </>
      );
    case "Passport":
      return d.passport === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line label={t("org.passportName")} value={d.passport.passportName} />
          <Line label={t("org.passportCountry")} value={d.passport.passportIssuingCountry} />
          <Line label={t("org.passportExpires")} value={d.passport.passportExpiresOn} />
          <p className="m-0">
            {d.passport.passportNumberLast4
              ? t("org.passportNumber", { last4: d.passport.passportNumberLast4 })
              : t("org.passportNone")}
          </p>
        </>
      );
  }
}

/** Every phone number in a read, so a server caller can format them for a client one. */
export function sharedPhones(d: SharedWorkDetails): string[] {
  return [
    ...(d.emergencyContacts ?? []).flatMap((e) =>
      e.alternatePhoneE164 ? [e.phoneE164, e.alternatePhoneE164] : [e.phoneE164],
    ),
    ...(d.contact?.phone ? [d.contact.phone] : []),
  ];
}
