import { listMyConnectedApps } from "@xos/data/connected-apps";
import { listPayoutAccounts, listTaxForms } from "@xos/data/gateway";
import { revokeConnectedAppAction } from "@/app/[org]/settings/surface-actions";
import type { SettingsPanelProps } from "../contributions/types";
import { SurfaceButton } from "./forms";
import { formatters, LoadFailed, P, Quiet, Rows, Section, TextLink } from "./kit";

/**
 * Personal settings panels (A86, RRR-131, finding A65-004):
 *   Connected Apps   the apps the person let act for them, with revoke (Section 4.5.6 personal item 13, 0638)
 *   Payout and Tax   where each org pays the person and the tax forms they signed, last four only (item 11, 0730).
 *                    The same lists Gateway shows; details are entered with each org's payment provider and in
 *                    engagement onboarding, never typed here.
 */

export async function ConnectedAppsPanel({ ctx }: SettingsPanelProps) {
  const [f, apps] = await Promise.all([formatters(ctx), listMyConnectedApps(ctx.viewer.db)]);
  if (!apps.ok) return <LoadFailed t={f.t} />;
  return (
    <Section
      id="connected-apps"
      title={f.t(`${P}.connectedApps.title`)}
      description={f.t(`${P}.connectedApps.description`)}
    >
      {apps.data.length === 0 ? (
        <Quiet>{f.t(`${P}.connectedApps.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.connectedApps.title`)}
          rows={apps.data.map((a) => ({
            id: a.grantId,
            title: a.appName,
            meta: [
              f.t(`${P}.connectedApps.registeredBy`, { org: a.orgName }),
              f.t(`${P}.scopesList`, { scopes: a.scopes.join(", ") }),
              f.t(`${P}.connectedApps.granted`, { date: f.day(a.grantedAt) }),
            ],
            actions: (
              <SurfaceButton
                action={revokeConnectedAppAction}
                hidden={{ org: ctx.org.slug, id: a.grantId }}
                label={f.t(`${P}.revoke`)}
                confirm={{
                  title: f.t(`${P}.connectedApps.revokeConfirm.title`, { app: a.appName }),
                  body: f.t(`${P}.connectedApps.revokeConfirm.body`),
                  confirmLabel: f.t(`${P}.connectedApps.revokeConfirm.confirm`),
                  cancelLabel: f.t(`${P}.cancel`),
                }}
              />
            ),
          }))}
        />
      )}
      {ctx.capabilities.has("org.integrations.manage") ? (
        <TextLink href={`/${ctx.org.slug}/settings/integrations`}>
          {f.t(`${P}.connectedApps.toIntegrations`)}
        </TextLink>
      ) : null}
    </Section>
  );
}

export async function PayoutTaxPanel({ ctx }: SettingsPanelProps) {
  const personId = ctx.viewer.person?.id ?? "";
  const [f, payouts, forms] = await Promise.all([
    formatters(ctx),
    listPayoutAccounts(ctx.viewer.db),
    listTaxForms(ctx.viewer.db),
  ]);
  if (!payouts.ok || !forms.ok) return <LoadFailed t={f.t} />;
  const mine = <T extends { personId: string | null }>(rows: readonly T[]) =>
    rows.filter((r) => r.personId === personId);
  const myPayouts = mine(payouts.data);
  const myForms = mine(forms.data);
  return (
    <>
      <Section
        id="payouts"
        title={f.t(`${P}.payout.title`)}
        description={f.t(`${P}.payout.description`)}
      >
        {myPayouts.length === 0 ? (
          <Quiet>{f.t(`${P}.payout.none`)}</Quiet>
        ) : (
          <Rows
            label={f.t(`${P}.payout.title`)}
            rows={myPayouts.map((p) => ({
              id: p.id,
              title: f.t(`${P}.payout.providers.${p.provider.replaceAll(" ", "")}`),
              meta: [p.last4 ? f.t(`${P}.payout.last4`, { last4: p.last4 }) : null],
            }))}
          />
        )}
      </Section>
      <Section
        id="tax-forms"
        title={f.t(`${P}.tax.title`)}
        description={f.t(`${P}.tax.description`)}
      >
        {myForms.length === 0 ? (
          <Quiet>{f.t(`${P}.tax.none`)}</Quiet>
        ) : (
          <Rows
            label={f.t(`${P}.tax.title`)}
            rows={myForms.map((t) => ({
              id: t.id,
              title: t.kind,
              meta: [
                t.orgName,
                f.t(`${P}.payout.last4`, { last4: t.tinLast4 }),
                f.t(`${P}.tax.signed`, { date: f.day(t.signedAt) }),
              ],
            }))}
          />
        )}
      </Section>
    </>
  );
}
