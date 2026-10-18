import { requireNode } from "@/lib/shell/require-node";
import { OccupancySection } from "@/components/workforce/occupancy";
import { nodeHref } from "@/lib/shell/sitemap";

/** Site Operations > Occupancy (Section 4.9 live occupancy counter). */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/site-ops/occupancy">) {
  const routeParams = await params;
  const ctx = await requireNode("site-ops.occupancy", routeParams);
  return (
    <OccupancySection
      ctx={ctx}
      path={nodeHref("site-ops.occupancy", routeParams) ?? "/"}
      search={await searchParams}
    />
  );
}
