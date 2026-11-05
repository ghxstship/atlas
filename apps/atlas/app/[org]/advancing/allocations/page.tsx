import { getNode } from "@xos/ia";
import { AllocationsCollection } from "@/components/advancing/allocations";
import { advancingPage } from "@/components/advancing/context";
import { flatSearch } from "@/components/advancing/shared";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/** Advancing > Allocations (R7, ADR 0104): what each party and person is given for the org's productions. */
export default async function AllocationsPage({
  params,
  searchParams,
}: PageProps<"/[org]/advancing/allocations">) {
  const routeParams = await params;
  const search = flatSearch(await searchParams);
  const actx = await advancingPage("advancing.allocations", routeParams, search["project"]);
  const t = await getTranslate();
  return (
    <AllocationsCollection
      actx={actx}
      path={`/${routeParams.org}/advancing/allocations`}
      search={search}
      title={t(getNode(sitemap, "advancing.allocations").node.label)}
    />
  );
}
