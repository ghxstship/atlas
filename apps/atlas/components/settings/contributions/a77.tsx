import { getSubscription, listRoles } from "@xos/data";
import { getOrgAuthStatus, listPasskeys, listSecondFactors } from "@xos/data/auth-assurance";
import { listIdentityProviders } from "@xos/data/identity-providers";
import { listOrgDomains } from "@xos/data/settings";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { AddFactor } from "@/components/auth/security/add-factor";
import { AddPasskeyButton, RemoveControl, RenameControl } from "@/components/auth/security/manage";
import {
  AddProviderForm,
  ProviderSettingsForm,
  ScimTokenForm,
} from "@/components/settings/identity-provider-forms";
import { InlineAlert } from "@/components/ui";
import { relyingPartyFrom } from "@/lib/auth/assurance";
import { env } from "@/lib/env";
import { planHasFeature } from "@/lib/settings/plan";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A77's settings panels (RRR-122, Section 9 and Section 4.5.6 personal setting 4, "Security: passkeys, MFA,
 * sessions and devices"): second factors and passkeys on Personal settings, Security, and Enterprise single sign-on
 * and SCIM on Settings, Security. Factors and passkeys live in Supabase Auth and are read with the viewer's session,
 * so a person only ever sees their own.
 */

const P = "authSecurity";

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex max-w-layout-form flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{description}</p>
      </header>
      {children}
    </section>
  );
}

// Second factors -------------------------------------------------------------------------------------------------

async function SecondFactorsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [factors, status, locale] = await Promise.all([
    listSecondFactors(ctx.viewer.db),
    getOrgAuthStatus(ctx.viewer.db, ctx.org.id),
    getLocale(),
  ]);
  if (!factors.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const verified = factors.data.filter((f) => f.verified);
  const required = status.ok && status.data?.mfaRequired === true;
  return (
    <Section
      id="second-factors"
      title={t(`${P}.factors.title`)}
      description={t(`${P}.factors.description`)}
    >
      {required ? (
        <InlineAlert tone={verified.length === 0 ? "warning" : "info"}>
          {t(`${P}.factors.required`, { org: ctx.org.name })}
        </InlineAlert>
      ) : null}
      {verified.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.factors.none`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.factors.title`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {verified.map((f) => {
            const name = f.label || t(`${P}.factorTypes.${f.type}`);
            return (
              <li key={f.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-label-13 font-medium break-words">{name}</span>
                  <span className="text-text-12 text-text-secondary">
                    {t(`${P}.factorTypes.${f.type}`)} ·{" "}
                    {t(`${P}.factors.added`, { date: date.format(new Date(f.createdAt)) })}
                  </span>
                </div>
                <div className="flex flex-wrap items-start gap-4">
                  <RenameControl kind="factor" id={f.id} name={name} />
                  <RemoveControl kind="factor" id={f.id} name={name} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AddFactor securityKeys={relyingPartyFrom(env()) !== null} />
      <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.enroll.recovery`)}</p>
    </Section>
  );
}

// Passkeys ----------------------------------------------------------------------------------------------------------

async function PasskeysPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [passkeys, locale] = await Promise.all([listPasskeys(ctx.viewer.db), getLocale()]);
  if (!passkeys.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <Section
      id="passkeys"
      title={t(`${P}.passkeys.title`)}
      description={t(`${P}.passkeys.description`)}
    >
      {passkeys.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.passkeys.none`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.passkeys.title`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {passkeys.data.map((p) => {
            const name = p.label || t(`${P}.passkeys.labelDefault`);
            return (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-label-13 font-medium break-words">{name}</span>
                  <span className="text-text-12 text-text-secondary">
                    {t(`${P}.passkeys.added`, { date: date.format(new Date(p.createdAt)) })} ·{" "}
                    {p.lastUsedAt
                      ? t(`${P}.passkeys.lastUsed`, { date: date.format(new Date(p.lastUsedAt)) })
                      : t(`${P}.passkeys.neverUsed`)}
                  </span>
                </div>
                <div className="flex flex-wrap items-start gap-4">
                  <RenameControl kind="passkey" id={p.id} name={name} />
                  <RemoveControl kind="passkey" id={p.id} name={name} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AddPasskeyButton />
    </Section>
  );
}

// Enterprise single sign-on and SCIM ---------------------------------------------------------------------------------

async function IdentityProvidersPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.settings.read")) return null;
  const t = await getTranslate();
  const [providers, subscription, roles, domains] = await Promise.all([
    listIdentityProviders(ctx.viewer.db, ctx.org.id),
    getSubscription(ctx.viewer.db, ctx.org.id),
    listRoles(ctx.viewer.db, ctx.org.id),
    listOrgDomains(ctx.viewer.db, ctx.org.id),
  ]);
  if (!providers.ok || !subscription.ok || !roles.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const inPlan = planHasFeature(subscription.data.planCode, "saml_sso");
  const canEdit = ctx.capabilities.has("org.security.write");
  // Single sign-on never makes anyone an Owner (0638), so the Owner band is not offered.
  const roleOptions = roles.data
    .filter((r) => r.band !== 1)
    .map((r) => ({ value: r.id, label: r.name ?? t(`shell.roles.${r.code}`) }));
  const roleName = new Map(roleOptions.map((r) => [r.value, r.label]));
  const verified = domains.ok
    ? domains.data
        .filter((d) => d.purpose === "Verified Domain" && d.state === "Verified")
        .map((d) => d.hostname)
    : [];
  const endpoint = `${env().SUPABASE_URL.replace(/\/$/, "")}/functions/v1/scim/v2`;
  return (
    <Section
      id="identity-providers"
      title={t(`${P}.providers.title`)}
      description={t(`${P}.providers.description`)}
    >
      {!inPlan ? <InlineAlert tone="info">{t(`${P}.providers.notInPlan`)}</InlineAlert> : null}
      {verified.length > 0 ? (
        <p className="m-0 text-text-13">
          {t(`${P}.providers.domains`, { domains: verified.join(", ") })}
        </p>
      ) : null}
      {providers.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.providers.none`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.providers.title`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {providers.data.map((p) => (
            <li key={p.id} className="flex flex-col gap-8 py-12">
              <span className="text-label-13 font-medium break-words">{p.name}</span>
              <span className="text-text-12 text-text-secondary">
                {p.protocol} · {t(`${P}.providers.providerId`)}{" "}
                <code className="font-mono break-all">{p.authProviderId}</code>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`${P}.providers.defaultRole`)}: {roleName.get(p.defaultRoleId) ?? ""} ·{" "}
                {p.jitEnabled ? t(`${P}.providers.jitOn`) : null}
                {p.jitEnabled ? " · " : null}
                {t(p.scimEnabled ? `${P}.providers.scimOn` : `${P}.providers.scimOff`)}
              </span>
              {p.scimEnabled ? (
                <span className="text-text-12 text-text-secondary">
                  {t(`${P}.providers.endpoint`)}:{" "}
                  <code className="font-mono break-all">{endpoint}</code> ·{" "}
                  {p.scimTokenPrefix
                    ? t(`${P}.providers.tokenIssued`, { prefix: p.scimTokenPrefix })
                    : t(`${P}.providers.tokenNone`)}
                </span>
              ) : null}
              {canEdit && inPlan ? (
                <ProviderSettingsForm
                  org={ctx.org.slug}
                  providerId={p.id}
                  name={p.name}
                  roles={roleOptions}
                  defaultRoleId={p.defaultRoleId}
                  jitEnabled={p.jitEnabled}
                  scimEnabled={p.scimEnabled}
                />
              ) : null}
              {canEdit && inPlan && p.scimEnabled ? (
                <ScimTokenForm
                  org={ctx.org.slug}
                  providerId={p.id}
                  issued={p.scimTokenPrefix !== null}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit && inPlan ? <AddProviderForm org={ctx.org.slug} roles={roleOptions} /> : null}
    </Section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.security", order: 10, Panel: SecondFactorsPanel },
  { node: "me.security", order: 20, Panel: PasskeysPanel },
  { node: "settings.security", order: 50, Panel: IdentityProvidersPanel },
];
