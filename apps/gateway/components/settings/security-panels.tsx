import { listPasskeys, listSecondFactors } from "@xos/data/auth-assurance";
import type { ReactNode } from "react";
import { AddFactor } from "@/components/auth/security/add-factor";
import { AddPasskeyButton, RemoveControl, RenameControl } from "@/components/auth/security/manage";
import { InlineAlert } from "@/components/ui";
import { relyingPartyFrom } from "@/lib/auth/assurance";
import { env } from "@/lib/env";
import type { GatewayContext } from "@/lib/shell/context";
import type { Translate } from "@/lib/shell/translate";

/**
 * Settings, Security in Gateway (Section 4.5.8, A77): second factors and passkeys of the one sign-in a person
 * uses in Gateway, Atlas and Compass. Read with the person's session from Supabase Auth, so only their own.
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
  const [factors, passkeys] = await Promise.all([listSecondFactors(ctx.db), listPasskeys(ctx.db)]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
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
    </>
  );
}
