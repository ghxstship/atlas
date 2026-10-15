import { getTranslations } from "next-intl/server";
import { BeosSection } from "@/components/logistics-hospitality/beos";
import { BlocksSection } from "@/components/logistics-hospitality/blocks";
import { SectionSwitcher } from "@/components/logistics-hospitality/client";
import { FulfillmentsSection } from "@/components/logistics-hospitality/fulfillments";
import { param, projectTabScope } from "@/components/logistics-hospitality/kit";
import { nodeHref } from "@/lib/shell/sitemap";

const SECTIONS = ["fulfillments", "beos", "blocks"] as const;
type HospitalitySection = (typeof SECTIONS)[number];

/**
 * The project Hospitality tab (Section 4.5.4): lodging, catering, travel and amenities, BEOs and
 * accommodation blocks of the project, with the same sections as the org-level pages.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/hospitality">) {
  const routeParams = await params;
  const search = await searchParams;
  const scope = await projectTabScope("project.hospitality", routeParams);
  const t = await getTranslations("hospitality.projectTab");
  const asked = param(search, "section");
  const section: HospitalitySection = (SECTIONS as readonly string[]).includes(asked ?? "")
    ? (asked as HospitalitySection)
    : "fulfillments";
  const base = nodeHref("project.hospitality", routeParams) ?? "/";
  const heading = (
    <SectionSwitcher
      label={t("sections")}
      param="section"
      current={section}
      options={SECTIONS.map((s) => ({ value: s, label: t(s) }))}
    />
  );
  if (section === "beos") {
    return <BeosSection scope={scope} search={search} base={base} heading={heading} />;
  }
  if (section === "blocks") {
    return <BlocksSection scope={scope} search={search} base={base} heading={heading} />;
  }
  return <FulfillmentsSection scope={scope} search={search} base={base} heading={heading} />;
}
