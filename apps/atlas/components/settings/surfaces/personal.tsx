import { listPayoutAccounts, listTaxForms } from "@xos/data/gateway";
import type { SettingsPanelProps } from "../contributions/types";
import { formatters, LoadFailed, P, Quiet, Rows, Section } from "./kit";

/**
 * Personal settings panels (A86, RRR-131, finding A65-004):
 *   Payout and Tax   where each org pays the person and the tax forms they signed, last four only (item 11, 0730).
 *                    The same lists Gateway shows; details are entered with each org's payment provider and in
 *                    engagement onboarding, never typed here.
 */

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
