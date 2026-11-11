import { getTranslations } from "next-intl/server";
import { BeosSection } from "@/components/logistics-hospitality/beos";
import { BlocksSection } from "@/components/logistics-hospitality/blocks";
import { SectionSwitcher } from "@/components/logistics-hospitality/client";
import { FulfillmentsSection } from "@/components/logistics-hospitality/fulfillments";
import { param, projectTabScope } from "@/components/logistics-hospitality/kit";
import { RoomingSection } from "@/components/logistics-hospitality/rooming-section";
import { SpaceBookingsSection } from "@/components/logistics-hospitality/space-bookings";
import { TransfersSection } from "@/components/logistics-hospitality/transfers";
import { TravelGridSection } from "@/components/logistics-hospitality/travel-grid";
import { nodeHref } from "@/lib/shell/sitemap";

const SECTIONS = [
  "fulfillments",
  "beos",
  "blocks",
  "travel",
  "transfers",
  "rooms",
  "rooming",
] as const;
type HospitalitySection = (typeof SECTIONS)[number];

/**
 * The project Hospitality tab (Section 4.5.4): lodging, catering, travel and amenities, BEOs,
 * accommodation blocks, the flight grid, transfers, green rooms and the rooming list of the project, with the same
 * sections as the org-level pages (B5 adds the last four).
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
  if (section === "travel") {
    return <TravelGridSection scope={scope} search={search} base={base} heading={heading} />;
  }
  if (section === "transfers") {
    return <TransfersSection scope={scope} search={search} base={base} heading={heading} />;
  }
  if (section === "rooms") {
    return <SpaceBookingsSection scope={scope} search={search} base={base} heading={heading} />;
  }
  if (section === "rooming") {
    return <RoomingSection scope={scope} heading={heading} />;
  }
  return <FulfillmentsSection scope={scope} search={search} base={base} heading={heading} />;
}
