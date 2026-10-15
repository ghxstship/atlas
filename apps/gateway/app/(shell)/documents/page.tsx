import { listEngagementDocuments, listMyEngagements, listTaxForms, readView } from "@xos/data/gateway";
import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { LinkTable } from "@/components/page/collections";
import { RowList } from "@/components/engagement/rows";
import { PageTitle, pickView, RegionError, Section, ViewSwitcher } from "@/components/page/page";
import { EmptyStateLink, InlineAlert } from "@/components/ui";
import { signDocumentAction } from "@/lib/actions/engagement";
import { inBrandScope } from "@/lib/brand/brand";
import { formatDate, isoDaysFromToday, todayIso } from "@/lib/format";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.avatar.documents") };
}

/**
 * Documents (Section 4.5.8 avatar menu): a vault of contracts, onboarding and compliance documents
 * across orgs, with expiry. Documents to sign come first and carry Sign inline; documents that
 * expire within 30 days are called out.
 */
export default async function DocumentsPage({ searchParams }: PageProps<"/documents">) {
  const ctx = await requireNode("documents");
  const query = await searchParams;
  const views = getNode(sitemap, "documents").node.list?.views ?? ["table"];
  const view = pickView(query["view"], views, "table");
  const [t, locale, engagements, documents, signedByLink, taxForms] = await Promise.all([
    getTranslate(),
    getLocale(),
    listMyEngagements(ctx.db),
    listEngagementDocuments(ctx.db),
    readView(ctx.db, "my_token_documents", {}),
    listTaxForms(ctx.db),
  ]);
  if (!engagements.ok || !documents.ok || !signedByLink.ok || !taxForms.ok) {
    return (
      <>
        <PageTitle title={t("nav.gateway.avatar.documents")} />
        <RegionError />
      </>
    );
  }
  const byId = new Map(engagements.data.map((e) => [e.id, e]));
  const today = todayIso();
  const soon = isoDaysFromToday(30);
  const docs = documents.data
    .map((d) => ({ d, e: byId.get(d.engagementId) }))
    .filter(({ e }) => e && inBrandScope(ctx.brand, e.orgId))
    .sort((a, b) => Number(b.d.state === "Sent") - Number(a.d.state === "Sent") || (a.d.expiresOn ?? "9999").localeCompare(b.d.expiresOn ?? "9999"));
  const expiring = docs.filter(({ d }) => d.expiresOn && d.expiresOn >= today && d.expiresOn <= soon);
  const empty = docs.length === 0 && signedByLink.data.length === 0 && taxForms.data.length === 0;
  return (
    <>
      <PageTitle title={t("nav.gateway.avatar.documents")} lead={t("gateway.documents.lead")} action={<ViewSwitcher views={views} current={view} path="/documents" query={query} />} />
      {expiring.length > 0 ? <InlineAlert tone="warning">{t("gateway.documents.expiring", { n: expiring.length })}</InlineAlert> : null}
      {empty ? (
        <EmptyStateLink icon="FolderLock" sentence={t("gateway.documents.empty")} actionLabel={t("gateway.documents.emptyAction")} href="/work/engagements" />
      ) : view === "table" ? (
        <LinkTable
          caption={t("nav.gateway.avatar.documents")}
          columns={[
            { key: "title", label: t("gateway.documents.title") },
            { key: "kind", label: t("gateway.documents.kind") },
            { key: "org", label: t("gateway.work.engagements.org") },
            { key: "expires", label: t("gateway.documents.expires") },
            { key: "state", label: t("gateway.work.engagements.state") },
          ]}
          rows={docs.map(({ d, e }) => ({
            href: e ? `/work/engagements/${e.key}/documents` : "/documents",
            title: d.title,
            kind: t(enumLabelKey("engagementDocumentKind", d.kind)),
            org: e?.orgName ?? "",
            expires: d.expiresOn ? formatDate(locale, d.expiresOn) : "",
            state: t(enumLabelKey("engagementDocumentState", d.state)),
          }))}
        />
      ) : (
        <RowList
          label={t("nav.gateway.avatar.documents")}
          items={docs.map(({ d, e }) => ({
            id: d.id,
            title: d.title,
            meta: [t(enumLabelKey("engagementDocumentKind", d.kind)), e?.orgName, d.expiresOn ? t("gateway.engagement.documents.expires", { date: formatDate(locale, d.expiresOn) }) : null],
            tag: { label: t(enumLabelKey("engagementDocumentState", d.state)), tone: toneFor(d.state) },
            ...(e ? { href: `/work/engagements/${e.key}/documents` } : {}),
            ...(d.state === "Sent"
              ? { action: <ActionButton action={signDocumentAction.bind(null, d.id)} label={t("gateway.common.sign")} variant="primary" done={t("gateway.common.signed")} /> }
              : {}),
          }))}
        />
      )}
      {signedByLink.data.length > 0 ? (
        <Section title={t("gateway.documents.signedByLink")}>
          <RowList
            label={t("gateway.documents.signedByLink")}
            items={signedByLink.data.map((d) => ({
              id: d.engagement_document_id ?? "",
              title: d.title ?? "",
              meta: [d.org_name, d.signed_at ? t("gateway.documents.signedOn", { date: formatDate(locale, d.signed_at), name: d.signer_name ?? "" }) : null],
              ...(d.engagement_document_state ? { tag: { label: t(enumLabelKey("engagementDocumentState", d.engagement_document_state)), tone: toneFor(d.engagement_document_state) } } : {}),
            }))}
          />
        </Section>
      ) : null}
      {taxForms.data.length > 0 ? (
        <Section title={t("gateway.documents.tax")}>
          <RowList
            label={t("gateway.documents.tax")}
            items={taxForms.data.map((f) => ({
              id: f.id,
              title: t(enumLabelKey("taxFormKind", f.kind)),
              meta: [f.orgName, t("gateway.money.tax.last4", { last4: f.tinLast4 }), formatDate(locale, f.signedAt)],
              href: "/money/tax-documents",
            }))}
          />
        </Section>
      ) : null}
    </>
  );
}
