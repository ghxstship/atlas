import { getSubscription } from "@xos/data";
import { listListingReports, listPayTransparencyRules } from "@xos/data/opportunities";
import { Muted, RowLink, Section, Table } from "@/components/opportunities/parts";
import { InlineAlert, PageHeader, Tag } from "@/components/opportunities/ui";
import { enumKey } from "@/lib/opportunities/format";
import { must, setupPage, type SearchParams } from "@/lib/opportunities/page";
import { PLANS } from "@/lib/plans.generated";
import { nodeHref } from "@/lib/shell/sitemap";

/** Every feature a plan includes, following its `extends` chain (Section 16). */
function planFeatures(code: string): Set<string> {
  const features = new Set<string>();
  let plan = PLANS.find((p) => p.code === code);
  while (plan) {
    for (const f of plan.adds) features.add(f);
    const parent = plan.extends;
    plan = parent ? PLANS.find((p) => p.code === parent) : undefined;
  }
  return features;
}

/**
 * Marketplace settings (Section 4.4.3, Section 14.9): whether the plan allows Public listings, the pay transparency rules
 * that gate publishing, the public ranking factors, and the reports people filed against the org's listings, which the
 * platform decides under notice and action with a statement of reasons.
 */
export default async function MarketplaceSettingsPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/marketplace-settings">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.marketplace-settings",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t } = page;
  const [subscription, rules, reports] = await Promise.all([
    getSubscription(ctx.viewer.db, ctx.org.id),
    listPayTransparencyRules(ctx.viewer.db),
    listListingReports(ctx.viewer.db, ctx.org.id),
  ]);
  const planCode = subscription.ok ? subscription.data.planCode : null;
  const publicListings =
    planCode !== null && planFeatures(planCode).has("public_marketplace_listings");
  const billing = nodeHref("settings.billing-and-plan", routeParams);
  const postings = nodeHref("opportunities.postings", routeParams) ?? page.base;
  const ruleRows = must(rules, "pay transparency rules");
  const reportRows = must(reports, "listing reports");
  return (
    <div className="flex max-w-layout-form flex-col gap-24">
      <PageHeader title={t("marketplace.title")} />
      <Section id="marketplace-public" title={t("marketplace.publicTitle")}>
        {publicListings ? (
          <InlineAlert tone="success">{t("marketplace.publicOn")}</InlineAlert>
        ) : (
          <InlineAlert tone="info">{t("marketplace.publicOff")}</InlineAlert>
        )}
        {!publicListings && billing ? (
          <RowLink href={billing}>{t("marketplace.upgrade")}</RowLink>
        ) : null}
        <Muted>{t("marketplace.visibilityHelp")}</Muted>
      </Section>
      <Section id="marketplace-pay" title={t("marketplace.payTitle")}>
        {ruleRows.length === 0 ? (
          <Muted>{t("marketplace.noRules")}</Muted>
        ) : (
          <Table
            caption={t("marketplace.payTitle")}
            rowKey={(r) => r.jurisdictionId}
            rows={ruleRows}
            columns={[
              {
                key: "jurisdiction",
                label: t("fields.jurisdiction"),
                cell: (r) => <span className="font-mono text-text-12">{r.jurisdictionId}</span>,
              },
              {
                key: "required",
                label: t("marketplace.rangeRequired"),
                cell: (r) => (r.requiresPayRange ? t("yes") : t("no")),
              },
              { key: "from", label: t("fields.effectiveFrom"), cell: (r) => r.effectiveFrom },
              { key: "citation", label: t("fields.citation"), cell: (r) => r.citation },
            ]}
          />
        )}
      </Section>
      <Section id="marketplace-ranking" title={t("marketplace.rankingTitle")}>
        <ul className="m-0 flex flex-col gap-4 ps-20 text-text-13">
          {(["skills", "certifications", "location", "availability", "ratings"] as const).map(
            (f) => (
              <li key={f}>{t(`marketplace.ranking.${f}`)}</li>
            ),
          )}
        </ul>
        <Muted>{t("marketplace.noPaidPlacement")}</Muted>
      </Section>
      <Section
        id="marketplace-reports"
        title={t("marketplace.reportsTitle", { count: reportRows.length })}
      >
        {reportRows.length === 0 ? (
          <Muted>{t("marketplace.noReports")}</Muted>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {reportRows.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-13"
              >
                <span className="flex flex-wrap items-center gap-8">
                  <RowLink href={`${postings}?id=${r.opportunityId}`}>
                    {r.opportunityTitle ?? t("marketplace.listing")}
                  </RowLink>
                  <Tag tone="warning">{t(`reportReasons.${enumKey(r.reason)}`)}</Tag>
                </span>
                {r.details ? <span className="text-text-secondary">{r.details}</span> : null}
                <span className="text-text-12 text-text-secondary">
                  {new Date(r.reportedAt).toLocaleString(page.locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
