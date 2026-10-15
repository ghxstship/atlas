import { listPayoutAccounts, listTaxForms } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { LinkTable } from "@/components/page/collections";
import { RowList } from "@/components/engagement/rows";
import { PageTitle, pickView, RegionError, Section, ViewSwitcher } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { EmptyStateLink, InlineAlert } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.money.taxDocuments") };
}

/**
 * Money, Tax documents (Section 4.4.5, Section 8.7): the tax forms the person or their account
 * gave each org, which never close, and the payout destinations by org. Only the last four
 * characters of an identifier or account are ever shown.
 */
export default async function TaxDocumentsPage({
  searchParams,
}: PageProps<"/money/tax-documents">) {
  const ctx = await requireNode("money.tax-documents");
  const query = await searchParams;
  const views = getNode(sitemap, "money.tax-documents").node.list?.views ?? ["table"];
  const view = pickView(query["view"], views, "table");
  const [t, locale, forms, payouts] = await Promise.all([
    getTranslate(),
    getLocale(),
    listTaxForms(ctx.db),
    listPayoutAccounts(ctx.db),
  ]);
  return (
    <>
      <PageTitle
        title={t("nav.gateway.primary.money")}
        action={
          <ViewSwitcher views={views} current={view} path="/money/tax-documents" query={query} />
        }
      />
      <DestinationTabs ctx={ctx} destination="money" active="money.tax-documents" t={t} />
      <InlineAlert tone="info">{t("gateway.money.tax.yearEnd")}</InlineAlert>
      {!forms.ok ? (
        <RegionError />
      ) : forms.data.length === 0 ? (
        <EmptyStateLink
          icon="FileText"
          sentence={t("gateway.money.tax.empty")}
          actionLabel={t("gateway.money.tax.emptyAction")}
          href="/work/engagements"
        />
      ) : view === "list" ? (
        <RowList
          label={t("nav.gateway.money.taxDocuments")}
          items={forms.data.map((f) => ({
            id: f.id,
            title: t(enumLabelKey("taxFormKind", f.kind)),
            meta: [
              f.orgName,
              t("gateway.money.tax.last4", { last4: f.tinLast4 }),
              formatDate(locale, f.signedAt),
              f.foreignPerformerWithholding ? t("gateway.money.tax.withholding") : null,
            ],
          }))}
        />
      ) : (
        <LinkTable
          caption={t("nav.gateway.money.taxDocuments")}
          columns={[
            { key: "form", label: t("gateway.money.tax.form") },
            { key: "org", label: t("gateway.work.engagements.org") },
            { key: "tin", label: t("gateway.money.tax.tin"), type: "code" },
            { key: "signed", label: t("gateway.money.tax.signed") },
            { key: "withholding", label: t("gateway.money.tax.withholdingColumn") },
          ]}
          rows={forms.data.map((f) => ({
            form: t(enumLabelKey("taxFormKind", f.kind)),
            org: f.orgName,
            tin: t("gateway.money.tax.last4", { last4: f.tinLast4 }),
            signed: formatDate(locale, f.signedAt),
            withholding: f.foreignPerformerWithholding
              ? t("gateway.money.tax.yes")
              : t("gateway.money.tax.no"),
          }))}
        />
      )}
      <Section title={t("gateway.money.tax.payouts")}>
        {!payouts.ok ? (
          <RegionError />
        ) : payouts.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("gateway.money.tax.noPayouts")}</p>
        ) : (
          <RowList
            label={t("gateway.money.tax.payouts")}
            items={payouts.data.map((p) => ({
              id: p.id,
              title: t(enumLabelKey("payoutProvider", p.provider)),
              meta: [p.last4 ? t("gateway.money.tax.last4", { last4: p.last4 }) : null],
            }))}
          />
        )}
      </Section>
    </>
  );
}
