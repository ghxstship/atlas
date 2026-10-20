import {
  ACCESSIBILITY_NEEDS,
  DIETARY_NEEDS,
  GARMENT_LETTER_SIZES,
  LOYALTY_PROGRAM_KINDS,
  SEAT_PREFERENCES,
  WORK_DETAIL_CATEGORIES,
  getMyNameParts,
  getMyWorkDetails,
  listMyEmergencyContacts,
  listMyLoyaltyPrograms,
  listMyWorkDetailEvents,
  listMyWorkDetailSharing,
  workDetailLabelKey,
  workDetailLogKey,
  type WorkDetails,
} from "@xos/data/work-details";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { InlineAlert } from "@/components/ui";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import {
  addContactAction,
  addLoyaltyAction,
  clearPassportNumberAction,
  removeContactAction,
  removeLoyaltyAction,
  revealMyPassportAction,
  revokeShareAction,
  saveAccessibilityAction,
  saveDietaryAction,
  saveNamePartsAction,
  savePassportAction,
  saveTravelAction,
  saveUniformAction,
  shareAction,
} from "@/lib/work-details/actions";
import { WorkDetailsForm, type WorkDetailsField } from "./form";

/**
 * The person's own Work Details in Atlas (Section 4.5.6 item 10, A65-003): emergency contacts,
 * uniform sizes, dietary and accessibility needs, the travel profile and passport, which
 * engagements see what, and the access log. Everything reads with the viewer's client, so only
 * the person's own rows appear. Phones show in national format for the viewer's region and in
 * international format otherwise (Section 15).
 */

const P = "workDetails";

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex max-w-layout-form flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {description ? <p className="m-0 text-text-13 text-text-secondary">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Muted({ children }: { children: string }) {
  return <p className="m-0 text-text-13 text-text-secondary">{children}</p>;
}

function loadFailed(t: Translate) {
  return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
}

function sizeOptions(t: Translate) {
  return [
    { value: "", label: t(`${P}.notSet`) },
    ...GARMENT_LETTER_SIZES.map((s) => ({ value: s, label: s })),
  ];
}

function labelled(t: Translate, group: string, value: string) {
  return t(`${P}.${group}.${workDetailLabelKey(value)}`);
}

function hiddenFor(ctx: OrgContext): Readonly<Record<string, string>> {
  return { org: ctx.org.slug };
}

// My work details ------------------------------------------------------------------------------------

async function ContactsSection({
  ctx,
  t,
  region,
}: {
  ctx: OrgContext;
  t: Translate;
  region: string | null;
}) {
  const contacts = await listMyEmergencyContacts(ctx.viewer.db);
  if (!contacts.ok) return loadFailed(t);
  const next =
    contacts.data.length === 0 ? 0 : Math.max(...contacts.data.map((c) => c.sortOrder)) + 1;
  return (
    <Section
      id="work-details-contacts"
      title={t(`${P}.contacts.title`)}
      description={t(`${P}.contacts.description`)}
    >
      {contacts.data.length === 0 ? (
        <Muted>{t(`${P}.contacts.none`)}</Muted>
      ) : (
        <ol className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {contacts.data.map((c, index) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-12 py-8">
              <div className="flex min-w-0 flex-col gap-2 text-text-13">
                <span className="font-medium">
                  {c.fullName}
                  {c.relationship ? (
                    <span className="text-text-secondary"> · {c.relationship}</span>
                  ) : null}
                </span>
                <span className="text-text-secondary">
                  {t(`${P}.contacts.order`, { position: index + 1 })} ·{" "}
                  <a href={`tel:${c.phoneE164}`} className="text-text-primary">
                    {formatPhone(c.phoneE164, region)}
                  </a>
                  {c.alternatePhoneE164 ? ` · ${formatPhone(c.alternatePhoneE164, region)}` : ""}
                  {c.email ? ` · ${c.email}` : ""}
                </span>
              </div>
              <WorkDetailsForm
                action={removeContactAction}
                hidden={{ ...hiddenFor(ctx), id: c.id }}
                fields={[]}
                submitLabel={t(`${P}.remove`)}
                label={t(`${P}.removeNamed`, { name: c.fullName })}
                inline
              />
            </li>
          ))}
        </ol>
      )}
      {contacts.data.length < 5 ? (
        <WorkDetailsForm
          action={addContactAction}
          hidden={{ ...hiddenFor(ctx), sortOrder: String(next) }}
          label={t(`${P}.contacts.add`)}
          submitLabel={t(`${P}.contacts.add`)}
          resetOnSuccess
          fields={[
            { kind: "text", name: "fullName", label: t(`${P}.contacts.name`), autoComplete: "off" },
            {
              kind: "text",
              name: "relationship",
              label: t(`${P}.contacts.relationship`),
              width: 180,
            },
            {
              kind: "tel",
              name: "phone",
              label: t(`${P}.contacts.phone`),
              help: t(`${P}.contacts.phoneHelp`, { region: region ?? "US" }),
              autoComplete: "off",
            },
            {
              kind: "tel",
              name: "alternatePhone",
              label: t(`${P}.contacts.alternatePhone`),
              autoComplete: "off",
            },
            { kind: "email", name: "email", label: t(`${P}.contacts.email`), autoComplete: "off" },
          ]}
        />
      ) : null}
    </Section>
  );
}

function UniformSection({ ctx, t, d }: { ctx: OrgContext; t: Translate; d: WorkDetails | null }) {
  return (
    <Section
      id="work-details-uniform"
      title={t(`${P}.uniform.title`)}
      description={t(`${P}.uniform.description`)}
    >
      <WorkDetailsForm
        action={saveUniformAction}
        hidden={hiddenFor(ctx)}
        label={t(`${P}.uniform.title`)}
        submitLabel={t(`${P}.uniform.save`)}
        fields={[
          {
            kind: "select",
            name: "shirtSize",
            label: t(`${P}.uniform.shirt`),
            defaultValue: d?.shirtSize ?? "",
            options: sizeOptions(t),
          },
          {
            kind: "select",
            name: "jacketSize",
            label: t(`${P}.uniform.jacket`),
            defaultValue: d?.jacketSize ?? "",
            options: sizeOptions(t),
          },
          {
            kind: "text",
            name: "pantsSize",
            label: t(`${P}.uniform.pants`),
            help: t(`${P}.uniform.pantsHelp`),
            defaultValue: d?.pantsSize ?? "",
            width: 160,
          },
          {
            kind: "text",
            name: "shoeSize",
            label: t(`${P}.uniform.shoe`),
            help: t(`${P}.uniform.shoeHelp`),
            defaultValue: d?.shoeSize ?? "",
            width: 160,
          },
          {
            kind: "select",
            name: "gloveSize",
            label: t(`${P}.uniform.gloves`),
            defaultValue: d?.gloveSize ?? "",
            options: sizeOptions(t),
          },
          {
            kind: "text",
            name: "hatSize",
            label: t(`${P}.uniform.hat`),
            defaultValue: d?.hatSize ?? "",
            width: 160,
          },
          {
            kind: "textarea",
            name: "uniformNotes",
            label: t(`${P}.uniform.notes`),
            defaultValue: d?.uniformNotes ?? "",
          },
        ]}
      />
    </Section>
  );
}

function NeedsSections({ ctx, t, d }: { ctx: OrgContext; t: Translate; d: WorkDetails | null }) {
  const dietary = d?.dietaryNeeds ?? [];
  const access = d?.accessibilityNeeds ?? [];
  return (
    <>
      <Section
        id="work-details-dietary"
        title={t(`${P}.dietary.title`)}
        description={t(`${P}.dietary.description`)}
      >
        <WorkDetailsForm
          action={saveDietaryAction}
          hidden={hiddenFor(ctx)}
          label={t(`${P}.dietary.title`)}
          submitLabel={t(`${P}.dietary.save`)}
          fields={[
            {
              kind: "choices",
              name: "dietaryNeeds",
              label: t(`${P}.dietary.needs`),
              summary: t(`${P}.dietary.chosen`, { count: dietary.length }),
              options: DIETARY_NEEDS.map((n) => ({
                value: n,
                label: labelled(t, "dietaryNeeds", n),
                checked: dietary.includes(n),
              })),
            },
            {
              kind: "textarea",
              name: "allergies",
              label: t(`${P}.dietary.allergies`),
              help: t(`${P}.dietary.allergiesHelp`),
              defaultValue: d?.allergies ?? "",
            },
            {
              kind: "textarea",
              name: "dietaryNotes",
              label: t(`${P}.dietary.notes`),
              defaultValue: d?.dietaryNotes ?? "",
            },
          ]}
        />
      </Section>
      <Section
        id="work-details-accessibility"
        title={t(`${P}.accessibility.title`)}
        description={t(`${P}.accessibility.description`)}
      >
        <WorkDetailsForm
          action={saveAccessibilityAction}
          hidden={hiddenFor(ctx)}
          label={t(`${P}.accessibility.title`)}
          submitLabel={t(`${P}.accessibility.save`)}
          fields={[
            {
              kind: "choices",
              name: "accessibilityNeeds",
              label: t(`${P}.accessibility.needs`),
              summary: t(`${P}.dietary.chosen`, { count: access.length }),
              options: ACCESSIBILITY_NEEDS.map((n) => ({
                value: n,
                label: labelled(t, "accessibilityNeeds", n),
                checked: access.includes(n),
              })),
            },
            {
              kind: "textarea",
              name: "accessibilityNotes",
              label: t(`${P}.accessibility.notes`),
              defaultValue: d?.accessibilityNotes ?? "",
            },
          ]}
        />
      </Section>
    </>
  );
}

async function TravelSection({
  ctx,
  t,
  d,
}: {
  ctx: OrgContext;
  t: Translate;
  d: WorkDetails | null;
}) {
  const programs = await listMyLoyaltyPrograms(ctx.viewer.db);
  if (!programs.ok) return loadFailed(t);
  return (
    <Section
      id="work-details-travel"
      title={t(`${P}.travel.title`)}
      description={t(`${P}.travel.description`)}
    >
      <WorkDetailsForm
        action={saveTravelAction}
        hidden={hiddenFor(ctx)}
        label={t(`${P}.travel.title`)}
        submitLabel={t(`${P}.travel.save`)}
        fields={[
          {
            kind: "select",
            name: "seatPreference",
            label: t(`${P}.travel.seat`),
            defaultValue: d?.seatPreference ?? "",
            options: [
              { value: "", label: t(`${P}.notSet`) },
              ...SEAT_PREFERENCES.map((s) => ({
                value: s,
                label: labelled(t, "seatPreferences", s),
              })),
            ],
          },
          {
            kind: "text",
            name: "mealPreference",
            label: t(`${P}.travel.meal`),
            help: t(`${P}.travel.mealHelp`),
            defaultValue: d?.mealPreference ?? "",
          },
          {
            kind: "text",
            name: "homeAirport",
            label: t(`${P}.travel.airport`),
            help: t(`${P}.travel.airportHelp`),
            defaultValue: d?.homeAirport ?? "",
            width: 120,
          },
        ]}
      />
      <h3 className="m-0 text-heading-14 font-semibold">{t(`${P}.loyalty.title`)}</h3>
      {programs.data.length === 0 ? (
        <Muted>{t(`${P}.loyalty.none`)}</Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {programs.data.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-12 py-8 text-text-13"
            >
              <span>
                {t(`${P}.loyalty.line`, {
                  kind: labelled(t, "loyaltyKinds", p.programKind),
                  program: p.programName,
                  member: p.memberNumber,
                })}
              </span>
              <WorkDetailsForm
                action={removeLoyaltyAction}
                hidden={{ ...hiddenFor(ctx), id: p.id }}
                fields={[]}
                submitLabel={t(`${P}.remove`)}
                label={t(`${P}.removeNamed`, { name: p.programName })}
                inline
              />
            </li>
          ))}
        </ul>
      )}
      <WorkDetailsForm
        action={addLoyaltyAction}
        hidden={hiddenFor(ctx)}
        label={t(`${P}.loyalty.add`)}
        submitLabel={t(`${P}.loyalty.add`)}
        resetOnSuccess
        inline
        fields={[
          {
            kind: "select",
            name: "programKind",
            label: t(`${P}.loyalty.kind`),
            defaultValue: "Airline",
            options: LOYALTY_PROGRAM_KINDS.map((k) => ({
              value: k,
              label: labelled(t, "loyaltyKinds", k),
            })),
          },
          { kind: "text", name: "programName", label: t(`${P}.loyalty.program`), width: 180 },
          {
            kind: "text",
            name: "memberNumber",
            label: t(`${P}.loyalty.member`),
            width: 180,
            autoComplete: "off",
          },
        ]}
      />
    </Section>
  );
}

function PassportSection({ ctx, t, d }: { ctx: OrgContext; t: Translate; d: WorkDetails | null }) {
  return (
    <Section
      id="work-details-passport"
      title={t(`${P}.passport.title`)}
      description={t(`${P}.passport.description`)}
    >
      <p className="m-0 text-text-13">
        {d?.passportNumberLast4
          ? t(`${P}.passport.onFile`, { last4: d.passportNumberLast4 })
          : t(`${P}.passport.none`)}
      </p>
      {d?.passportNumberLast4 ? (
        <div className="flex flex-wrap items-start gap-8">
          <WorkDetailsForm
            action={revealMyPassportAction}
            hidden={hiddenFor(ctx)}
            fields={[]}
            submitLabel={t(`${P}.passport.reveal`)}
            label={t(`${P}.passport.reveal`)}
            inline
          />
          <WorkDetailsForm
            action={clearPassportNumberAction}
            hidden={hiddenFor(ctx)}
            fields={[]}
            submitLabel={t(`${P}.passport.clear`)}
            label={t(`${P}.passport.clear`)}
            inline
          />
        </div>
      ) : null}
      <WorkDetailsForm
        action={savePassportAction}
        hidden={hiddenFor(ctx)}
        label={t(`${P}.passport.title`)}
        submitLabel={t(`${P}.passport.save`)}
        fields={[
          {
            kind: "text",
            name: "passportName",
            label: t(`${P}.passport.name`),
            help: t(`${P}.passport.nameHelp`),
            defaultValue: d?.passportName ?? "",
            autoComplete: "off",
          },
          {
            kind: "text",
            name: "passportIssuingCountry",
            label: t(`${P}.passport.country`),
            help: t(`${P}.passport.countryHelp`),
            defaultValue: d?.passportIssuingCountry ?? "",
            width: 120,
          },
          {
            kind: "date",
            name: "passportExpiresOn",
            label: t(`${P}.passport.expires`),
            defaultValue: d?.passportExpiresOn ?? "",
            width: 180,
          },
          {
            kind: "text",
            name: "passportNumber",
            label: t(`${P}.passport.number`),
            help: t(`${P}.passport.numberHelp`),
            autoComplete: "off",
          },
        ]}
      />
    </Section>
  );
}

/** Work Details on Settings, Work Details (me.work-details). */
export async function MyWorkDetailsPanel({ ctx }: { ctx: OrgContext }) {
  const [t, locale, details] = await Promise.all([
    getTranslate(),
    getLocale(),
    getMyWorkDetails(ctx.viewer.db),
  ]);
  if (!details.ok) return loadFailed(t);
  const region = regionFromLocale(locale);
  const d = details.data;
  return (
    <div className="flex flex-col gap-32">
      <ContactsSection ctx={ctx} t={t} region={region} />
      <UniformSection ctx={ctx} t={t} d={d} />
      <NeedsSections ctx={ctx} t={t} d={d} />
      <TravelSection ctx={ctx} t={t} d={d} />
      <PassportSection ctx={ctx} t={t} d={d} />
    </div>
  );
}

// Sharing --------------------------------------------------------------------------------------------

/** Which engagement sees which categories, with share, change and revoke (per-engagement consent). */
export async function MySharingPanel({ ctx }: { ctx: OrgContext }) {
  const [t, locale, sharing] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMyWorkDetailSharing(ctx.viewer.db),
  ]);
  if (!sharing.ok) return loadFailed(t);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <Section
      id="work-details-sharing"
      title={t(`${P}.sharing.title`)}
      description={t(`${P}.sharing.description`)}
    >
      {sharing.data.length === 0 ? (
        <Muted>{t(`${P}.sharing.none`)}</Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0">
          {sharing.data.map((s) => (
            <li
              key={s.engagementId}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-wrap items-center justify-between gap-8 text-text-13">
                <span className="font-medium">
                  {t(`${P}.sharing.engagement`, { org: s.orgName, project: s.projectName })}
                </span>
                <span className="text-text-secondary">
                  {s.sharedAt
                    ? t(`${P}.sharing.shared`, { date: date.format(new Date(s.sharedAt)) })
                    : t(`${P}.sharing.notShared`)}
                </span>
              </div>
              {s.sharingOpen ? (
                <div className="flex flex-wrap items-start gap-8">
                  <WorkDetailsForm
                    action={shareAction}
                    hidden={{ ...hiddenFor(ctx), engagementId: s.engagementId }}
                    label={t(`${P}.sharing.categoriesLabel`, { org: s.orgName })}
                    submitLabel={s.shareId ? t(`${P}.sharing.update`) : t(`${P}.sharing.share`)}
                    fields={[
                      {
                        kind: "choices",
                        name: "categories",
                        label: t(`${P}.sharing.categoriesLabel`, { org: s.orgName }),
                        summary: t(`${P}.dietary.chosen`, { count: s.categories.length }),
                        open: s.shareId === null,
                        options: WORK_DETAIL_CATEGORIES.map((c) => ({
                          value: c,
                          label: labelled(t, "categories", c),
                          checked: s.categories.includes(c),
                        })),
                      },
                    ]}
                  />
                  {s.shareId ? (
                    <WorkDetailsForm
                      action={revokeShareAction}
                      hidden={{ ...hiddenFor(ctx), shareId: s.shareId }}
                      fields={[]}
                      submitLabel={t(`${P}.sharing.revoke`)}
                      label={t(`${P}.sharing.revokeNamed`, { org: s.orgName })}
                      inline
                    />
                  ) : null}
                </div>
              ) : (
                <Muted>{t(`${P}.sharing.closed`)}</Muted>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// Access log ------------------------------------------------------------------------------------------

/** The person's access log: changes, shares, and each read or reveal by an engaging org. */
export async function MyAccessLogPanel({ ctx }: { ctx: OrgContext }) {
  const person = ctx.viewer.person?.id ?? "";
  const [t, locale, events, sharing] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMyWorkDetailEvents(ctx.viewer.db, person, 25),
    listMyWorkDetailSharing(ctx.viewer.db),
  ]);
  if (!events.ok || !sharing.ok) return loadFailed(t);
  const orgs = new Map(sharing.data.map((s) => [s.orgId, s.orgName]));
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Section
      id="work-details-log"
      title={t(`${P}.log.title`)}
      description={t(`${P}.log.description`)}
    >
      {events.data.length === 0 ? (
        <Muted>{t(`${P}.log.none`)}</Muted>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0 text-text-13">
          {events.data.map((e) => {
            const action = t(`${P}.log.actions.${workDetailLogKey(e.action)}`);
            const org = e.orgId ? orgs.get(e.orgId) : undefined;
            return (
              <li key={e.id} className="flex flex-col gap-2 py-8">
                <span>
                  {org ? t(`${P}.log.byOrg`, { action, org }) : action}
                  {e.categories.length > 0
                    ? ` · ${e.categories.map((c) => labelled(t, "categories", c)).join(", ")}`
                    : ""}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {when.format(new Date(e.createdAt))}
                  {e.reason ? ` · ${t(`${P}.log.reason`, { reason: e.reason })}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// Section 15 names ------------------------------------------------------------------------------------

/** Optional given and family names on Settings, Profile (Section 15). */
export async function NamePartsPanel({ ctx }: { ctx: OrgContext }) {
  const t = await getTranslate();
  const person = ctx.viewer.person?.id;
  if (!person) return null;
  const parts = await getMyNameParts(ctx.viewer.db, person);
  if (!parts.ok) return loadFailed(t);
  const fields: WorkDetailsField[] = [
    {
      kind: "text",
      name: "givenName",
      label: t(`${P}.names.given`),
      defaultValue: parts.data.givenName ?? "",
      autoComplete: "given-name",
    },
    {
      kind: "text",
      name: "familyName",
      label: t(`${P}.names.family`),
      defaultValue: parts.data.familyName ?? "",
      autoComplete: "family-name",
    },
  ];
  return (
    <Section
      id="profile-name-parts"
      title={t(`${P}.names.title`)}
      description={t(`${P}.names.description`)}
    >
      <WorkDetailsForm
        action={saveNamePartsAction}
        hidden={hiddenFor(ctx)}
        label={t(`${P}.names.title`)}
        submitLabel={t(`${P}.names.save`)}
        fields={fields}
      />
    </Section>
  );
}
