import {
  getPartnerAgreement,
  listClientOrgs,
  listWholesaleStatements,
  monthStart,
} from "@xos/data/partner";
import { WholesaleRun } from "@/components/partner/wholesale";
import { ErrorPanel } from "@/components/platform/kit";
import { DataTable } from "@/components/platform/client/data-table";
import { InlineAlert } from "@/components/platform/client/inline-alert";
import { PartnerFrame } from "@/components/partner/partner-frame";
import { requireNode } from "@/lib/shell/require-node";
import { getFormatters } from "@/lib/platform/format";

/**
 * Wholesale billing (Section 4.6.1, Owner only): the platform bills the partner each client's list
 * price less the agreed discount. Running a month records the statement; charging goes through the
 * billing service. Unpriced lines are counted, never treated as zero.
 */
export default async function Page({
  params,
}: PageProps<"/partner/[partnerSlug]/wholesale-billing">) {
  const ctx = await requireNode("partner-console.wholesale-billing", await params);
  const { t, money, month, number } = await getFormatters(ctx);
  const [agreement, statements, clients] = await Promise.all([
    getPartnerAgreement(ctx.viewer.db, ctx.org.id),
    listWholesaleStatements(ctx.viewer.db, ctx.org.id),
    listClientOrgs(ctx.viewer.db, ctx.org.id),
  ]);
  if (!agreement.ok || !statements.ok || !clients.ok) {
    return (
      <PartnerFrame ctx={ctx} node="partner-console.wholesale-billing">
        <ErrorPanel sentence={t("partner.wholesale.loadError")} />
      </PartnerFrame>
    );
  }
  // Usage rollups and wholesale statements are kept by UTC month (0510, 1060), so the current
  // period here is the UTC month on purpose, not the partner's calendar month.
  const period = monthStart(new Date());
  const names = new Map(clients.data.map((c) => [c.id, c.name]));
  return (
    <PartnerFrame ctx={ctx} node="partner-console.wholesale-billing">
      {agreement.data ? (
        <p className="m-0 text-text-13">
          {t("partner.wholesale.terms", {
            percent: number(agreement.data.discountBps / 100),
            currency: agreement.data.currency,
          })}
        </p>
      ) : (
        <InlineAlert tone="info" title={t("partner.noAgreement.title")}>
          {t("partner.noAgreement.body")}
        </InlineAlert>
      )}
      <WholesaleRun
        org={ctx.org.slug}
        period={period}
        periodLabel={month(period)}
        billed={statements.data.some((s) => s.periodStart === period)}
      />
      {statements.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("partner.wholesale.empty")}</p>
      ) : (
        statements.data.map((s) => (
          <section key={s.id} aria-labelledby={`statement-${s.id}`} className="flex flex-col gap-8">
            <h2 id={`statement-${s.id}`} className="m-0 text-text-15 font-semibold">
              {t("partner.wholesale.statementTitle", { month: month(s.periodStart) })}
            </h2>
            <p className="m-0 text-text-13 text-text-secondary">
              {t("partner.wholesale.statementTotals", {
                clients: s.clientCount,
                list: money(s.listTotalMinor, s.currency),
                wholesale: money(s.wholesaleTotalMinor, s.currency),
                unpriced: s.unpricedCount,
              })}
            </p>
            <DataTable
              caption={t("partner.wholesale.statementTitle", { month: month(s.periodStart) })}
              label={t("partner.wholesale.statementTitle", { month: month(s.periodStart) })}
              height="auto"
              columns={[
                { key: "client", label: t("partner.clients.columns.name") },
                { key: "plan", label: t("partner.clients.columns.plan") },
                { key: "list", label: t("partner.wholesale.list") },
                { key: "wholesale", label: t("partner.wholesale.wholesale") },
                { key: "charge", label: t("partner.wholesale.charge") },
                { key: "margin", label: t("partner.wholesale.margin") },
              ]}
              rows={s.lines.map((l) => ({
                id: l.clientOrgId,
                client: names.get(l.clientOrgId) ?? t("partner.wholesale.formerClient"),
                plan: t(`partner.plans.${l.planCode}`),
                list: money(l.listMinor, s.currency),
                wholesale: money(l.wholesaleMinor, s.currency),
                charge:
                  l.clientPriceMinor === null
                    ? t("partner.clients.noPrice")
                    : money(l.clientPriceMinor, s.currency),
                margin:
                  l.clientPriceMinor === null || l.wholesaleMinor === null
                    ? t("common.unpriced")
                    : money(l.clientPriceMinor - l.wholesaleMinor, s.currency),
              }))}
            />
          </section>
        ))
      )}
    </PartnerFrame>
  );
}
