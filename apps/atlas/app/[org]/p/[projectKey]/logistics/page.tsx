import { getTranslations } from "next-intl/server";
import { SectionSwitcher } from "@/components/logistics-hospitality/client";
import { DockSection } from "@/components/logistics-hospitality/dock";
import { param, projectTabScope } from "@/components/logistics-hospitality/kit";
import { ShipmentsSection } from "@/components/logistics-hospitality/shipments";
import { YardSection } from "@/components/logistics-hospitality/yard";
import { nodeHref } from "@/lib/shell/sitemap";

const SECTIONS = ["shipments", "dock", "yard"] as const;
type LogisticsSection = (typeof SECTIONS)[number];

/**
 * The project Logistics tab (Section 4.5.4): the project's shipments, dock slots and marshalling yard
 * log, using the same sections as the org-level pages with the project filter applied.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/logistics">) {
  const routeParams = await params;
  const search = await searchParams;
  const scope = await projectTabScope("project.logistics", routeParams);
  const t = await getTranslations("logistics.projectTab");
  const asked = param(search, "section");
  const section: LogisticsSection = (SECTIONS as readonly string[]).includes(asked ?? "")
    ? (asked as LogisticsSection)
    : "shipments";
  const base = nodeHref("project.logistics", routeParams) ?? "/";
  const heading = (
    <SectionSwitcher
      label={t("sections")}
      param="section"
      current={section}
      options={SECTIONS.map((s) => ({ value: s, label: t(s) }))}
    />
  );
  if (section === "dock") {
    return <DockSection scope={scope} search={search} base={base} heading={heading} />;
  }
  if (section === "yard") {
    return <YardSection scope={scope} search={search} base={base} heading={heading} />;
  }
  return <ShipmentsSection scope={scope} search={search} base={base} heading={heading} />;
}
