import { listW9Addresses } from "@xos/data/form-1099";
import { listPayoutAccounts, listTaxForms } from "@xos/data/gateway";
import { formatPostalAddress } from "@xos/i18n/formats";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { LinkTable } from "@/components/page/collections";
import { RowList } from "@/components/engagement/rows";
import { TaxAddressForm, type TaxAddressCopy } from "@/components/forms/tax-address-form";
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
  const [t, locale, forms, payouts, w9s] = await Promise.all([
    getTranslate(),
    getLocale(),
    listTaxForms(ctx.db),
    listPayoutAccounts(ctx.db),
    listW9Addresses(ctx.db),
  ]);
  const addressCopy: TaxAddressCopy = {
    title: t("payouts.w9.formTitle"),
    legalName: t("payouts.w9.legalName"),
    legalNameHelp: t("payouts.w9.legalNameHelp"),
    street: t("payouts.w9.street"),
    locality: t("payouts.w9.locality"),
    region: t("payouts.w9.region"),
    postal: t("payouts.w9.postal"),
    submit: t("payouts.w9.submit"),
    done: t("payouts.w9.done"),
    errors: {
      legalName: t("payouts.w9.errors.legalName"),
      streetAddress: t("payouts.w9.errors.streetAddress"),
      locality: t("payouts.w9.errors.locality"),
      regionCode: t("payouts.w9.errors.regionCode"),
      postalCode: t("payouts.w9.errors.postalCode"),
    },
  };
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
      {w9s.ok && w9s.data.length > 0 ? (
        <Section title={t("payouts.w9.title")}>
          <p className="m-0 text-text-13 text-text-secondary">{t("payouts.w9.body")}</p>
          <ul className="m-0 flex list-none flex-col gap-16 p-0">
            {w9s.data.map((w) => (
              <li
                key={w.taxFormId}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-16"
              >
                <strong className="font-semibold">
                  {t("payouts.w9.formFor", { org: w.orgName, last4: w.tinLast4 })}
                </strong>
                {w.complete ? (
                  // A W-9 address is a US address, in the US postal format (Section 15).
                  <p className="m-0 whitespace-pre-line text-text-13 text-text-secondary">
                    {formatPostalAddress(
                      {
                        country: "US",
                        addressLines: [w.streetAddress],
                        locality: w.locality,
                        administrativeArea: w.regionCode,
                        postalCode: w.postalCode,
                      },
                      { locale },
                    ).join("\n")}
                  </p>
                ) : (
                  <p className="m-0 text-text-13 text-warning-text">{t("payouts.w9.missing")}</p>
                )}
                <details open={!w.complete}>
                  <summary className="cursor-pointer text-text-13 text-accent-text">
                    {w.complete ? t("payouts.w9.edit") : t("payouts.w9.add")}
                  </summary>
                  <div className="pt-8">
                    <TaxAddressForm taxFormId={w.taxFormId} copy={addressCopy} initial={w} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Section>
      ) : !w9s.ok ? (
        <RegionError />
      ) : null}
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
