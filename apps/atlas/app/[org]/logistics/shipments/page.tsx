import { ShipmentsSection } from "@/components/logistics-hospitality/shipments";
import { moduleScope } from "@/components/logistics-hospitality/kit";
import { nodeHref } from "@/lib/shell/sitemap";
import { LiveList } from "@/components/live/live-list";

/** Logistics > Shipments (Section 4.5.5): every project's shipments, with the project filter. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/logistics/shipments">) {
  const routeParams = await params;
  const scope = await moduleScope("logistics.shipments", routeParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["shipments"]} />
      <ShipmentsSection
        scope={scope}
        search={await searchParams}
        base={nodeHref("logistics.shipments", routeParams) ?? "/"}
      />
    </>
  );
}
