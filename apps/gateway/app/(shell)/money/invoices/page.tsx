import { readView } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { LiveRefresh } from "@/components/live/live-refresh";
import { LinkTable } from "@/components/page/collections";
import { PaymentSteps } from "@/components/engagement/payment-steps";
import { PageTitle, pickView, RegionError, ViewSwitcher } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { EmptyStateLink } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { personalChannel } from "@/lib/live/topics";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.money.invoices") };
}

/**
 * Money, Invoices (Section 4.4.5): every invoice across orgs as a table or payment trackers. The
 * list updates live as orgs approve and pay invoices, through the person's private channel.
 */
export default async function InvoicesPage({ searchParams }: PageProps<"/money/invoices">) {
  const ctx = await requireNode("money.invoices");
  const query = await searchParams;
  const views = getNode(sitemap, "money.invoices").node.list?.views ?? ["table"];
  const view = pickView(query["view"], views, "table");
  const [t, locale, invoices] = await Promise.all([
    getTranslate(),
    getLocale(),
    readView(ctx.db, "invoices", {
      order: ["issued_on", "desc"],
      ...(ctx.brand.kind === "org" ? { eq: { org_id: ctx.brand.org.orgId } } : {}),
    }),
  ]);
  const lines =
    invoices.ok && view === "list"
      ? await readView(ctx.db, "invoice_lines", {
          in: ["invoice_id", invoices.data.map((inv) => inv.id ?? "")],
          order: ["line_number", "asc"],
        })
      : null;
  return (
    <>
      <LiveRefresh channel={personalChannel(ctx.personId)} />
      <PageTitle
        title={t("nav.gateway.primary.money")}
        action={<ViewSwitcher views={views} current={view} path="/money/invoices" query={query} />}
      />
      <DestinationTabs ctx={ctx} destination="money" active="money.invoices" t={t} />
      {!invoices.ok ? (
        <RegionError />
      ) : invoices.data.length === 0 ? (
        <EmptyStateLink
          icon="Receipt"
          sentence={t("gateway.money.invoices.empty")}
          actionLabel={t("gateway.money.invoices.emptyAction")}
          href="/work/engagements"
        />
      ) : view === "list" ? (
        <ul className="m-0 flex list-none flex-col gap-12 p-0">
          {invoices.data.map((inv) => (
            <li key={inv.id ?? ""}>
              <PaymentSteps
                invoice={inv}
                lines={lines?.ok ? lines.data.filter((l) => l.invoice_id === inv.id) : []}
                locale={locale}
                t={t}
              />
            </li>
          ))}
        </ul>
      ) : (
        <LinkTable
          caption={t("nav.gateway.money.invoices")}
          columns={[
            { key: "number", label: t("gateway.money.invoices.number"), type: "code" },
            { key: "org", label: t("gateway.work.engagements.org") },
            { key: "project", label: t("gateway.work.engagements.project") },
            { key: "issued", label: t("gateway.money.invoices.issued") },
            { key: "due", label: t("gateway.money.invoices.dueColumn") },
            { key: "total", label: t("gateway.money.invoices.total") },
            { key: "balance", label: t("gateway.money.invoices.balanceColumn") },
            { key: "state", label: t("gateway.work.engagements.state") },
          ]}
          rows={invoices.data.map((inv) => ({
            number: inv.invoice_number ?? "",
            org: inv.org_name ?? "",
            project: inv.project_name ?? "",
            issued: inv.issued_on ? formatDate(locale, inv.issued_on) : "",
            due: inv.due_on ? formatDate(locale, inv.due_on) : "",
            total:
              formatMoney(locale, inv.total_minor, inv.currency_code) ??
              t("gateway.common.unpriced"),
            balance:
              formatMoney(locale, inv.balance_minor, inv.currency_code) ??
              t("gateway.common.unpriced"),
            state: inv.invoice_state ? t(enumLabelKey("invoiceState", inv.invoice_state)) : "",
          }))}
        />
      )}
    </>
  );
}
