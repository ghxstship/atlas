import { getNode } from "@xos/ia";
import { advancingPage } from "@/components/advancing/context";
import { RidersCollection } from "@/components/advancing/riders";
import { flatSearch } from "@/components/advancing/shared";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/** Advancing > Riders (Section 4.5.5): riders and their fulfillment across projects. */
export default async function RidersPage({
  params,
  searchParams,
}: PageProps<"/[org]/advancing/riders">) {
  const routeParams = await params;
  const search = flatSearch(await searchParams);
  const actx = await advancingPage("advancing.riders", routeParams, search["project"]);
  const t = await getTranslate();
  return (
    <RidersCollection
      actx={actx}
      path={`/${routeParams.org}/advancing/riders`}
      search={search}
      title={t(getNode(sitemap, "advancing.riders").node.label)}
    />
  );
}
