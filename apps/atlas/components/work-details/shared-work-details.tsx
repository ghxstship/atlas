import {
  getSharedWorkDetails,
  workDetailLabelKey,
  type SharedWorkDetails,
  type WorkDetailCategory,
} from "@xos/data/work-details";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { InlineAlert } from "@/components/ui";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { revealSharedPassportAction } from "@/lib/work-details/actions";
import { WorkDetailsForm } from "./form";

/**
 * The engaging org's view of what the engagement's person shared (Section 4.5.6 item 10): only the
 * categories the person shared with this engagement, only while it is open, and only those the
 * viewer's project capabilities cover. The passport number stays masked; a holder of the
 * government-id capability reveals it with a reason. Each view is logged in the person's access log
 * and the org's audit ledger by app.shared_work_details.
 */

const P = "workDetails";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-13">
      <h3 className="m-0 text-label-13 font-semibold">{title}</h3>
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

const label = (t: Translate, group: string, value: string) =>
  t(`${P}.${group}.${workDetailLabelKey(value)}`);

function Hidden({ t }: { t: Translate }) {
  return <p className="m-0 text-text-secondary">{t(`${P}.org.hidden`)}</p>;
}

function categoryBody(
  c: WorkDetailCategory,
  d: SharedWorkDetails,
  t: Translate,
  region: string | null,
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
                {formatPhone(e.phoneE164, region)}
              </a>
              {e.alternatePhoneE164 ? ` · ${formatPhone(e.alternatePhoneE164, region)}` : ""}
              {e.email ? ` · ${e.email}` : ""}
            </li>
          ))}
        </ol>
      );
    case "Uniform Sizes": {
      if (d.uniform === null) return <Hidden t={t} />;
      const u = d.uniform;
      const sizes: [string, string | null][] = [
        [t(`${P}.uniform.shirt`), u.shirtSize],
        [t(`${P}.uniform.jacket`), u.jacketSize],
        [t(`${P}.uniform.pants`), u.pantsSize],
        [t(`${P}.uniform.shoe`), u.shoeSize],
        [t(`${P}.uniform.gloves`), u.gloveSize],
        [t(`${P}.uniform.hat`), u.hatSize],
      ];
      return (
        <>
          <p className="m-0">
            {sizes
              .filter(([, size]) => size)
              .map(([garment, size]) => t(`${P}.org.sizes`, { garment, size: size ?? "" }))
              .join(" · ")}
          </p>
          <Line label={t(`${P}.org.notes`)} value={u.uniformNotes} />
        </>
      );
    }
    case "Dietary Needs":
      return d.dietary === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line
            label={t(`${P}.org.needs`)}
            value={d.dietary.dietaryNeeds.map((n) => label(t, "dietaryNeeds", n)).join(", ")}
          />
          <Line label={t(`${P}.org.allergies`)} value={d.dietary.allergies} />
          <Line label={t(`${P}.org.notes`)} value={d.dietary.dietaryNotes} />
        </>
      );
    case "Accessibility Needs":
      return d.accessibility === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line
            label={t(`${P}.org.needs`)}
            value={d.accessibility.accessibilityNeeds
              .map((n) => label(t, "accessibilityNeeds", n))
              .join(", ")}
          />
          <Line label={t(`${P}.org.notes`)} value={d.accessibility.accessibilityNotes} />
        </>
      );
    case "Travel Profile":
      return d.travel === null ? (
        <Hidden t={t} />
      ) : (
        <>
          <Line
            label={t(`${P}.org.seat`)}
            value={
              d.travel.seatPreference ? label(t, "seatPreferences", d.travel.seatPreference) : null
            }
          />
          <Line label={t(`${P}.org.meal`)} value={d.travel.mealPreference} />
          <Line label={t(`${P}.org.airport`)} value={d.travel.homeAirport} />
          <Line
            label={t(`${P}.org.loyalty`)}
            value={d.travel.loyaltyPrograms
              .map((l) =>
                t(`${P}.loyalty.line`, {
                  kind: label(t, "loyaltyKinds", l.programKind),
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
          <Line label={t(`${P}.org.passportName`)} value={d.passport.passportName} />
          <Line label={t(`${P}.org.passportCountry`)} value={d.passport.passportIssuingCountry} />
          <Line label={t(`${P}.org.passportExpires`)} value={d.passport.passportExpiresOn} />
          <p className="m-0">
            {d.passport.passportNumberLast4
              ? t(`${P}.org.passportNumber`, { last4: d.passport.passportNumberLast4 })
              : t(`${P}.org.passportNone`)}
          </p>
        </>
      );
  }
}

export async function SharedWorkDetailsSection({
  ctx,
  engagementId,
  partyName,
}: {
  ctx: OrgContext;
  engagementId: string;
  partyName: string | null;
}) {
  const [t, locale, shared] = await Promise.all([
    getTranslate(),
    getLocale(),
    getSharedWorkDetails(ctx.viewer.db, engagementId),
  ]);
  const name = partyName ?? t(`${P}.org.unnamed`);
  // A viewer whose project capabilities cover no category is not told whether anything was shared.
  if (!shared.ok && shared.error.kind === "not-found") return null;
  return (
    <section
      id="engagement-work-details"
      aria-labelledby="engagement-work-details-heading"
      className="flex flex-col gap-8"
    >
      <h2 id="engagement-work-details-heading" className="m-0 text-heading-14 font-semibold">
        {t(`${P}.org.title`)}
      </h2>
      {!shared.ok ? (
        <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>
      ) : !shared.data.sharingOpen ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.org.closed`)}</p>
      ) : shared.data.categories.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.org.notShared`, { name })}</p>
      ) : (
        <>
          <p className="m-0 text-text-13 text-text-secondary">
            {t(`${P}.org.description`, { name })}
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-8">
            {shared.data.categories.map((c) => (
              <Block key={c} title={label(t, "categories", c)}>
                {categoryBody(c, shared.data, t, regionFromLocale(locale))}
              </Block>
            ))}
          </div>
          {shared.data.passport?.passportNumberMasked &&
          ctx.capabilities.has("data.restricted.read.government_id") ? (
            <WorkDetailsForm
              action={revealSharedPassportAction}
              hidden={{ org: ctx.org.slug, engagementId }}
              label={t(`${P}.org.reveal`)}
              submitLabel={t(`${P}.org.reveal`)}
              fields={[
                {
                  kind: "text",
                  name: "reason",
                  label: t(`${P}.org.revealReason`),
                  help: t(`${P}.org.revealReasonHelp`),
                  width: "100%",
                },
              ]}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
