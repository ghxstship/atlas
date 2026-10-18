import { notFound } from "next/navigation";
import { SectionTabs } from "@/components/collection-kit/section-tabs";
import { PurchaseOrdersSection } from "@/components/procurement/purchase-orders";
import { ReceiptsSection } from "@/components/procurement/receipts";
import { RfqsSection } from "@/components/procurement/rfqs";
import { SubmittalsSection } from "@/components/procurement/submittals";
import { requireNode } from "@/lib/shell/require-node";
import { getCopy } from "@/lib/collection-kit/i18n";
import { getProjectContextFor } from "@/lib/projects/context";
import { nodeHref } from "@/lib/shell/sitemap";

const SECTIONS = ["orders", "rfqs", "receipts", "submittals"] as const;
type Section = (typeof SECTIONS)[number];

/**
 * The project Procurement tab (Section 4.5.4): the project's purchase orders, RFQs, receipts and
 * submittals, using the org-level module sections with the project filter applied.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/procurement">) {
  const routeParams = await params;
  const ctx = await requireNode("project.procurement", routeParams);
  const project = await getProjectContextFor(routeParams);
  if (!project) notFound();
  const search = await searchParams;
  const t = await getCopy("procurement.projectTab");
  const asked = typeof search["section"] === "string" ? search["section"] : "";
  const section: Section = (SECTIONS as readonly string[]).includes(asked)
    ? (asked as Section)
    : "orders";
  const path = nodeHref("project.procurement", routeParams) ?? "/";
  const props = { ctx, path, search, projectId: project.project.id };
  return (
    <div className="flex flex-col gap-12">
      <SectionTabs
        label={t("sections")}
        current={section}
        options={SECTIONS.map((s) => ({ value: s, label: t(s) }))}
      />
      {section === "rfqs" ? (
        <RfqsSection {...props} />
      ) : section === "receipts" ? (
        <ReceiptsSection {...props} />
      ) : section === "submittals" ? (
        <SubmittalsSection {...props} />
      ) : (
        <PurchaseOrdersSection {...props} />
      )}
    </div>
  );
}
