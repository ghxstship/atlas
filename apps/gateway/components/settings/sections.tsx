import {
  APP_ENUMS,
  listAccountMembers,
  listMyAccounts,
  listPayoutAccounts,
  listRepresentations,
  listTaxForms,
  readView,
  representationStanding,
} from "@xos/data/gateway";
import {
  getMyProfile,
  getOrganizationProfile,
  listMyCertifications,
  listMyLanguages,
  listMyLinks,
  listMySkills,
  listSectionVisibility,
  PROFILE_SECTIONS,
} from "@xos/data/profiles";
import { listMyNotificationPreferences } from "@xos/data/party-notifications";
import { resolveSettings } from "@xos/data/settings";
import { getNode } from "@xos/ia";
import type { Route } from "next";
import Link from "next/link";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { ActionButton } from "@/components/actions/action-button";
import { RowList, TabEmpty } from "@/components/engagement/rows";
import { SimpleForm } from "@/components/forms/simple-form";
import { RegionError, Section } from "@/components/page/page";
import { InlineAlert } from "@/components/ui";
import { revokeProfileShareAction, revokeRepresentationAction } from "@/lib/actions/engagement";
import {
  addCertificationAction,
  addLanguageAction,
  addLinkAction,
  addSkillAction,
  createAccountAction,
  leaveAccountAction,
  removeProfileItemAction,
  saveCompanyProfileAction,
  saveNameAction,
  savePrivacyAction,
  saveProfileAction,
} from "@/lib/actions/profile";
import { formatDate, formatMoney, minorDigits, todayIso } from "@/lib/format";
import { choiceLabelKey, formText, NO_ORG, personalSettings } from "@/lib/settings";
import type { GatewayContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate, type Translate } from "@/lib/shell/translate";
import { DeleteAccountSection } from "./delete-account";
import { NotificationPreferences } from "./notification-preferences";
import { PersonalSetting } from "./personal-setting";

/**
 * Gateway settings sections (Section 4.5.8: account, security, notifications, payout details,
 * privacy and sharing consents, connected orgs; Section 4.5.6 personal and company sections).
 * Personal registry settings are A30's (shared with Atlas and Compass); the other sections edit
 * the profile, accounts, consents and company records through their own repositories.
 */
interface SectionProps {
  readonly ctx: GatewayContext;
  readonly t: Translate;
  readonly locale: string;
  readonly node: string;
}

function Header({ t, node, children }: { t: Translate; node: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4">
      <h1 className="m-0 text-heading-20 font-semibold">{t(getNode(sitemap, node).node.label)}</h1>
      <p className="m-0 text-text-13 text-text-secondary">
        {t(
          `gateway.settings.leads.${node.replace(/^settings\./, "").replace(/[.-]([a-z])/g, (_, c: string) => c.toUpperCase())}`,
        )}
      </p>
      {children}
    </header>
  );
}

/** The registry settings of a personal section, each with where its value comes from. */
async function RegistrySettings({ ctx, t, node }: SectionProps) {
  const defs = personalSettings(node);
  if (defs.length === 0) return null;
  const resolved = await resolveSettings(ctx.db, { orgId: NO_ORG });
  if (!resolved.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const zones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  return (
    <ul
      aria-label={t("settings.registryHeading")}
      className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
    >
      {defs.map((def) => {
        const r = resolved.data.get(def.key);
        const source = r?.source ?? "Default";
        const initial = r ? formText(r.value) : def.default === null ? "" : formText(def.default);
        return (
          <li key={`${def.key}:${initial}`}>
            <PersonalSetting
              settingKey={def.key}
              type={def.type}
              input={def.input}
              label={t(def.label)}
              help={def.help ? t(def.help) : null}
              initial={initial}
              sourceText={t(`settings.source.personal${source}`)}
              setHere={source === "Personal"}
              options={
                def.type === "choice"
                  ? def.choices.map((c) => ({ value: c, label: t(choiceLabelKey(def.key, c)) }))
                  : def.input === "time_zone"
                    ? zones.map((z) => ({ value: z, label: z.replaceAll("_", " ") }))
                    : []
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

async function ProfileSection(props: SectionProps) {
  const { ctx, t } = props;
  const profile = await getMyProfile(ctx.db);
  if (!profile.ok) return <RegionError />;
  const p = profile.data;
  const [skills, languages, links, certs, categories] = await Promise.all([
    listMySkills(ctx.db, ctx.personId),
    listMyLanguages(ctx.db, ctx.personId),
    listMyLinks(ctx.db, ctx.personId),
    listMyCertifications(ctx.db, ctx.personId),
    ctx.db.schema("xpms").from("dim_category").select("cat_urid, category").order("cat_urid"),
  ]);
  const currency = p.rateCurrency ?? "USD";
  return (
    <>
      <Header t={t} node={props.node}>
        <Link href={`/u/${p.handle}` as Route} className="text-text-13 text-accent-text underline">
          {t("gateway.profile.publicLink", { handle: p.handle })}
        </Link>
      </Header>
      <SimpleForm
        id="profile"
        action={saveProfileAction}
        label={t("gateway.settings.profile.facts")}
        errorsNamespace="gateway.profile.errors"
        submitLabel={t("settings.save")}
        doneLabel={t("settings.saved")}
        fields={[
          {
            name: "handle",
            label: t("gateway.settings.profile.handle"),
            required: true,
            defaultValue: p.handle,
            help: t("gateway.settings.profile.handleHelp"),
          },
          {
            name: "preferredName",
            label: t("gateway.settings.profile.preferredName"),
            defaultValue: p.preferredName ?? "",
          },
          {
            name: "pronouns",
            label: t("gateway.settings.profile.pronouns"),
            defaultValue: p.pronouns ?? "",
          },
          {
            name: "headline",
            label: t("gateway.settings.profile.headline"),
            defaultValue: p.headline ?? "",
            width: "100%",
          },
          { name: "city", label: t("gateway.settings.profile.city"), defaultValue: p.city ?? "" },
          {
            name: "countryCode",
            label: t("gateway.settings.profile.country"),
            defaultValue: p.countryCode ?? "",
            width: 120,
          },
          {
            name: "rate",
            label: t("gateway.settings.profile.rate", { currency }),
            inputMode: "decimal",
            defaultValue:
              p.rateMinor === null ? "" : String(p.rateMinor / 10 ** minorDigits(currency)),
            help: t("gateway.settings.profile.rateHelp"),
          },
        ]}
        hidden={{ rateCurrency: currency, rateUnit: p.rateUnit ?? "Day", bio: p.bio ?? "" }}
      />
      <Section title={t("gateway.settings.profile.about")}>
        <SimpleForm
          id="profile-bio"
          action={saveProfileAction}
          label={t("gateway.settings.profile.about")}
          errorsNamespace="gateway.profile.errors"
          submitLabel={t("settings.save")}
          doneLabel={t("settings.saved")}
          fields={[
            {
              name: "bio",
              label: t("gateway.settings.profile.bio"),
              kind: "textarea",
              defaultValue: p.bio ?? "",
            },
          ]}
          hidden={{
            handle: p.handle,
            preferredName: p.preferredName ?? "",
            pronouns: p.pronouns ?? "",
            headline: p.headline ?? "",
            city: p.city ?? "",
            countryCode: p.countryCode ?? "",
            rate: p.rateMinor === null ? "" : String(p.rateMinor / 10 ** minorDigits(currency)),
            rateCurrency: currency,
            rateUnit: p.rateUnit ?? "Day",
          }}
        />
      </Section>
      <Section title={t("gateway.settings.profile.skills")}>
        {skills.ok && skills.data.length > 0 ? (
          <RowList
            label={t("gateway.settings.profile.skills")}
            items={skills.data.map((s) => ({
              id: s.id,
              title: categories.data?.find((c) => c.cat_urid === s.catUrid)?.category ?? s.catUrid,
              meta: [s.catUrid],
              action: (
                <ActionButton
                  action={removeProfileItemAction.bind(null, "person_skills", s.id)}
                  label={t("gateway.settings.remove")}
                  variant="ghost"
                />
              ),
            }))}
          />
        ) : null}
        <SimpleForm
          id="skill"
          action={addSkillAction}
          label={t("gateway.settings.profile.addSkill")}
          errorsNamespace="gateway.profile.errors"
          submitLabel={t("gateway.settings.profile.addSkill")}
          variant="secondary"
          doneLabel={t("settings.saved")}
          resetOnDone
          hidden={{ sortOrder: String(skills.ok ? skills.data.length : 0) }}
          fields={[
            {
              name: "catUrid",
              label: t("gateway.settings.profile.skill"),
              kind: "select",
              required: true,
              options: (categories.data ?? []).map((c) => ({
                value: c.cat_urid,
                label: `${c.category} · ${c.cat_urid}`,
              })),
            },
          ]}
        />
      </Section>
      <Section title={t("gateway.settings.profile.certifications")}>
        {certs.ok && certs.data.length > 0 ? (
          <RowList
            label={t("gateway.settings.profile.certifications")}
            items={certs.data.map((c) => ({
              id: c.id,
              title: c.name,
              meta: [c.issuingBody],
              tag: c.verified
                ? { label: t("gateway.profile.certifications.verified"), tone: "success" as const }
                : {
                    label: t("gateway.profile.certifications.selfReported"),
                    tone: "neutral" as const,
                  },
              action: (
                <ActionButton
                  action={removeProfileItemAction.bind(null, "person_certifications", c.id)}
                  label={t("gateway.settings.remove")}
                  variant="ghost"
                />
              ),
            }))}
          />
        ) : null}
        <SimpleForm
          id="certification"
          action={addCertificationAction}
          label={t("gateway.settings.profile.addCertification")}
          errorsNamespace="gateway.profile.errors"
          submitLabel={t("gateway.settings.profile.addCertification")}
          variant="secondary"
          doneLabel={t("settings.saved")}
          resetOnDone
          fields={[
            { name: "name", label: t("gateway.settings.profile.certName"), required: true },
            { name: "issuingBody", label: t("gateway.settings.profile.certBody"), required: true },
            {
              name: "issuedOn",
              label: t("gateway.settings.profile.certIssued"),
              kind: "date",
              required: true,
            },
            { name: "expiresOn", label: t("gateway.settings.profile.certExpires"), kind: "date" },
          ]}
        />
      </Section>
      <Section title={t("gateway.settings.profile.languages")}>
        {languages.ok && languages.data.length > 0 ? (
          <RowList
            label={t("gateway.settings.profile.languages")}
            items={languages.data.map((l) => ({
              id: l.id,
              title: l.tag,
              meta: [l.proficiency ? t(enumLabelKey("languageProficiency", l.proficiency)) : null],
              action: (
                <ActionButton
                  action={removeProfileItemAction.bind(null, "person_languages", l.id)}
                  label={t("gateway.settings.remove")}
                  variant="ghost"
                />
              ),
            }))}
          />
        ) : null}
        <SimpleForm
          id="language"
          action={addLanguageAction}
          label={t("gateway.settings.profile.addLanguage")}
          errorsNamespace="gateway.profile.errors"
          submitLabel={t("gateway.settings.profile.addLanguage")}
          variant="secondary"
          doneLabel={t("settings.saved")}
          resetOnDone
          fields={[
            {
              name: "tag",
              label: t("gateway.settings.profile.languageTag"),
              required: true,
              help: t("gateway.settings.profile.languageHelp"),
            },
            {
              name: "proficiency",
              label: t("gateway.settings.profile.proficiency"),
              kind: "select",
              options: APP_ENUMS.language_proficiency.map((v) => ({
                value: v,
                label: t(enumLabelKey("languageProficiency", v)),
              })),
            },
          ]}
        />
      </Section>
      <Section title={t("gateway.settings.profile.links")}>
        {links.ok && links.data.length > 0 ? (
          <RowList
            label={t("gateway.settings.profile.links")}
            items={links.data.map((l) => ({
              id: l.id,
              title: l.label,
              meta: [l.url],
              action: (
                <ActionButton
                  action={removeProfileItemAction.bind(null, "person_links", l.id)}
                  label={t("gateway.settings.remove")}
                  variant="ghost"
                />
              ),
            }))}
          />
        ) : null}
        <SimpleForm
          id="link"
          action={addLinkAction}
          label={t("gateway.settings.profile.addLink")}
          errorsNamespace="gateway.profile.errors"
          submitLabel={t("gateway.settings.profile.addLink")}
          variant="secondary"
          doneLabel={t("settings.saved")}
          resetOnDone
          fields={[
            { name: "label", label: t("gateway.settings.profile.linkLabel"), required: true },
            {
              name: "url",
              label: t("gateway.settings.profile.linkUrl"),
              kind: "url",
              required: true,
            },
          ]}
        />
      </Section>
    </>
  );
}

async function PrivacySection(props: SectionProps) {
  const { ctx, t, locale } = props;
  const [profile, sections, shares] = await Promise.all([
    getMyProfile(ctx.db),
    listSectionVisibility(ctx.db, ctx.personId),
    readView(ctx.db, "my_profile_shares", { order: ["shared_at", "desc"] }),
  ]);
  if (!profile.ok || !sections.ok || !shares.ok) return <RegionError />;
  const visibility = APP_ENUMS.profile_visibility.map((v) => ({
    value: v,
    label: t(enumLabelKey("profileVisibility", v)),
  }));
  return (
    <>
      <Header t={t} node={props.node} />
      <SimpleForm
        id="privacy"
        action={savePrivacyAction}
        label={t("gateway.settings.privacy.title")}
        errorsNamespace="gateway.profile.errors"
        submitLabel={t("settings.save")}
        doneLabel={t("settings.saved")}
        fields={[
          {
            name: "visibility",
            label: t("gateway.settings.privacy.visibility"),
            kind: "select",
            options: visibility,
            defaultValue: profile.data.visibility,
            help: t("gateway.settings.privacy.visibilityHelp"),
          },
          {
            name: "marketplaceDiscoverable",
            label: t("gateway.settings.privacy.discoverable"),
            kind: "checkbox",
            defaultChecked: profile.data.marketplaceDiscoverable,
          },
          {
            name: "searchIndexing",
            label: t("gateway.settings.privacy.indexing"),
            kind: "checkbox",
            defaultChecked: profile.data.searchIndexing,
          },
          ...PROFILE_SECTIONS.map((section) => ({
            name: `section_${section}`,
            label: t(`gateway.settings.privacy.sections.${section}`),
            kind: "select" as const,
            defaultValue: sections.data.get(section) ?? "inherit",
            options: [
              { value: "inherit", label: t("gateway.settings.privacy.inherit") },
              ...visibility,
            ],
          })),
        ]}
      />
      <Section title={t("gateway.profile.shares.title")}>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("gateway.settings.privacy.sharesBody")}
        </p>
        {shares.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.profile.shares.empty")}
          </p>
        ) : (
          <RowList
            label={t("gateway.profile.shares.title")}
            items={shares.data.map((s) => ({
              id: s.id ?? "",
              title: s.org_name ?? "",
              meta: [
                s.shared_at
                  ? t("gateway.profile.shares.shared", { date: formatDate(locale, s.shared_at) })
                  : null,
                s.revoked_at
                  ? t("gateway.profile.shares.revoked", { date: formatDate(locale, s.revoked_at) })
                  : null,
              ],
              ...(!s.revoked_at && s.id
                ? {
                    action: (
                      <ActionButton
                        action={revokeProfileShareAction.bind(null, s.id)}
                        label={t("gateway.profile.shares.revoke")}
                        variant="ghost"
                      />
                    ),
                  }
                : {}),
            }))}
          />
        )}
      </Section>
    </>
  );
}

function AccountSection(props: SectionProps) {
  const { ctx, t } = props;
  return (
    <>
      <Header t={t} node={props.node} />
      <SimpleForm
        id="account"
        action={saveNameAction}
        label={t("gateway.settings.account.name")}
        errorsNamespace="gateway.profile.errors"
        submitLabel={t("settings.save")}
        doneLabel={t("settings.saved")}
        fields={[
          {
            name: "fullName",
            label: t("gateway.settings.account.name"),
            required: true,
            defaultValue: ctx.personName ?? "",
            autoComplete: "name",
          },
        ]}
      />
      <p className="m-0 text-text-13">
        {t("gateway.settings.account.email", { email: ctx.email ?? "" })}
      </p>
      <p className="m-0 text-text-13 text-text-secondary">
        {t("gateway.settings.account.oneAccount")}
      </p>
      <DeleteAccountSection ctx={ctx} t={t} />
    </>
  );
}

function SecuritySection(props: SectionProps) {
  const { t } = props;
  return (
    <>
      <Header t={t} node={props.node} />
      <p className="m-0 text-text-14">{t("gateway.settings.security.passwordless")}</p>
      <form method="post" action="/auth/sign-out">
        <button
          type="submit"
          className="min-h-touch-min rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium text-text-primary"
        >
          {t("gateway.settings.security.signOut")}
        </button>
      </form>
    </>
  );
}

async function OrganizationsSection(props: SectionProps) {
  const { ctx, t } = props;
  const accounts = await listMyAccounts(ctx.db);
  const members = accounts.ok
    ? await Promise.all(accounts.data.map((a) => listAccountMembers(ctx.db, a.id)))
    : [];
  return (
    <>
      <Header t={t} node={props.node} />
      {!accounts.ok ? (
        <RegionError />
      ) : accounts.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("gateway.settings.organizations.none")}
        </p>
      ) : (
        <RowList
          label={t("gateway.settings.organizations.accounts")}
          items={accounts.data.map((a, i) => {
            const mine = members[i]?.ok
              ? members[i].data.find((m) => m.personId === ctx.personId)
              : undefined;
            return {
              id: a.id,
              title: a.name,
              meta: [a.roles.map((r) => t(enumLabelKey("accountRole", r))).join(", "), a.slug],
              ...(mine
                ? {
                    action: (
                      <ActionButton
                        action={leaveAccountAction.bind(null, mine.membershipId)}
                        label={t("gateway.settings.organizations.leave")}
                        variant="ghost"
                      />
                    ),
                  }
                : {}),
            };
          })}
        />
      )}
      <Section title={t("gateway.settings.organizations.create")}>
        <p className="m-0 text-text-13 text-text-secondary">
          {t("gateway.settings.organizations.createBody")}
        </p>
        <SimpleForm
          id="create-account"
          action={createAccountAction}
          label={t("gateway.settings.organizations.create")}
          errorsNamespace="gateway.profile.errors"
          submitLabel={t("gateway.settings.organizations.createSubmit")}
          doneLabel={t("gateway.settings.organizations.created")}
          resetOnDone
          fields={[
            {
              name: "name",
              label: t("gateway.settings.organizations.name"),
              required: true,
              autoComplete: "organization",
            },
            {
              name: "slug",
              label: t("gateway.settings.organizations.slug"),
              required: true,
              help: t("gateway.settings.organizations.slugHelp"),
            },
          ]}
        />
      </Section>
    </>
  );
}

async function PayoutTaxSection(props: SectionProps & { account?: boolean }) {
  const { ctx, t, locale } = props;
  const [forms, payouts] = await Promise.all([listTaxForms(ctx.db), listPayoutAccounts(ctx.db)]);
  if (!forms.ok || !payouts.ok) return <RegionError />;
  const scope = (row: { personId: string | null; accountId: string | null }) =>
    props.account ? row.accountId === ctx.acting?.id : row.personId === ctx.personId;
  return (
    <>
      <Header t={t} node={props.node} />
      <Section title={t("gateway.money.tax.payouts")}>
        <p className="m-0 text-text-13 text-text-secondary">{t("gateway.settings.payout.body")}</p>
        {payouts.data.filter(scope).length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("gateway.money.tax.noPayouts")}</p>
        ) : (
          <RowList
            label={t("gateway.money.tax.payouts")}
            items={payouts.data.filter(scope).map((p) => ({
              id: p.id,
              title: t(enumLabelKey("payoutProvider", p.provider)),
              meta: [p.last4 ? t("gateway.money.tax.last4", { last4: p.last4 }) : null],
            }))}
          />
        )}
      </Section>
      <Section title={t("gateway.documents.tax")}>
        {forms.data.filter(scope).length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("gateway.money.tax.empty")}</p>
        ) : (
          <RowList
            label={t("gateway.documents.tax")}
            items={forms.data.filter(scope).map((f) => ({
              id: f.id,
              title: t(enumLabelKey("taxFormKind", f.kind)),
              meta: [
                f.orgName,
                t("gateway.money.tax.last4", { last4: f.tinLast4 }),
                formatDate(locale, f.signedAt),
              ],
            }))}
          />
        )}
      </Section>
    </>
  );
}

function NoteSection(
  props: SectionProps & { note: string; action: { label: string; href: string } },
) {
  return (
    <>
      <Header t={props.t} node={props.node} />
      <TabEmpty
        icon="Info"
        sentence={props.note}
        actionLabel={props.action.label}
        href={props.action.href}
      />
    </>
  );
}

/**
 * The person's own notification choices as an external party (migration 1131, finding A38-002):
 * Email and Push per category.
 */
async function NotificationsSection(props: SectionProps) {
  const prefs = await listMyNotificationPreferences(props.ctx.db);
  return (
    <>
      <Header t={props.t} node={props.node} />
      {prefs.ok ? <NotificationPreferences rows={prefs.data} /> : <RegionError />}
    </>
  );
}

async function RegistrySection(props: SectionProps) {
  return (
    <>
      <Header t={props.t} node={props.node} />
      <RegistrySettings {...props} />
    </>
  );
}

async function CompanyProfileSection(props: SectionProps) {
  const { ctx, t } = props;
  if (!ctx.acting) return null;
  const profile = await getOrganizationProfile(ctx.db, ctx.acting.id, true);
  return (
    <>
      <Header t={t} node={props.node} />
      {!profile.ok || !profile.data ? (
        <InlineAlert tone="info">{t("gateway.settings.company.profileUnavailable")}</InlineAlert>
      ) : (
        <>
          <Link
            href={`/c/${profile.data.handle}` as Route}
            className="text-text-13 text-accent-text underline"
          >
            {t("gateway.settings.company.publicLink", { handle: profile.data.handle })}
          </Link>
          <SimpleForm
            id="company-profile"
            action={saveCompanyProfileAction}
            label={t("gateway.settings.company.profile")}
            errorsNamespace="gateway.profile.errors"
            submitLabel={t("settings.save")}
            doneLabel={t("settings.saved")}
            hidden={{ profileId: profile.data.id }}
            fields={[
              {
                name: "handle",
                label: t("gateway.settings.profile.handle"),
                required: true,
                defaultValue: profile.data.handle,
              },
              {
                name: "about",
                label: t("gateway.settings.company.about"),
                kind: "textarea",
                defaultValue: profile.data.about ?? "",
              },
              {
                name: "websiteUrl",
                label: t("gateway.settings.company.website"),
                kind: "url",
                defaultValue: profile.data.websiteUrl ?? "",
              },
              {
                name: "contactEmail",
                label: t("gateway.settings.company.email"),
                kind: "email",
                defaultValue: profile.data.contactEmail ?? "",
              },
              {
                name: "visibility",
                label: t("gateway.settings.privacy.visibility"),
                kind: "select",
                defaultValue: profile.data.visibility,
                options: APP_ENUMS.profile_visibility.map((v) => ({
                  value: v,
                  label: t(enumLabelKey("profileVisibility", v)),
                })),
              },
              {
                name: "searchIndexing",
                label: t("gateway.settings.privacy.indexing"),
                kind: "checkbox",
                defaultChecked: profile.data.searchIndexing,
              },
            ]}
          />
        </>
      )}
    </>
  );
}

async function TeamSection(props: SectionProps) {
  const { ctx, t, locale } = props;
  if (!ctx.acting) return null;
  const members = await listAccountMembers(ctx.db, ctx.acting.id);
  const admin = ctx.acting.roles.some((r) => r === "Account Owner" || r === "Account Admin");
  return (
    <>
      <Header t={t} node={props.node} />
      {!members.ok ? (
        <RegionError />
      ) : (
        <RowList
          label={t("gateway.profile.company.team")}
          items={members.data.map((m) => ({
            id: m.membershipId,
            title: m.fullName ?? "",
            meta: [
              m.roles.map((r) => t(enumLabelKey("accountRole", r))).join(", "),
              t("gateway.profile.company.since", { date: formatDate(locale, m.validFrom) }),
            ],
            ...(admin && m.personId !== ctx.personId
              ? {
                  action: (
                    <ActionButton
                      action={leaveAccountAction.bind(null, m.membershipId)}
                      label={t("gateway.settings.company.remove")}
                      variant="ghost"
                    />
                  ),
                }
              : {}),
          }))}
        />
      )}
      <p className="m-0 text-text-13 text-text-secondary">
        {t("gateway.settings.company.inviteNote")}
      </p>
    </>
  );
}

async function InsuranceSection(props: SectionProps) {
  const { ctx, t, locale } = props;
  const certificates = await readView(ctx.db, "vendor_insurance_certificates", {
    order: ["valid_to", "desc"],
  });
  const prequal = await readView(ctx.db, "vendor_prequalifications", {});
  if (!certificates.ok || !prequal.ok) return <RegionError />;
  const mine = certificates.data.filter((c) => c.account_id === ctx.acting?.id);
  return (
    <>
      <Header t={t} node={props.node} />
      {mine.length === 0 ? (
        <TabEmpty
          icon="ShieldCheck"
          sentence={t("gateway.settings.company.noInsurance")}
          actionLabel={t("gateway.settings.company.toEngagements")}
          href="/work/engagements"
        />
      ) : (
        <RowList
          label={t("gateway.engagement.compliance.insurance")}
          items={mine.map((c) => ({
            id: c.id ?? "",
            title: c.coverage_type ?? "",
            meta: [
              c.org_name,
              c.insurer,
              formatMoney(locale, c.coverage_limit_minor, c.currency_code),
              c.valid_to
                ? t("gateway.engagement.compliance.validTo", {
                    date: formatDate(locale, c.valid_to),
                  })
                : null,
            ],
            tag: c.is_current
              ? { label: t("gateway.engagement.compliance.current"), tone: "success" as const }
              : { label: t("gateway.engagement.compliance.expired"), tone: "danger" as const },
          }))}
        />
      )}
      {prequal.data.filter((p) => p.account_id === ctx.acting?.id).length > 0 ? (
        <Section title={t("gateway.engagement.compliance.prequalification")}>
          <RowList
            label={t("gateway.engagement.compliance.prequalification")}
            items={prequal.data
              .filter((p) => p.account_id === ctx.acting?.id)
              .map((p) => ({
                id: p.id ?? "",
                title: p.org_name ?? "",
                meta: [p.scope],
                ...(p.decision
                  ? {
                      tag: {
                        label: t(enumLabelKey("approvalDecision", p.decision)),
                        tone:
                          p.decision === "Approved" ? ("success" as const) : ("danger" as const),
                      },
                    }
                  : {}),
              }))}
          />
        </Section>
      ) : null}
    </>
  );
}

async function RepresentationSection(props: SectionProps) {
  const { ctx, t, locale } = props;
  const reps = await listRepresentations(ctx.db);
  if (!reps.ok) return <RegionError />;
  const today = todayIso();
  const mine = reps.data.filter((r) => r.accountId === ctx.acting?.id);
  return (
    <>
      <Header t={t} node={props.node} />
      {mine.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("gateway.settings.company.noRepresentation")}
        </p>
      ) : (
        <RowList
          label={t("gateway.profile.representation.title")}
          items={mine.map((r) => {
            const standing = representationStanding(r, today);
            return {
              id: r.id,
              title: r.artistName ?? "",
              meta: [
                r.scopes.map((s) => t(enumLabelKey("representationScope", s))).join(", "),
                t("gateway.profile.representation.expires", {
                  date: formatDate(locale, r.expiresOn),
                }),
              ],
              tag: {
                label: t(`gateway.profile.representation.standing.${standing}`),
                tone: standing === "active" ? ("success" as const) : ("neutral" as const),
              },
              ...(standing === "active" || standing === "pending"
                ? {
                    action: (
                      <ActionButton
                        action={revokeRepresentationAction.bind(null, r.id)}
                        label={t("gateway.profile.representation.revoke")}
                        variant="ghost"
                      />
                    ),
                  }
                : {}),
            };
          })}
        />
      )}
      <p className="m-0 text-text-13 text-text-secondary">
        {t("gateway.settings.company.proposeNote")}
      </p>
    </>
  );
}

/** The content of one settings section, by sitemap node id. */
export async function SettingsSection({ node, ctx }: { node: string; ctx: GatewayContext }) {
  const [t, locale] = await Promise.all([getTranslate(), getLocale()]);
  const props: SectionProps = { ctx, t, locale, node };
  switch (node) {
    case "settings.profile":
      return <ProfileSection {...props} />;
    case "settings.profile-privacy":
      return <PrivacySection {...props} />;
    case "settings.account":
      return <AccountSection {...props} />;
    case "settings.security":
      return <SecuritySection {...props} />;
    case "settings.organizations":
      return <OrganizationsSection {...props} />;
    case "settings.payout-and-tax":
      return <PayoutTaxSection {...props} />;
    case "settings.company.payout-and-tax":
      return <PayoutTaxSection {...props} account />;
    case "settings.work-details":
      return (
        <NoteSection
          {...props}
          note={t("gateway.settings.notes.workDetails")}
          action={{ label: t("gateway.settings.notes.toProfile"), href: "/settings/profile" }}
        />
      );
    case "settings.calendar-feeds":
      return (
        <NoteSection
          {...props}
          note={t("gateway.settings.notes.calendarFeeds")}
          action={{ label: t("gateway.settings.notes.toUpcoming"), href: "/work/upcoming" }}
        />
      );
    case "settings.connected-apps":
      return (
        <NoteSection
          {...props}
          note={t("gateway.settings.notes.connectedApps")}
          action={{
            label: t("gateway.settings.notes.toOrganizations"),
            href: "/settings/organizations",
          }}
        />
      );
    case "settings.notifications":
      return <NotificationsSection {...props} />;
    case "settings.company.notifications":
      return (
        <NoteSection
          {...props}
          note={t("gateway.settings.notes.notifications")}
          action={{
            label: t("gateway.settings.notes.toPreferences"),
            href: "/settings/preferences",
          }}
        />
      );
    case "settings.developer":
      return (
        <NoteSection
          {...props}
          note={t("gateway.settings.notes.developer")}
          action={{ label: t("gateway.settings.notes.toSecurity"), href: "/settings/security" }}
        />
      );
    case "settings.company.company-profile-and-privacy":
      return <CompanyProfileSection {...props} />;
    case "settings.company.team-and-account-roles":
      return <TeamSection {...props} />;
    case "settings.company.service-regions-and-capabilities":
      return (
        <NoteSection
          {...props}
          note={t("gateway.settings.notes.regions")}
          action={{
            label: t("gateway.settings.notes.toCompanyProfile"),
            href: "/settings/company/company-profile-and-privacy",
          }}
        />
      );
    case "settings.company.insurance-and-compliance-documents":
      return <InsuranceSection {...props} />;
    case "settings.company.representation":
      return <RepresentationSection {...props} />;
    case "settings.company.danger-zone":
      return (
        <NoteSection
          {...props}
          note={t("gateway.settings.notes.dangerZone")}
          action={{
            label: t("gateway.settings.notes.toTeam"),
            href: "/settings/company/team-and-account-roles",
          }}
        />
      );
    default:
      return <RegistrySection {...props} />;
  }
}
