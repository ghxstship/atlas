import { listPayments } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { LinkTable } from "@/components/page/collections";
import { RowList } from "@/components/engagement/rows";
import { PageTitle, pickView, RegionError, ViewSwitcher } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { EmptyStateLink } from "@/components/ui";
import { inBrandScope } from "@/lib/brand/brand";
import { formatDate, formatMoney } from "@/lib/format";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.money.payments") };
}

/**
 * Money, Payments (Section 4.4.5): what orgs paid the person's accounts, through the org's own
 * rails. Account Finance, Owners and Admins see the account's payments; nothing here holds funds.
 */
export default async function PaymentsPage({ searchParams }: PageProps<"/money/payments">) {
  const ctx = await requireNode("money.payments");
  const query = await searchParams;
  const views = getNode(sitemap, "money.payments").node.list?.views ?? ["table"];
  const view = pickView(query["view"], views, "table");
  const [t, locale, payments] = await Promise.all([
    getTranslate(),
    getLocale(),
    listPayments(ctx.db),
  ]);
  const rows = payments.ok ? payments.data.filter((p) => inBrandScope(ctx.brand, p.orgId)) : [];
  return (
    <>
      <PageTitle
        title={t("nav.gateway.primary.money")}
        action={<ViewSwitcher views={views} current={view} path="/money/payments" query={query} />}
      />
      <DestinationTabs ctx={ctx} destination="money" active="money.payments" t={t} />
      {!payments.ok ? (
        <RegionError />
      ) : rows.length === 0 ? (
        <EmptyStateLink
          icon="Banknote"
          sentence={t("gateway.money.payments.empty")}
          actionLabel={t("gateway.money.payments.emptyAction")}
          href="/money/invoices"
        />
      ) : view === "list" ? (
        <RowList
          label={t("nav.gateway.money.payments")}
          items={rows.map((p) => ({
            id: p.id,
            title: formatMoney(locale, p.amountMinor, p.currency) ?? "",
            meta: [p.orgName, p.paidOn ? formatDate(locale, p.paidOn) : null, p.reference],
            tag: { label: t(enumLabelKey("paymentState", p.state)), tone: toneFor(p.state) },
          }))}
        />
      ) : (
        <LinkTable
          caption={t("nav.gateway.money.payments")}
          columns={[
            { key: "paid", label: t("gateway.money.payments.paidOn") },
            { key: "org", label: t("gateway.work.engagements.org") },
            { key: "amount", label: t("gateway.money.payments.amount") },
            { key: "reference", label: t("gateway.money.payments.reference"), type: "code" },
            { key: "state", label: t("gateway.work.engagements.state") },
          ]}
          rows={rows.map((p) => ({
            paid: p.paidOn ? formatDate(locale, p.paidOn) : "",
            org: p.orgName,
            amount: formatMoney(locale, p.amountMinor, p.currency) ?? "",
            reference: p.reference ?? "",
            state: t(enumLabelKey("paymentState", p.state)),
          }))}
        />
      )}
    </>
  );
}
