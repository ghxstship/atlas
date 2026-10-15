import { listMembers, listRoles } from "@xos/data";
import {
  getMyProfile,
  getOrganizationProfile,
  isOrganizationVerified,
  listAutoJoinOffers,
  listCarryableCertifications,
  listInviteLinks,
  listMyCertifications,
  listMyLanguages,
  listMyLinks,
  listMySkills,
  listOpenOffboardings,
  listPendingJoinRequests,
  listSectionVisibility,
  PROFILE_SECTIONS,
} from "@xos/data/profiles";
import { Input, InlineAlert, Select } from "@/components/ui";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsPanelProps } from "./contributions/types";
import {
  AddItemForm,
  AutoJoinButton,
  CarryCertificationButton,
  InviteLinkForm,
  JoinRequestForm,
  OffboardingForm,
  OrgProfileForm,
  PrivacyForm,
  ProfileForm,
  RemoveItemButton,
  RevokeLinkButton,
} from "./profile-forms";

/**
 * A30's profile and joining panels (Section 4.8): the person's profile and its lists, profile
 * privacy, the organization profile with its verified badge, invitation links, requests to join,
 * offboarding, and automatic join offers. Every read uses the viewer's client.
 */

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="m-0 text-heading-16 font-semibold">
      {children}
    </h2>
  );
}

function Failed({ message }: { message: string }) {
  return <InlineAlert tone="danger">{message}</InlineAlert>;
}

function minorToText(minor: number | null, exponent: number): string {
  if (minor === null) return "";
  return exponent === 0 ? String(minor) : (minor / 10 ** exponent).toFixed(exponent);
}

export async function ProfilePanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const person = ctx.viewer.person;
  if (!person) return <Failed message={t("profiles.loadFailed")} />;
  const db = ctx.viewer.db;
  const profile = await getMyProfile(db);
  const [skills, languages, links, certifications, carryable, categories, currencies] =
    await Promise.all([
      listMySkills(db, person.id),
      listMyLanguages(db, person.id),
      listMyLinks(db, person.id),
      listMyCertifications(db, person.id),
      listCarryableCertifications(db, person.id),
      db.schema("xpms").from("dim_category").select("cat_urid, category").order("cat_urid"),
      db.from("currencies").select("currency_code, minor_unit_exponent").order("currency_code"),
    ]);
  if (
    !profile.ok ||
    !skills.ok ||
    !languages.ok ||
    !links.ok ||
    !certifications.ok ||
    !carryable.ok ||
    categories.error ||
    currencies.error
  ) {
    return <Failed message={t("profiles.loadFailed")} />;
  }
  const p = profile.data;
  const categoryName = new Map(categories.data.map((c) => [c.cat_urid, c.category]));
  const exponent =
    currencies.data.find((c) => c.currency_code === p.rateCurrency)?.minor_unit_exponent ?? 2;
  const org = ctx.org.slug;
  return (
    <>
      <ProfileForm
        key={JSON.stringify(p)}
        org={org}
        profileUrl={`/u/${p.handle}`}
        currencies={currencies.data.flatMap((c) =>
          c.currency_code ? [{ value: c.currency_code, label: c.currency_code }] : [],
        )}
        profile={{
          handle: p.handle,
          preferredName: p.preferredName ?? "",
          pronouns: p.pronouns ?? "",
          headline: p.headline ?? "",
          bio: p.bio ?? "",
          city: p.city ?? "",
          countryCode: p.countryCode ?? "",
          rate: minorToText(p.rateMinor, exponent ?? 2),
          rateCurrency: p.rateCurrency ?? "",
          rateUnit: p.rateUnit ?? "",
        }}
      />

      <section aria-labelledby="skills-heading" className="flex max-w-layout-form flex-col gap-8">
        <Heading id="skills-heading">{t("profiles.skills.title")}</Heading>
        {skills.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("profiles.skills.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {skills.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-12 py-8">
                <span className="text-text-13">
                  {categoryName.get(s.catUrid) ?? s.catUrid}{" "}
                  <span className="text-text-secondary">{s.catUrid}</span>
                </span>
                <RemoveItemButton
                  org={org}
                  kind="skill"
                  id={s.id}
                  label={categoryName.get(s.catUrid) ?? s.catUrid}
                />
              </li>
            ))}
          </ul>
        )}
        <AddItemForm org={org} kind="skill" submitLabel={t("profiles.skills.add")}>
          <Select
            id="skill-urid"
            name="catUrid"
            label={t("profiles.skills.choose")}
            placeholder={t("profiles.skills.choose")}
            options={categories.data.map((c) => ({
              value: c.cat_urid,
              label: `${c.category} (${c.cat_urid})`,
            }))}
          />
        </AddItemForm>
      </section>

      <section
        aria-labelledby="languages-heading"
        className="flex max-w-layout-form flex-col gap-8"
      >
        <Heading id="languages-heading">{t("profiles.languages.title")}</Heading>
        {languages.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("profiles.languages.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {languages.data.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-12 py-8">
                <span className="text-text-13">
                  {l.tag} · {t(`profiles.proficiency.${l.proficiency}`)}
                </span>
                <RemoveItemButton org={org} kind="language" id={l.id} label={l.tag} />
              </li>
            ))}
          </ul>
        )}
        <AddItemForm org={org} kind="language" submitLabel={t("profiles.languages.add")}>
          <Input
            id="language-tag"
            name="tag"
            label={t("profiles.languages.tag")}
            help={t("profiles.languages.tagHelp")}
          />
          <Select
            id="language-proficiency"
            name="proficiency"
            label={t("profiles.languages.proficiency")}
            value="Fluent"
            options={(["Basic", "Conversational", "Fluent", "Native"] as const).map((v) => ({
              value: v,
              label: t(`profiles.proficiency.${v}`),
            }))}
          />
        </AddItemForm>
      </section>

      <section aria-labelledby="links-heading" className="flex max-w-layout-form flex-col gap-8">
        <Heading id="links-heading">{t("profiles.links.title")}</Heading>
        {links.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("profiles.links.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {links.data.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-12 py-8">
                <span className="min-w-0 break-all text-text-13">
                  {l.label} <span className="text-text-secondary">{l.url}</span>
                </span>
                <RemoveItemButton org={org} kind="link" id={l.id} label={l.label} />
              </li>
            ))}
          </ul>
        )}
        <AddItemForm org={org} kind="link" submitLabel={t("profiles.links.add")}>
          <Input id="link-label" name="label" label={t("profiles.links.label")} />
          <Input
            id="link-url-field"
            name="url"
            type="url"
            label={t("profiles.links.url")}
            help={t("profiles.links.urlHelp")}
          />
        </AddItemForm>
      </section>

      <section aria-labelledby="certs-heading" className="flex max-w-layout-form flex-col gap-8">
        <Heading id="certs-heading">{t("profiles.certifications.title")}</Heading>
        {certifications.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("profiles.certifications.none")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {certifications.data.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-12 py-8">
                <span className="flex flex-col gap-2 text-text-13">
                  <span className="font-medium">
                    {c.name} · {c.issuingBody}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {c.verified
                      ? t("profiles.certifications.verified")
                      : t("profiles.certifications.unverified")}
                    {c.expiresOn
                      ? ` · ${t("profiles.certifications.expires", { date: c.expiresOn })}`
                      : ""}
                  </span>
                </span>
                <RemoveItemButton org={org} kind="certification" id={c.id} label={c.name} />
              </li>
            ))}
          </ul>
        )}
        {carryable.data.filter((h) => !h.carried).length > 0 ? (
          <div className="flex flex-col gap-8 rounded-card border border-border-subtle p-12">
            <p className="m-0 text-text-13">{t("profiles.certifications.carryIntro")}</p>
            {carryable.data
              .filter((h) => !h.carried)
              .map((h) => (
                <div key={h.holderId} className="flex flex-wrap items-center justify-between gap-8">
                  <span className="text-text-13">
                    {h.name} · {h.orgName}
                  </span>
                  <CarryCertificationButton org={org} holderId={h.holderId} name={h.name} />
                </div>
              ))}
          </div>
        ) : null}
        <AddItemForm org={org} kind="certification" submitLabel={t("profiles.certifications.add")}>
          <Input id="cert-name" name="name" label={t("profiles.certifications.name")} />
          <Input id="cert-issuer" name="issuingBody" label={t("profiles.certifications.issuer")} />
          <Input
            id="cert-issued"
            name="issuedOn"
            type="date"
            label={t("profiles.certifications.issuedOn")}
          />
          <Input
            id="cert-expires"
            name="expiresOn"
            type="date"
            label={t("profiles.certifications.expiresOn")}
          />
        </AddItemForm>
      </section>
    </>
  );
}

export async function PrivacyPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const person = ctx.viewer.person;
  if (!person) return <Failed message={t("profiles.loadFailed")} />;
  const [profile, sections] = await Promise.all([
    getMyProfile(ctx.viewer.db),
    listSectionVisibility(ctx.viewer.db, person.id),
  ]);
  if (!profile.ok || !sections.ok) return <Failed message={t("profiles.loadFailed")} />;
  return (
    <PrivacyForm
      key={JSON.stringify([profile.data, [...sections.data]])}
      org={ctx.org.slug}
      visibility={profile.data.visibility}
      searchIndexing={profile.data.searchIndexing}
      marketplaceDiscoverable={profile.data.marketplaceDiscoverable}
      sections={PROFILE_SECTIONS.map((s) => ({
        section: s,
        value: sections.data.get(s) ?? "inherit",
      }))}
    />
  );
}

export async function OrgProfilePanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const canEdit = ctx.capabilities.has("org.profile.write");
  const [profile, verified] = await Promise.all([
    getOrganizationProfile(ctx.viewer.db, ctx.org.id, canEdit),
    isOrganizationVerified(ctx.viewer.db, ctx.org.id),
  ]);
  if (!profile.ok || !verified.ok) return <Failed message={t("profiles.loadFailed")} />;
  if (!profile.data) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("profiles.org.notCreated")}</p>;
  }
  const p = profile.data;
  return (
    <>
      <InlineAlert tone={verified.data ? "success" : "info"}>
        {verified.data ? t("profiles.org.verified") : t("profiles.org.notVerified")}
      </InlineAlert>
      <OrgProfileForm
        key={JSON.stringify(p)}
        org={ctx.org.slug}
        canEdit={canEdit}
        profileUrl={`/c/${p.handle}`}
        profile={{
          handle: p.handle,
          about: p.about ?? "",
          websiteUrl: p.websiteUrl ?? "",
          contactEmail: p.contactEmail ?? "",
          visibility: p.visibility,
          searchIndexing: p.searchIndexing,
        }}
      />
    </>
  );
}

export async function JoiningPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const canInvite = ctx.capabilities.has("org.members.invite");
  const canManage = ctx.capabilities.has("org.members.manage");
  if (!canInvite && !canManage) return null;
  const [roles, links, requests] = await Promise.all([
    listRoles(ctx.viewer.db, ctx.org.id),
    canInvite ? listInviteLinks(ctx.viewer.db, ctx.org.id) : null,
    canManage ? listPendingJoinRequests(ctx.viewer.db, ctx.org.id) : null,
  ]);
  if (!roles.ok || (links && !links.ok) || (requests && !requests.ok)) {
    return <Failed message={t("profiles.loadFailed")} />;
  }
  const roleLabel = (id: string) => {
    const r = roles.data.find((x) => x.id === id);
    return r ? (r.name ?? t(`shell.roles.${r.code}`)) : "";
  };
  const linkRoles = roles.data
    .filter((r) => r.band >= 3)
    .map((r) => ({ value: r.id, label: r.name ?? t(`shell.roles.${r.code}`) }));
  return (
    <>
      {links ? (
        <section aria-labelledby="links-heading" className="flex max-w-layout-form flex-col gap-12">
          <Heading id="links-heading">{t("profiles.join.linksTitle")}</Heading>
          {links.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("profiles.join.noLinks")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {links.data.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-12 py-8">
                  <span className="text-text-13">
                    {t("profiles.join.linkSummary", {
                      role: roleLabel(l.roleId),
                      used: l.useCount,
                      max: l.maxUses,
                      date: l.expiresAt.slice(0, 10),
                    })}
                  </span>
                  <RevokeLinkButton org={ctx.org.slug} linkId={l.id} />
                </li>
              ))}
            </ul>
          )}
          <InviteLinkForm org={ctx.org.slug} roles={linkRoles} />
        </section>
      ) : null}
      {requests ? (
        <section
          aria-labelledby="requests-heading"
          className="flex max-w-layout-form flex-col gap-12"
        >
          <Heading id="requests-heading">{t("profiles.join.requestsTitle")}</Heading>
          {requests.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("profiles.join.noRequests")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {requests.data.map((r) => (
                <li key={r.id} className="flex flex-col gap-4 py-8">
                  <span className="text-label-13 font-medium">
                    {r.personName ?? t("profiles.unnamed")}
                  </span>
                  {r.message ? (
                    <span className="text-text-12 text-text-secondary">{r.message}</span>
                  ) : null}
                  <JoinRequestForm
                    org={ctx.org.slug}
                    requestId={r.id}
                    name={r.personName ?? t("profiles.unnamed")}
                    roles={linkRoles}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </>
  );
}

export async function OffboardingPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.members.manage")) return null;
  const t = await getTranslate();
  const [offboardings, members] = await Promise.all([
    listOpenOffboardings(ctx.viewer.db, ctx.org.id),
    listMembers(ctx.viewer.db, ctx.org.id),
  ]);
  if (!offboardings.ok || !members.ok) return <Failed message={t("profiles.loadFailed")} />;
  return (
    <section
      aria-labelledby="offboarding-heading"
      className="flex max-w-layout-form flex-col gap-12"
    >
      <Heading id="offboarding-heading">{t("profiles.offboarding.title")}</Heading>
      {offboardings.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("profiles.offboarding.none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {offboardings.data.map((o) => (
            <li key={o.id} className="py-8">
              <OffboardingForm
                org={ctx.org.slug}
                offboardingId={o.id}
                name={o.personName ?? t("profiles.unnamed")}
                openRecords={o.openRecords}
                members={members.data
                  .filter((m) => m.personId !== o.personId)
                  .map((m) => ({ value: m.personId, label: m.fullName ?? t("profiles.unnamed") }))}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export async function AutoJoinPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const offers = await listAutoJoinOffers(ctx.viewer.db);
  if (!offers.ok) return <Failed message={t("profiles.loadFailed")} />;
  if (offers.data.length === 0) return null;
  return (
    <section aria-labelledby="auto-join-heading" className="flex max-w-layout-form flex-col gap-8">
      <Heading id="auto-join-heading">{t("profiles.join.offersTitle")}</Heading>
      {offers.data.map((o) => (
        <div key={o.orgId} className="flex flex-wrap items-center justify-between gap-8">
          <span className="text-text-13">{o.orgName}</span>
          <AutoJoinButton orgId={o.orgId} slug={o.orgSlug} name={o.orgName} />
        </div>
      ))}
    </section>
  );
}
