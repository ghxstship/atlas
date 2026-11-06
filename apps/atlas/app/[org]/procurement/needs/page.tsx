import { LiveList } from "@/components/live/live-list";
import { NeedsSection } from "@/components/procurement/needs";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref } from "@/lib/shell/sitemap";

/** Procurement > Needs (B11, G-180): what every event of the org will get, across events. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/procurement/needs">) {
  const routeParams = await params;
  const ctx = await requireNode("procurement.needs", routeParams);
  return (
    <>
      <LiveList org={routeParams.org} tables={["procurement_needs"]} />
      <NeedsSection
        ctx={ctx}
        path={nodeHref("procurement.needs", routeParams) ?? "/"}
        search={await searchParams}
      />
    </>
  );
}
