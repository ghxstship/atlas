import {
  deviceName,
  getRecoveryCodeStatus,
  listMySessions,
  type SignedInSession,
} from "@xos/data/account-security";
import { listSecondFactors } from "@xos/data/auth-assurance";
import { dateIn } from "@xos/data/calendar";
import { listConnectedApps, listOAuthApps } from "@xos/data/oauth";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import {
  revokeConnectedAppAction,
  signOutOtherSessionsAction,
  signOutSessionAction,
} from "@/app/auth/account-security-actions";
import { ConfirmAction } from "@/components/auth/security/confirm-action";
import { RecoveryCodesControl } from "@/components/auth/security/recovery-codes";
import { RegisterOAuthAppForm } from "@/components/settings/a99-forms";
import { InlineAlert } from "@/components/ui";
import { env } from "@/lib/env";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { removeOAuthAppAction } from "./a99-actions";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A99's settings panels (RRR-144, ADR 0055; Section 4.5.6 personal setting 4, "Security: passkeys, MFA, sessions and
 * devices", personal setting Connected Apps and org setting 32 Integrations): recovery codes and signed-in sessions on
 * Personal settings, Security; apps the person connected on Connected apps; registered OAuth apps on org settings. Org
 * API keys are A86's panel (surfaces/developer.tsx), whose keys act as a service account; app.create_api_key asks for
 * step-up there (1562). Personal panels read with the viewer's session, so a person only ever sees their own codes,
 * sessions and grants; admins see no one else's sessions (Section 4.5.6 lists sessions under the person's own
 * settings only).
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

async function formatters(ctx: SettingsPanelProps["ctx"]) {
  const [locale, timeZone] = await Promise.all([getLocale(), getOrgTimeZone(ctx)]);
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone });
  return {
    dateTime: (iso: string) => dateTime.format(new Date(iso)),
    date: (iso: string) => date.format(new Date(iso)),
    today: dateIn(new Date(), timeZone),
    /** Read once per panel, outside render. */
    nowMs: Date.now(),
  };
}

const scopeList = (t: Translate, scopes: readonly string[]) =>
  scopes.map((s) => t(`${P}.scopes.${s}`)).join(", ");

// Recovery codes ------------------------------------------------------------------------------------------------------------

async function RecoveryCodesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [status, factors, format] = await Promise.all([
    getRecoveryCodeStatus(ctx.viewer.db),
    listSecondFactors(ctx.viewer.db),
    formatters(ctx),
  ]);
  if (!status.ok || !factors.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const holdsFactor = factors.data.some((f) => f.verified);
  const s = status.data;
  return (
    <Section
      id="recovery-codes"
      title={t(`${P}.recovery.title`)}
      description={t(`${P}.recovery.description`)}
    >
      {!holdsFactor ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.recovery.needFactor`)}</p>
      ) : (
        <>
          {s.total === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.recovery.none`)}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="m-0 text-text-13">
                {t(`${P}.recovery.status`, {
                  remaining: s.remaining,
                  total: s.total,
                  date: s.createdAt ? format.date(s.createdAt) : "",
                })}
              </p>
              {s.lastUsedAt ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t(`${P}.recovery.lastUsed`, { date: format.dateTime(s.lastUsedAt) })}
                </p>
              ) : null}
              {s.remaining === 0 ? (
                <InlineAlert tone="warning">{t(`${P}.recovery.noneLeft`)}</InlineAlert>
              ) : s.remaining <= 3 ? (
                <InlineAlert tone="warning">
                  {t(`${P}.recovery.low`, { remaining: s.remaining })}
                </InlineAlert>
              ) : null}
            </div>
          )}
          <RecoveryCodesControl hasCodes={s.total > 0} today={format.today} />
        </>
      )}
    </Section>
  );
}

// Sessions and devices -------------------------------------------------------------------------------------------------------

function deviceLabel(t: Translate, session: SignedInSession): string {
  if (!session.userAgent) return t(`${P}.sessions.unknownDevice`);
  const device = deviceName(session.userAgent);
  return t(`${P}.sessions.device`, {
    browser: t(`${P}.sessions.browsers.${device.browser}`),
    os: t(`${P}.sessions.systems.${device.os}`),
  });
}

async function SessionsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [sessions, format] = await Promise.all([listMySessions(ctx.viewer.db), formatters(ctx)]);
  if (!sessions.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const others = sessions.data.filter((s) => !s.current);
  return (
    <Section
      id="sessions"
      title={t(`${P}.sessions.title`)}
      description={t(`${P}.sessions.description`)}
    >
      <ul
        aria-label={t(`${P}.sessions.title`)}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
      >
        {sessions.data.map((s) => {
          const device = deviceLabel(t, s);
          const where = s.place
            ? t(`${P}.sessions.place`, { place: s.place })
            : s.clientAddress
              ? t(`${P}.sessions.address`, { address: s.clientAddress })
              : null;
          const active = format.dateTime(s.lastActiveAt);
          return (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-label-13 font-medium break-words">
                  {device}
                  {s.current ? (
                    <span className="ms-8 rounded-pill bg-accent-subtle px-8 py-2 text-text-11 font-semibold text-accent-text">
                      {t(`${P}.sessions.thisDevice`)}
                    </span>
                  ) : null}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {[
                    s.surface ? t(`${P}.sessions.surfaces.${s.surface}`) : null,
                    where,
                    t(`${P}.sessions.lastActive`, { date: active }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t(`${P}.sessions.signedIn`, { date: format.dateTime(s.signedInAt) })}
                  {s.secondFactor ? ` · ${t(`${P}.sessions.secondFactor`)}` : ""}
                </span>
              </div>
              {s.current ? null : (
                <ConfirmAction
                  action={signOutSessionAction}
                  fields={{ sessionId: s.id }}
                  formId={`sign-out-${s.id}`}
                  trigger={t(`${P}.sessions.signOut`)}
                  triggerLabel={t(`${P}.sessions.signOutLabel`, { device, date: active })}
                  title={t(`${P}.sessions.signOutTitle`, { device })}
                  sentence={t(`${P}.sessions.signOutSentence`)}
                  confirm={t(`${P}.sessions.signOut`)}
                  successKey="sessions.signedOut"
                  cancel={t(`${P}.sessions.cancel`)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {others.length === 0 ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t(`${P}.sessions.none`)}
        </p>
      ) : (
        <ConfirmAction
          action={signOutOtherSessionsAction}
          fields={{}}
          formId="sign-out-others"
          variant="secondary"
          trigger={t(`${P}.sessions.signOutOthers`)}
          title={t(`${P}.sessions.signOutOthersTitle`)}
          sentence={t(`${P}.sessions.signOutOthersSentence`)}
          confirm={t(`${P}.sessions.signOutOthers`)}
          successKey="sessions.signedOutOthers"
          cancel={t(`${P}.sessions.cancel`)}
        />
      )}
    </Section>
  );
}

// Connected apps ----------------------------------------------------------------------------------------------------------------

async function ConnectedAppsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [apps, format] = await Promise.all([listConnectedApps(ctx.viewer.db), formatters(ctx)]);
  if (!apps.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  return (
    <Section
      id="connected-apps"
      title={t(`${P}.connectedApps.title`)}
      description={t(`${P}.connectedApps.description`)}
    >
      {apps.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.connectedApps.none`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.connectedApps.title`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {apps.data.map((a) => (
            <li key={a.grantId} className="flex flex-wrap items-start justify-between gap-12 py-12">
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-label-13 font-medium break-words">{a.appName}</span>
                <span className="text-text-12 text-text-secondary">
                  {t(`${P}.connectedApps.org`, { org: a.orgName })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t(`${P}.connectedApps.scopes`, { scopes: scopeList(t, a.scopes) })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t(`${P}.connectedApps.granted`, { date: format.date(a.grantedAt) })} ·{" "}
                  {a.lastUsedAt
                    ? t(`${P}.connectedApps.lastUsed`, { date: format.dateTime(a.lastUsedAt) })
                    : t(`${P}.connectedApps.neverUsed`)}
                </span>
              </div>
              <ConfirmAction
                action={revokeConnectedAppAction}
                fields={{ grantId: a.grantId }}
                formId={`revoke-app-${a.grantId}`}
                trigger={t(`${P}.connectedApps.revoke`)}
                triggerLabel={t(`${P}.connectedApps.revokeLabel`, { app: a.appName })}
                title={t(`${P}.connectedApps.revokeTitle`, { app: a.appName })}
                sentence={t(`${P}.connectedApps.revokeSentence`, { app: a.appName })}
                confirm={t(`${P}.connectedApps.revoke`)}
                successKey="connectedApps.revoked"
                cancel={t(`${P}.connectedApps.cancel`)}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// Registered OAuth apps --------------------------------------------------------------------------------------------------------------

async function OAuthAppsPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.settings.read")) return null;
  const t = await getTranslate();
  const apps = await listOAuthApps(ctx.viewer.db, ctx.org.id);
  if (!apps.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const canEdit = ctx.capabilities.has("org.integrations.manage");
  const site = env().ATLAS_SITE_URL.replace(/\/$/, "");
  const authorizeUrl = `${site}/oauth/authorize`;
  const tokenUrl = `${site}/oauth/token`;
  return (
    <Section
      id="oauth-apps"
      title={t(`${P}.oauthApps.title`)}
      description={t(`${P}.oauthApps.description`, { org: ctx.org.name })}
    >
      <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.oauthApps.pkce`)}</p>
      <dl className="m-0 grid grid-cols-1 gap-4 text-text-12 sm:grid-cols-[auto_1fr]">
        <dt className="text-text-secondary">{t(`${P}.oauthApps.authorizeUrl`)}</dt>
        <dd className="m-0">
          <code className="font-mono break-all">{authorizeUrl}</code>
        </dd>
        <dt className="text-text-secondary">{t(`${P}.oauthApps.tokenUrl`)}</dt>
        <dd className="m-0">
          <code className="font-mono break-all">{tokenUrl}</code>
        </dd>
      </dl>
      {apps.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.oauthApps.none`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.oauthApps.title`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {apps.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-label-13 font-medium break-words">{a.name}</span>
                <span className="text-text-12 text-text-secondary break-all">{a.redirectUri}</span>
                {a.clientId ? (
                  <span className="text-text-12 text-text-secondary">
                    {t(`${P}.oauthApps.clientId`)}{" "}
                    <code className="font-mono break-all">{a.clientId}</code>
                  </span>
                ) : null}
              </div>
              {canEdit ? (
                <ConfirmAction
                  action={removeOAuthAppAction}
                  fields={{ org: ctx.org.slug, appId: a.id }}
                  formId={`remove-app-${a.id}`}
                  trigger={t(`${P}.oauthApps.remove`)}
                  triggerLabel={t(`${P}.oauthApps.removeLabel`, { name: a.name })}
                  title={t(`${P}.oauthApps.removeTitle`, { name: a.name })}
                  sentence={t(`${P}.oauthApps.removeSentence`)}
                  confirm={t(`${P}.oauthApps.remove`)}
                  successKey="oauthApps.removed"
                  cancel={t(`${P}.oauthApps.cancel`)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? <RegisterOAuthAppForm org={ctx.org.slug} /> : null}
    </Section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.security", order: 15, Panel: RecoveryCodesPanel },
  { node: "me.security", order: 30, Panel: SessionsPanel },
  { node: "me.connected-apps", order: 10, Panel: ConnectedAppsPanel },
  { node: "settings.integrations", order: 40, Panel: OAuthAppsPanel },
];
