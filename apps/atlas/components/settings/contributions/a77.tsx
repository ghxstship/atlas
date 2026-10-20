import { getOrgAuthStatus, listPasskeys, listSecondFactors } from "@xos/data/auth-assurance";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { AddFactor } from "@/components/auth/security/add-factor";
import { AddPasskeyButton, RemoveControl, RenameControl } from "@/components/auth/security/manage";
import { InlineAlert } from "@/components/ui";
import { relyingPartyFrom } from "@/lib/auth/assurance";
import { env } from "@/lib/env";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A77's settings panels (RRR-122, Section 9 and Section 4.5.6 personal setting 4, "Security: passkeys, MFA,
 * sessions and devices"): second factors and passkeys on Personal settings, Security. Factors and passkeys live in
 * Supabase Auth and are read with the viewer's session, so a person only ever sees their own.
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

export const contributions: readonly SettingsContribution[] = [
  { node: "me.security", order: 10, Panel: SecondFactorsPanel },
  { node: "me.security", order: 20, Panel: PasskeysPanel },
];
