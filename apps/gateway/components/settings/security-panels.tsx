import {
  deviceName,
  getRecoveryCodeStatus,
  listMySessions,
  type RecoveryCodeStatus,
  type SignedInSession,
} from "@xos/data/account-security";
import { listPasskeys, listSecondFactors } from "@xos/data/auth-assurance";
import type { ReactNode } from "react";
import { AddFactor } from "@/components/auth/security/add-factor";
import {
  signOutOtherSessionsAction,
  signOutSessionAction,
} from "@/app/auth/account-security-actions";
import { ConfirmAction } from "@/components/auth/security/confirm-action";
import { AddPasskeyButton, RemoveControl, RenameControl } from "@/components/auth/security/manage";
import { RecoveryCodesControl } from "@/components/auth/security/recovery-codes";
import { InlineAlert } from "@/components/ui";
import { relyingPartyFrom } from "@/lib/auth/assurance";
import { env } from "@/lib/env";
import { getPersonTimeZone, personToday } from "@/lib/time-zone";
import type { GatewayContext } from "@/lib/shell/context";
import type { Translate } from "@/lib/shell/translate";

/**
 * Settings, Security in Gateway (Section 4.5.8, A77, A99): second factors, recovery codes, passkeys and signed-in
 * sessions of the one sign-in a person uses in Gateway, Atlas and Compass. Read with the person's session, so only
 * their own.
 */

const P = "authSecurity";

function Block({
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

export async function SecurityPanels({
  ctx,
  t,
  locale,
}: {
  ctx: GatewayContext;
  t: Translate;
  locale: string;
}) {
  const [factors, passkeys, codes, sessions, timeZone, today] = await Promise.all([
    listSecondFactors(ctx.db),
    listPasskeys(ctx.db),
    getRecoveryCodeStatus(ctx.db),
    listMySessions(ctx.db),
    getPersonTimeZone(ctx),
    personToday(ctx),
  ]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const verified = factors.ok ? factors.data.filter((f) => f.verified) : [];
  return (
    <>
      <Block
        id="second-factors"
        title={t(`${P}.factors.title`)}
        description={t(`${P}.factors.description`)}
      >
        {!factors.ok ? (
          <InlineAlert tone="danger">{t(`${P}.errors.unexpected`)}</InlineAlert>
        ) : verified.length === 0 ? (
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
      </Block>
      <Block
        id="passkeys"
        title={t(`${P}.passkeys.title`)}
        description={t(`${P}.passkeys.description`)}
      >
        {!passkeys.ok ? (
          <InlineAlert tone="danger">{t(`${P}.errors.unexpected`)}</InlineAlert>
        ) : passkeys.data.length === 0 ? (
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
                        ? t(`${P}.passkeys.lastUsed`, {
                            date: date.format(new Date(p.lastUsedAt)),
                          })
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
      </Block>
      <RecoveryBlock
        t={t}
        holdsFactor={verified.length > 0}
        codes={codes.ok ? codes.data : null}
        date={(iso) => date.format(new Date(iso))}
        dateTime={(iso) => dateTime.format(new Date(iso))}
        today={today}
      />
      <SessionsBlock
        t={t}
        sessions={sessions.ok ? sessions.data : null}
        dateTime={(iso) => dateTime.format(new Date(iso))}
      />
    </>
  );
}

// Recovery codes and sessions (A99, ADR 0055) ----------------------------------------------------------------------------

function RecoveryBlock({
  t,
  holdsFactor,
  codes,
  date,
  dateTime,
  today,
}: {
  t: Translate;
  today: string;
  holdsFactor: boolean;
  codes: RecoveryCodeStatus | null;
  date: (iso: string) => string;
  dateTime: (iso: string) => string;
}) {
  return (
    <Block
      id="recovery-codes"
      title={t(`${P}.recovery.title`)}
      description={t(`${P}.recovery.description`)}
    >
      {!codes ? (
        <InlineAlert tone="danger">{t(`${P}.errors.unexpected`)}</InlineAlert>
      ) : !holdsFactor ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.recovery.needFactor`)}</p>
      ) : (
        <>
          {codes.total === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.recovery.none`)}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="m-0 text-text-13">
                {t(`${P}.recovery.status`, {
                  remaining: codes.remaining,
                  total: codes.total,
                  date: codes.createdAt ? date(codes.createdAt) : "",
                })}
              </p>
              {codes.lastUsedAt ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t(`${P}.recovery.lastUsed`, { date: dateTime(codes.lastUsedAt) })}
                </p>
              ) : null}
              {codes.remaining === 0 ? (
                <InlineAlert tone="warning">{t(`${P}.recovery.noneLeft`)}</InlineAlert>
              ) : codes.remaining <= 3 ? (
                <InlineAlert tone="warning">
                  {t(`${P}.recovery.low`, { remaining: codes.remaining })}
                </InlineAlert>
              ) : null}
            </div>
          )}
          <RecoveryCodesControl hasCodes={codes.total > 0} today={today} />
        </>
      )}
    </Block>
  );
}

function deviceLabel(t: Translate, session: SignedInSession): string {
  if (!session.userAgent) return t(`${P}.sessions.unknownDevice`);
  const device = deviceName(session.userAgent);
  return t(`${P}.sessions.device`, {
    browser: t(`${P}.sessions.browsers.${device.browser}`),
    os: t(`${P}.sessions.systems.${device.os}`),
  });
}

function SessionsBlock({
  t,
  sessions,
  dateTime,
}: {
  t: Translate;
  sessions: readonly SignedInSession[] | null;
  dateTime: (iso: string) => string;
}) {
  return (
    <Block
      id="sessions"
      title={t(`${P}.sessions.title`)}
      description={t(`${P}.sessions.description`)}
    >
      {!sessions ? (
        <InlineAlert tone="danger">{t(`${P}.errors.unexpected`)}</InlineAlert>
      ) : (
        <>
          <ul
            aria-label={t(`${P}.sessions.title`)}
            className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
          >
            {sessions.map((s) => {
              const device = deviceLabel(t, s);
              const active = dateTime(s.lastActiveAt);
              const where = s.place
                ? t(`${P}.sessions.place`, { place: s.place })
                : s.clientAddress
                  ? t(`${P}.sessions.address`, { address: s.clientAddress })
                  : null;
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
          {sessions.some((s) => !s.current) ? (
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
          ) : (
            <p role="status" className="m-0 text-text-13 text-text-secondary">
              {t(`${P}.sessions.none`)}
            </p>
          )}
        </>
      )}
    </Block>
  );
}
