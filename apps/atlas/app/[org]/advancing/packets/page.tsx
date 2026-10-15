import { getNode } from "@xos/ia";
import { advancingPage } from "@/components/advancing/context";
import { PacketsCollection } from "@/components/advancing/packets";
import { flatSearch } from "@/components/advancing/shared";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/** Advancing > Packets (Section 4.5.5): every packet across projects, with a project filter. */
export default async function PacketsPage({
  params,
  searchParams,
}: PageProps<"/[org]/advancing/packets">) {
  const routeParams = await params;
  const search = flatSearch(await searchParams);
  const actx = await advancingPage("advancing.packets", routeParams, search["project"]);
  const t = await getTranslate();
  return (
    <PacketsCollection
      actx={actx}
      path={`/${routeParams.org}/advancing/packets`}
      search={search}
      title={t(getNode(sitemap, "advancing.packets").node.label)}
    />
  );
}
